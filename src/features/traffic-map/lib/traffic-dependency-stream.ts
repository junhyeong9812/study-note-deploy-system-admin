/** 의존의 선 — 브라우저 쪽 상태(순수 — 브라우저 조각이 쓴다: 서버 모듈 · 설정 · 클라이언트 · fetch 없음). 통신 지도의 상태(traffic-map-stream-state)와 따로 접는다.
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 몸은 구현 워커가 채운다.
 * - dependencies: 깨진 사건(JSON 아님 · 칸 빠짐 · 형이 다름 · 닫힌 표 밖의 짝 · 모르는 상태 · 까닭)은 버리고 brokenEvents 를 센다(앞의 값 그대로) ·
 *   sequence 가 마지막 것보다 작거나 같으면 버린다 · 받아들이면 shown 을 간다. 모르는 칸은 버린다(사건에 `detail` 이 실려 와도 상태에 남지 않는다).
 * - open: lastSequence 를 비운다(다시 붙으면 전체를 새로 받는다).
 * - 낡음(isDependencyStale): shown 이 있고, 연결이 끊김 · 다시 붙음(새 값 전) · 세션 끝이거나 지금 - checkedAt 이 DEPENDENCY_STALE_MILLISECONDS 를 넘으면. */
import type { TrafficDependencyEvent } from "@/features/traffic-map/lib/traffic-dependency-hub";
import type { TrafficStreamConnection } from "@/features/traffic-map/lib/traffic-map-stream-state";

export interface TrafficDependencyStreamState {
  shown: TrafficDependencyEvent | null;
  lastSequence: number | null;
  brokenEvents: number;
}

export type TrafficDependencyStreamAction = { type: "open" } | { type: "dependencies"; data: string };

export function initialTrafficDependencyStreamState(_initial: TrafficDependencyEvent | null): TrafficDependencyStreamState {
  throw new Error("not implemented: initialTrafficDependencyStreamState");
}

/** 사건의 data — 꼴이 틀리면 null. */
export function parseTrafficDependencyEvent(_data: string): TrafficDependencyEvent | null {
  throw new Error("not implemented: parseTrafficDependencyEvent");
}

export function reduceTrafficDependencyStream(_state: TrafficDependencyStreamState, _action: TrafficDependencyStreamAction): TrafficDependencyStreamState {
  throw new Error("not implemented: reduceTrafficDependencyStream");
}

export function isDependencyStale(_state: TrafficDependencyStreamState, _connection: TrafficStreamConnection, _nowMilliseconds: number): boolean {
  throw new Error("not implemented: isDependencyStale");
}
