/** 통신 지도의 브라우저 쪽 상태(순수) — 뼈대(T8 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * EventSource 의 사건(open · map · error · session)을 화면 상태로 접는다 + EventSource 를 잇고 끊는 함수(EventSource 는 주입).
 * - map: 깨진 사건(JSON 아님 · 칸 빠짐 · 형이 다름)은 버리고 brokenEvents 를 센다(앞의 값을 그대로) · sequence 가 마지막 것보다 작거나 같으면 버린다
 *   (같은 사건 두 번 · 늦게 온 옛 사건) · 성공한 지도는 shown 을 갈고 failure 를 지운다 · 실패는 failure 에만(shown 은 그대로 — 낡은 값으로 표시).
 *   진도 · 채움의 값은 사건에 실린 그대로 쓴다(앞의 사건보다 덜 채워져도 — 진도는 뒤로 갈 수 있다).
 * - open: connection "open" · lastSequence 를 비운다(다시 붙으면 전체를 새로 받는다 — 서버가 다시 떴으면 sequence 가 작아진다).
 * - error: "reconnecting"(세션이 끝난 뒤는 그대로). session: "session_ended"(다시 붙지 않는다). */
import type { Scheduler } from "@/features/auth/lib/replay-scheduler";
import type { TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";
import type { UpstreamFailure } from "@/shared/lib/upstream-result";

/** EventSource 가 닫힌(CLOSED — 서버가 200 이 아닌 답을 줬을 때 등) 뒤 새로 여는 간격. */
export const TRAFFIC_STREAM_RECONNECT_MILLISECONDS = 5_000;
export const TRAFFIC_STREAM_PATH = "/api/traffic/stream";

export type TrafficStreamConnection = "connecting" | "open" | "reconnecting" | "session_ended";

export interface TrafficMapStreamState {
  connection: TrafficStreamConnection;
  /** 화면이 그리는 지도 — 마지막으로 받은 성공한 사건 */
  shown: TrafficMapEvent | null;
  /** 마지막으로 받은 사건이 실패였으면 그 실패 */
  failure: UpstreamFailure | null;
  lastSequence: number | null;
  /** 마지막으로 받아들인 사건의 fetchedAt */
  lastReceivedAt: string | null;
  brokenEvents: number;
}

export type TrafficMapStreamAction =
  | { type: "open" }
  | { type: "map"; data: string }
  | { type: "error" }
  | { type: "session" };

export function initialTrafficMapStreamState(initial: TrafficMapEvent | null): TrafficMapStreamState {
  void initial;
  throw new Error("T8: 구현 전");
}

/** 사건의 data — 꼴이 틀리면 null. */
export function parseTrafficMapEvent(data: string): TrafficMapEvent | null {
  void data;
  throw new Error("T8: 구현 전");
}

export function reduceTrafficMapStream(state: TrafficMapStreamState, action: TrafficMapStreamAction): TrafficMapStreamState {
  void state; void action;
  throw new Error("T8: 구현 전");
}

/** 브라우저의 EventSource 가운데 쓰는 것만. readyState: 0 CONNECTING · 1 OPEN · 2 CLOSED. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export interface TrafficMapStreamConnectOptions {
  url: string;
  createEventSource: (url: string) => EventSourceLike;
  dispatch: (action: TrafficMapStreamAction) => void;
  scheduler: Scheduler;
}

/** 잇는다 — 돌려주는 함수를 부르면 닫고 다시 여는 타이머를 거둔다(그 뒤로는 dispatch 하지 않는다). */
export function connectTrafficMapStream(options: TrafficMapStreamConnectOptions): () => void {
  void options;
  throw new Error("T8: 구현 전");
}
