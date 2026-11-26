/** 통신 지도의 공유 조회(순수 — 시계 · 타이머 · 조회는 주입) — 뼈대(T8 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * 한 프로세스에 하나: 기간(range)마다 관측 서버를 **주기(30초)당 한 번만** 부르고, 받은 지도를 그 기간을 보는 모든 연결에 나눠 준다
 * (여러 탭 · 여러 사람이 열어도 관측 서버의 조회는 늘지 않는다 — T6 의 24시간 지도가 무거울 수 있다).
 * - subscribe: 그 기간의 조회가 돌고 있으면 마지막 사건을 곧바로 준다 · 돌고 있지 않으면 마지막 사건이 30초 안의 것이면 곧바로 주고 남은 시간 뒤에,
 *   아니면 곧바로 부른다. 다음 조회는 앞의 조회가 **끝난 뒤** 30초(겹쳐 부르지 않는다). 마지막 구독이 떠나면 걸린 타이머를 거둔다.
 * - snapshot: 화면의 첫 그림용 — 30초 안의 마지막 사건이 있으면 그것, 진행 중인 조회가 있으면 그 결과(새로 부르지 않는다), 아니면 한 번 부른다(주기를 걸지 않는다).
 * - sequence 는 허브 전체에서 조회가 끝날 때마다 하나씩 는다(기간과 무관 · clear 로도 되돌리지 않는다). load 가 던지면 unreachable. */
import type { Scheduler } from "@/features/auth/lib/replay-scheduler";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import type { TrafficMapView } from "@/features/traffic-map/lib/traffic-map-view";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

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
}

export interface TrafficMapHubOptions {
  load: (range: TrafficMapRange) => Promise<UpstreamResult<TrafficMapView>>;
  scheduler: Scheduler;
  now: () => number;
}

export function createTrafficMapHub(options: TrafficMapHubOptions): TrafficMapHub {
  void options;
  throw new Error("T8: 구현 전");
}
