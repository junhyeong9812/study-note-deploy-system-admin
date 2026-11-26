/** 통신 지도의 공유 조회(순수 — 시계 · 타이머 · 조회는 주입).
 * 한 프로세스에 하나: 기간(range)마다 관측 서버를 **주기(30초)당 한 번만** 부르고, 받은 지도를 그 기간을 보는 모든 연결에 나눠 준다
 * (여러 탭 · 여러 사람이 열어도 관측 서버의 조회는 늘지 않는다 — T6 의 24시간 지도가 무거울 수 있다).
 * - subscribe: 그 기간의 조회가 돌고 있으면 마지막 사건을 곧바로 준다 · 돌고 있지 않으면 마지막 사건이 30초 안의 것이면 곧바로 주고 남은 시간 뒤에,
 *   아니면 곧바로 부른다. 다음 조회는 앞의 조회가 **끝난 뒤** 30초(겹쳐 부르지 않는다). 마지막 구독이 떠나면 걸린 타이머를 거둔다.
 * - snapshot: 화면의 첫 그림용 — 30초 안의 마지막 사건이 있으면 그것, 진행 중인 조회가 있으면 그 결과(새로 부르지 않는다), 아니면 한 번 부른다(주기를 걸지 않는다).
 * - sequence 는 허브 전체에서 조회가 끝날 때마다 하나씩 는다(기간과 무관 · clear 로도 되돌리지 않는다). load 가 던지면 unreachable. */
import type { Scheduler, ScheduledTask } from "@/features/auth/lib/replay-scheduler";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import type { TrafficMapView } from "@/features/traffic-map/lib/traffic-map-view";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const TRAFFIC_MAP_POLL_MILLISECONDS = 30_000;

/** 연결에 보내는 사건 하나(SSE `event: map` 의 data). */
export interface TrafficMapEvent {
  /** 허브 전체에서 는다 — 화면은 이보다 작거나 같은 사건을 버린다(다시 붙은 뒤에는 처음부터) */
  sequence: number;
  /** 조회가 끝난 시각(ISO) */
  fetchedAt: string;
  range: TrafficMapRange;
  map: UpstreamResult<TrafficMapView>;
}

export type TrafficMapListener = (event: TrafficMapEvent) => void;

export interface TrafficMapHub {
  /** 돌려주는 함수를 부르면 떠난다(두 번 불러도 한 번) */
  subscribe(range: TrafficMapRange, listener: TrafficMapListener): () => void;
  snapshot(range: TrafficMapRange): Promise<TrafficMapEvent>;
  /** 마지막 사건들을 잊는다(다음 조회가 관측 서버를 새로 부른다) */
  clear(): void;
  /** 멈춘다(프로세스가 끝날 때 — T8 리뷰 1): 걸린 타이머를 모두 거두고, 그 뒤로는 관측 서버를 부르지 않는다
   * (도는 조회가 끝나도 보내지 · 다시 걸지 않는다 · subscribe 는 아무것도 하지 않는 떠나기를 돌려준다 · snapshot 은 부르지 않고 unavailable 사건). 두 번 불러도 같다. */
  stop(): void;
}

export interface TrafficMapHubOptions {
  load: (range: TrafficMapRange) => Promise<UpstreamResult<TrafficMapView>>;
  scheduler: Scheduler;
  now: () => number;
}

/** 기간 하나의 상태. */
interface RangeState {
  listeners: Set<TrafficMapListener>;
  last: TrafficMapEvent | null;
  /** 끝난 시각(밀리초) — last 가 30초 안의 것인지 */
  lastAt: number;
  inFlight: Promise<TrafficMapEvent> | null;
  timer: ScheduledTask | null;
}

export function createTrafficMapHub(options: TrafficMapHubOptions): TrafficMapHub {
  const states = new Map<TrafficMapRange, RangeState>();
  let sequence = 0;
  let stopped = false;

  function stateOf(range: TrafficMapRange): RangeState {
    let state = states.get(range);
    if (state === undefined) {
      state = { listeners: new Set(), last: null, lastAt: 0, inFlight: null, timer: null };
      states.set(range, state);
    }
    return state;
  }

  function fresh(state: RangeState): boolean {
    return state.last !== null && options.now() - state.lastAt < TRAFFIC_MAP_POLL_MILLISECONDS;
  }

  function schedule(range: TrafficMapRange, state: RangeState, milliseconds: number) {
    if (stopped || state.timer !== null || state.listeners.size === 0) return;
    state.timer = options.scheduler(() => {
      state.timer = null;
      if (state.listeners.size > 0 && state.inFlight === null) void load(range, state);
    }, milliseconds);
  }

  /** 관측 서버를 한 번 부른다 — 시작할 때 걸린 타이머를 거둔다(기간마다 "걸린 타이머 또는 도는 조회"는 늘 하나 — 늦게 터진 옛 타이머가 곧바로 또 부르지 않게).
   * 끝나면 그때의 구독 모두에 보내고, 구독이 남아 있으면 30초 뒤 다음을 건다(끝난 뒤에 걸어 겹치지 않는다). 멈춘 뒤에 끝나면 보내지도 걸지도 않는다. */
  function load(range: TrafficMapRange, state: RangeState): Promise<TrafficMapEvent> {
    state.timer?.cancel();
    state.timer = null;
    const pending = (async () => {
      let map: UpstreamResult<TrafficMapView>;
      try {
        map = await options.load(range);
      } catch {
        map = upstreamFailure("unreachable");
      }
      sequence += 1;
      const finishedAt = options.now();
      const event: TrafficMapEvent = { sequence, fetchedAt: new Date(finishedAt).toISOString(), range, map };
      state.last = event;
      state.lastAt = finishedAt;
      state.inFlight = null;
      if (stopped) return event;
      for (const listener of [...state.listeners]) listener(event);
      schedule(range, state, TRAFFIC_MAP_POLL_MILLISECONDS);
      return event;
    })();
    state.inFlight = pending;
    return pending;
  }

  return {
    subscribe(range, listener) {
      if (stopped) return () => {};
      const state = stateOf(range);
      state.listeners.add(listener);
      if (state.inFlight === null) {
        if (fresh(state)) {
          listener(state.last!);
          schedule(range, state, TRAFFIC_MAP_POLL_MILLISECONDS - (options.now() - state.lastAt));
        } else {
          void load(range, state);
        }
      }
      let left = false;
      return () => {
        if (left) return;
        left = true;
        state.listeners.delete(listener);
        if (state.listeners.size === 0 && state.timer !== null) {
          state.timer.cancel();
          state.timer = null;
        }
      };
    },
    async snapshot(range) {
      if (stopped) return { sequence, fetchedAt: new Date(options.now()).toISOString(), range, map: upstreamFailure("unavailable") };
      const state = stateOf(range);
      if (state.inFlight !== null) return state.inFlight;
      if (fresh(state)) return state.last!;
      return load(range, state);
    },
    clear() {
      for (const state of states.values()) {
        state.last = null;
        state.lastAt = 0;
      }
    },
    stop() {
      stopped = true;
      for (const state of states.values()) {
        state.timer?.cancel();
        state.timer = null;
        state.listeners.clear();
      }
    },
  };
}
