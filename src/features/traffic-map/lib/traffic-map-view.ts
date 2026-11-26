/** 통신 지도의 화면 모델(순수) — 뼈대(T8 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * 관측 서버의 지도(TrafficMapSnapshot) → 마디(서비스 이름) · 선(부른 쪽 → 받는 쪽, 갈래마다) · 서버의 수신 상태 · 모름의 표시.
 * 모름과 0 을 가른다: 채워진 칸이 0 이고 채우는 중인 칸만 있으면 "아직 모름", 채우는 중인 칸이 있으면 "덜 들어왔을 수 있음". */
import type { TrafficMapEdge, TrafficMapServer, TrafficMapSnapshot, TrafficQuantile } from "@/features/traffic-map/lib/traffic-map-client";

/** 화면에 그리는 선의 상한 — 넘으면 요청이 많은 것부터(채워짐 + 채우는 중). */
export const TRAFFIC_MAP_EDGE_LIMIT = 200;
/** 규약 2.2 의 이름(보내는 쪽 여덟 + edge · outside) — 이 밖의 이름은 "목록 밖"으로 표시한다. */
export const KNOWN_TRAFFIC_NAMES: readonly string[] = ["front", "backend", "llm-wrapper", "alert", "observe", "admin", "ci-master", "ci-agent", "edge", "outside"];

export type EdgeCompleteness = "settled" | "filling" | "unknown";

export interface TrafficMapEdgeView extends TrafficMapEdge {
  callerKnown: boolean;
  serviceKnown: boolean;
  /** settled = 채우는 중인 칸 없음 · filling = 채워진 수 + 채우는 중 · unknown = 채워진 칸이 0 이고 채우는 중만 */
  completeness: EdgeCompleteness;
}

export interface TrafficMapServerView extends TrafficMapServer {
  /** 수신 지연이거나 읽기 진도가 없다 — 이 서버가 받은 요청은 지도에 덜 들어왔을 수 있다 */
  behind: boolean;
}

export interface TrafficMapView {
  from: string;
  to: string;
  /** 이름(주소 꼴은 가림)순 — 관측 서버의 차례 */
  servers: TrafficMapServerView[];
  /** 관측 서버의 차례(service · caller · class), 상한 안의 것만 */
  edges: TrafficMapEdgeView[];
  edgeTotal: number;
  edgesTruncated: boolean;
  /** 그림의 마디 — 아는 이름은 KNOWN_TRAFFIC_NAMES 차례, 목록 밖 이름은 그 뒤 글자순 */
  nodes: string[];
  /** behind 인 서버 */
  delayedServers: string[];
  /** 잃은 순번(sequence_gaps — 확정된 잃음과 기다리는 중을 관측 서버가 가르지 않는다)이 있는 서버 */
  gapServers: { server: string; sequenceGaps: number }[];
  /** 채우는 중인 선이 하나라도 있다 */
  hasFilling: boolean;
}

export function buildTrafficMapView(snapshot: TrafficMapSnapshot): TrafficMapView {
  void snapshot;
  throw new Error("T8: 구현 전");
}

/** "≤ 250ms" · "≤ 2.5초" · "> 180초" · null 은 "—". */
export function formatQuantile(quantile: TrafficQuantile | null): string {
  void quantile;
  throw new Error("T8: 구현 전");
}

/** 0.125 → "12.5%"(소수 한 자리) · null 은 "—". */
export function formatErrorRate(rate: number | null): string {
  void rate;
  throw new Error("T8: 구현 전");
}

/** settled "12건" · filling "12건 + 채우는 중 3건" · unknown "아직 모름(채우는 중 3건)". */
export function formatEdgeCount(edge: TrafficMapEdgeView): string {
  void edge;
  throw new Error("T8: 구현 전");
}
