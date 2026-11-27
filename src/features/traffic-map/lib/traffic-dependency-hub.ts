/** 의존의 선의 공유 조회(순수 — 시계 · 타이머 · 조회는 주입). 통신 지도의 허브(traffic-map-hub)와 **따로** 돈다 — 한쪽이 붙잡히거나 던져도 다른 쪽의 갱신은 제때 나간다.
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 몸은 구현 워커가 채운다.
 * - 기간과 무관(지금의 상태) — 구독자가 하나라도 있으면 돈다: 첫 구독에 곧바로 한 번(마지막 확인이 30초 안이면 그것을 곧바로 주고 남은 시간 뒤) ·
 *   조회가 **끝난 뒤** TRAFFIC_MAP_POLL_MILLISECONDS(30초)에 다음(겹쳐 부르지 않는다 · 주기당 한 번 — 구독이 여럿이어도) · 마지막 구독이 떠나면 타이머를 거둔다.
 * - load 가 던지면 그 주기의 선은 모두 모름(까닭 unreachable — DEPENDENCY_SOURCES 의 짝마다) · 흐름은 이어진다.
 * - sequence 는 이 허브에서 조회가 끝날 때마다 하나씩 는다. checkedAt = 조회가 끝난 시각(ISO).
 * - snapshot(): 마지막 사건(없으면 null) — 부르지 않는다(화면의 첫 그림이 의존 조회를 기다리지 않게).
 * - stop(): 타이머를 거두고 그 뒤로 부르지 않는다(도는 조회가 끝나도 보내지 · 걸지 않는다). 두 번 불러도 같다. */
import type { Scheduler } from "@/features/auth/lib/replay-scheduler";
import type { DependencyLine } from "@/features/traffic-map/lib/dependency-lines";

/** 흐름의 사건 하나(SSE `event: dependencies` 의 data). */
export interface TrafficDependencyEvent {
  sequence: number;
  checkedAt: string;
  lines: DependencyLine[];
}

export type TrafficDependencyListener = (event: TrafficDependencyEvent) => void;

export interface TrafficDependencyHub {
  subscribe(listener: TrafficDependencyListener): () => void;
  snapshot(): TrafficDependencyEvent | null;
  stop(): void;
}

export interface TrafficDependencyHubOptions {
  load: () => Promise<DependencyLine[]>;
  scheduler: Scheduler;
  now: () => number;
}

export function createTrafficDependencyHub(_options: TrafficDependencyHubOptions): TrafficDependencyHub {
  throw new Error("not implemented: createTrafficDependencyHub");
}
