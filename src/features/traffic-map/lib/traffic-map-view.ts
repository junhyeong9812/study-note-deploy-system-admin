/** 통신 지도의 화면 모델(순수 — 브라우저 조각도 이 파일을 쓴다: 서버 모듈 · 설정 · 클라이언트를 값으로 가져오지 않는다).
 * 관측 서버의 지도(TrafficMapSnapshot) → 마디(서비스 이름) · 선(부른 쪽 → 받는 쪽, 갈래마다) · 서버의 수신 상태 · 모름의 표시.
 * 모름과 0 을 가른다: 채워진 칸이 0 이고 채우는 중인 칸만 있으면 "아직 모름", 채우는 중인 칸이 있으면 "덜 들어왔을 수 있음". */
import { formatDuration } from "@/features/deploys/lib/deploy-format";
import type { TrafficClassName, TrafficMapEdge, TrafficMapServer, TrafficMapSnapshot, TrafficQuantile } from "@/features/traffic-map/lib/traffic-map-client";
import { maskUpstreamReason } from "@/shared/lib/upstream-reason";

/** 화면에 그리는 선의 상한 — 넘으면 요청이 많은 것부터(채워짐 + 채우는 중). */
export const TRAFFIC_MAP_EDGE_LIMIT = 200;
/** 규약 2.2 의 이름(보내는 쪽 여덟 + edge · outside) — 이 밖의 이름은 "목록 밖"으로 표시한다. */
export const KNOWN_TRAFFIC_NAMES: readonly string[] = ["front", "backend", "llm-wrapper", "alert", "observe", "admin", "ci-master", "ci-agent", "edge", "outside"];

/** 이름의 꼴 — 관측 서버가 받는 꼴(observe traffic/TrafficEntry.kt:167-174)과 같다: 서비스 · 부른 쪽(NAME) · 서버(SERVER_NAME) · 읽지 못한 범위(MISSING). */
export const TRAFFIC_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const TRAFFIC_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const TRAFFIC_MISSING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}:[a-z_]{1,32}$/;
export const TRAFFIC_CLASS_NAMES: readonly TrafficClassName[] = ["request", "health", "stream"];

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

function completenessOf(edge: TrafficMapEdge): EdgeCompleteness {
  if (edge.fillingCount === 0) return "settled";
  return edge.count === 0 ? "unknown" : "filling";
}

/** 상한을 넘으면 요청이 많은(채워짐 + 채우는 중) 것부터 — 같은 수면 관측 서버의 차례에서 앞의 것. 남긴 것의 차례는 관측 서버의 것 그대로. */
function edgesWithinLimit(edges: readonly TrafficMapEdge[]): TrafficMapEdge[] {
  if (edges.length <= TRAFFIC_MAP_EDGE_LIMIT) return [...edges];
  const kept = new Set(edges.map((edge, index) => ({ index, total: edge.count + edge.fillingCount }))
    .sort((left, right) => right.total - left.total || left.index - right.index)
    .slice(0, TRAFFIC_MAP_EDGE_LIMIT).map((entry) => entry.index));
  return edges.filter((_edge, index) => kept.has(index));
}

function nodesOf(edges: readonly TrafficMapEdge[]): string[] {
  const names = new Set(edges.flatMap((edge) => [edge.caller, edge.service]));
  const known = KNOWN_TRAFFIC_NAMES.filter((name) => names.has(name));
  const unknown = [...names].filter((name) => !KNOWN_TRAFFIC_NAMES.includes(name)).sort();
  return [...known, ...unknown];
}

/** 관측 서버의 지도 → 화면 모델. 서버 이름 · 읽지 못한 범위 속의 주소 꼴은 가린다(maskUpstreamReason). */
export function buildTrafficMapView(snapshot: TrafficMapSnapshot): TrafficMapView {
  const servers: TrafficMapServerView[] = snapshot.servers.map((server) => ({
    ...server, server: maskUpstreamReason(server.server), missing: server.missing.map(maskUpstreamReason),
    behind: server.receiveDelayed || server.readProgressAt === null,
  }));
  const edges: TrafficMapEdgeView[] = edgesWithinLimit(snapshot.edges).map((edge) => ({
    ...edge, callerKnown: KNOWN_TRAFFIC_NAMES.includes(edge.caller), serviceKnown: KNOWN_TRAFFIC_NAMES.includes(edge.service), completeness: completenessOf(edge),
  }));
  return {
    from: snapshot.from, to: snapshot.to, servers, edges, edgeTotal: snapshot.edges.length, edgesTruncated: snapshot.edges.length > TRAFFIC_MAP_EDGE_LIMIT,
    nodes: nodesOf(edges),
    delayedServers: servers.filter((server) => server.behind).map((server) => server.server),
    gapServers: servers.filter((server) => server.sequenceGaps > 0).map((server) => ({ server: server.server, sequenceGaps: server.sequenceGaps })),
    hasFilling: snapshot.edges.some((edge) => edge.fillingCount > 0),
  };
}

/** 밀리초 → 1초 미만은 "240ms", 그 밖은 formatDuration("4.1초" · "3분 20초"). null 은 "—". */
export function formatMilliseconds(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  return milliseconds < 1000 ? `${milliseconds}ms` : formatDuration(milliseconds);
}

/** "≤ 250ms" · "≤ 2.5초" · "> 180초" · null 은 "—"(칸의 경계 그대로 — 분 단위로 바꾸지 않는다). */
export function formatQuantile(quantile: TrafficQuantile | null): string {
  if (quantile === null) return "—";
  const bound = quantile.milliseconds < 1000 ? `${quantile.milliseconds}ms` : `${quantile.milliseconds / 1000}초`;
  return `${quantile.kind === "at_most" ? "≤" : ">"} ${bound}`;
}

/** 0.125 → "12.5%"(소수 한 자리) · null 은 "—". */
export function formatErrorRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

/** settled "12건" · filling "12건 + 채우는 중 3건" · unknown "아직 모름(채우는 중 3건)". */
export function formatEdgeCount(edge: TrafficMapEdgeView): string {
  switch (edge.completeness) {
    case "settled": return `${edge.count}건`;
    case "filling": return `${edge.count}건 + 채우는 중 ${edge.fillingCount}건`;
    case "unknown": return `아직 모름(채우는 중 ${edge.fillingCount}건)`;
  }
}
