/** 테스트 전용 — 통신 지도(T8) 사례의 가짜 관측 서버 `GET /traffic/map`. 관측 서버의 실제 소스대로 흉내 낸다:
 * - 인증이 먼저(비밀값이 틀리면 401 `unauthorized`) — observe traffic/TrafficController.kt:49-54,98
 * - 기간: 둘 다 없으면 최근 5분 · from 만 없으면 to 앞 5분 · ISO 가 아니면 · 거꾸로면 · 24시간을 넘으면 422 `invalid_request`(정확히 24시간은 받는다)
 *   — TrafficController.kt:72-82,99,222-223(실측: `t7-out/map_24h_plus1ms` 422 · `map_24h` 200 · `map_equal` 200 · `map_future_to` 200)
 * - 답: `{from, to, servers, edges}` — from · to 는 Java Instant 글자, servers 는 이름순, edges 는 (service, caller, class)순(TrafficController.kt:103-111,200-218).
 *   선의 칸은 TrafficControllerTest.kt:124-132 가 고정한 꼴 그대로: `count` · `status{2xx,3xx,4xx,5xx,other}` · `error_rate`(count 0 이면 null) ·
 *   `p50` · `p95`(`{le_ms}` 또는 `{gt_ms}` 또는 null) · `max_ms`(health · stream 이면 null) · `filling_count`.
 * 응답에는 일부러 계약 밖 칸(주소 · 원문 표식)을 붙인다 — 화면 · 사건에 나오면 모르는 칸을 실어 보낸 것이다. */
import { javaInstantText } from "@/features/log-trace/lib/log-trace-test-fakes";
import type { TrafficMapEdge, TrafficMapServer, TrafficMapSnapshot, TrafficQuantile } from "@/features/traffic-map/lib/traffic-map-client";
import type { TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import { buildTrafficMapView } from "@/features/traffic-map/lib/traffic-map-view";
import { FAKE_OBSERVE_SECRET, UPSTREAM_RAW_MARKER, headersOf, jsonBody, type RoutedFetchHandler } from "@/shared/lib/upstream-test-fakes";

/** 계약 밖 칸에 심는 주소(문서용 대역 — RFC 5737) — 결과 어디에도 나오면 안 된다. */
export const LEAKED_ADDRESS = "198.51.100.23";

/** 실제 관측 서버의 응답(T7 리뷰가 실제 PostgreSQL · Redis 로 받은 `t7-out/map_24h.json` 그대로 — `GET /traffic/map?from=2026-11-25T00:34:44.000Z&to=2026-11-26T00:34:44.000Z`). 바꾸지 않는다. */
export const REAL_MAP_24H_BODY = "{\"success\":true,\"data\":{\"from\":\"2026-11-25T00:34:44Z\",\"to\":\"2026-11-26T00:34:44Z\",\"servers\":[{\"server\":\"ci-agent-158\",\"read_progress_at\":\"2026-11-26T00:34:04Z\",\"receive_delayed\":false,\"sequence_gaps\":1,\"last_received_at\":\"2026-11-26T00:34:45.056Z\",\"missing\":[],\"requests_dropped\":0,\"requests_rejected\":0,\"first_seq_seen\":1},{\"server\":\"ci-agent-llm.home\",\"read_progress_at\":\"2026-11-26T00:34:39Z\",\"receive_delayed\":false,\"sequence_gaps\":0,\"last_received_at\":\"2026-11-26T00:34:45.056Z\",\"missing\":[],\"requests_dropped\":0,\"requests_rejected\":0,\"first_seq_seen\":1}],\"edges\":[{\"service\":\"backend\",\"caller\":\"front\",\"class\":\"request\",\"count\":4,\"status\":{\"2xx\":4,\"3xx\":0,\"4xx\":0,\"5xx\":0,\"other\":0},\"error_rate\":0.0,\"p50\":{\"le_ms\":50},\"p95\":{\"le_ms\":50},\"max_ms\":40,\"filling_count\":0}]}}";

export interface FakeEdge {
  service: string;
  caller: string;
  trafficClass: "request" | "health" | "stream";
  count: number;
  status: { "2xx": number; "3xx": number; "4xx": number; "5xx": number; other: number };
  p50: { le_ms: number } | { gt_ms: number } | null;
  p95: { le_ms: number } | { gt_ms: number } | null;
  maxMilliseconds: number | null;
  fillingCount: number;
}

export function fakeEdge(overrides: Partial<FakeEdge> = {}): FakeEdge {
  const count = overrides.count ?? 20;
  return {
    service: "backend", caller: "front", trafficClass: "request", count,
    status: { "2xx": count, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 },
    p50: { le_ms: 50 }, p95: { le_ms: 250 }, maxMilliseconds: 240, fillingCount: 0, ...overrides,
  };
}

/** 관측 서버가 주는 선 한 줄(TrafficController.kt:107-109 · 185-193). error_rate 는 5xx ÷ count(count 0 이면 null). */
export function observeEdgeRow(edge: FakeEdge): Record<string, unknown> {
  return {
    service: edge.service, caller: edge.caller, class: edge.trafficClass, count: edge.count, status: edge.status,
    error_rate: edge.count === 0 ? null : edge.status["5xx"] / edge.count, p50: edge.p50, p95: edge.p95, max_ms: edge.maxMilliseconds,
    filling_count: edge.fillingCount, upstream_addr: `${LEAKED_ADDRESS}:8080`, extra: UPSTREAM_RAW_MARKER,
  };
}

export interface FakeMapServer {
  server: string;
  readProgressMilliseconds: number | null;
  receiveDelayed: boolean;
  sequenceGaps: number;
  lastReceivedMilliseconds: number | null;
  missing: string[];
  requestsDropped: number;
  requestsRejected: number;
  firstSeqSeen: number | null;
}

export function fakeMapServer(overrides: Partial<FakeMapServer> = {}): FakeMapServer {
  return {
    server: "ci-agent-158", readProgressMilliseconds: Date.UTC(2026, 10, 25, 4, 9, 0), receiveDelayed: false, sequenceGaps: 0,
    lastReceivedMilliseconds: Date.UTC(2026, 10, 25, 4, 9, 40), missing: [], requestsDropped: 0, requestsRejected: 0, firstSeqSeen: 1, ...overrides,
  };
}

export function observeMapServerRow(server: FakeMapServer): Record<string, unknown> {
  return {
    server: server.server,
    read_progress_at: server.readProgressMilliseconds === null ? null : javaInstantText(server.readProgressMilliseconds),
    receive_delayed: server.receiveDelayed, sequence_gaps: server.sequenceGaps,
    last_received_at: server.lastReceivedMilliseconds === null ? null : javaInstantText(server.lastReceivedMilliseconds),
    missing: server.missing, requests_dropped: server.requestsDropped, requests_rejected: server.requestsRejected, first_seq_seen: server.firstSeqSeen,
    remote_addr: LEAKED_ADDRESS,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

/** 가짜 관측 서버의 `/traffic/map` 처리기 — 저장된 선 · 서버를 실제 규칙대로 돌려준다. 받은 조건은 calls 에 남는다. 그 밖의 경로는 404. */
export function createFakeObserveMap(initial: { edges?: FakeEdge[]; servers?: FakeMapServer[] } = {}) {
  const store = { edges: [...(initial.edges ?? [])], servers: [...(initial.servers ?? [])] };
  const calls: Record<string, string>[] = [];
  const handler: RoutedFetchHandler = (url, init) => {
    if (headersOf(init).get("X-Observe-Secret") !== FAKE_OBSERVE_SECRET) return jsonBody({ success: false, error: { code: "unauthorized" } }, 401);
    if (url.pathname !== "/traffic/map") return jsonBody({ success: false, error: { code: "not_found" } }, 404);
    const parameters = Object.fromEntries(url.searchParams);
    calls.push(parameters);
    const invalid = (detail: string) => jsonBody({ success: false, error: { code: "invalid_request", detail: `${detail} ${UPSTREAM_RAW_MARKER} ${LEAKED_ADDRESS}` } }, 422);
    const to = parameters.to ? Date.parse(parameters.to) : Date.now();
    const from = parameters.from ? Date.parse(parameters.from) : to - FIVE_MINUTES;
    if (Number.isNaN(from) || Number.isNaN(to)) return invalid("ISO 시각이어야 한다");
    if (from > to) return invalid("from 이 to 보다 늦다");
    if (to - from > DAY) return invalid("기간은 최대 24시간");
    const order = (edge: FakeEdge) => `${edge.service}\u0000${edge.caller}\u0000${edge.trafficClass}`;
    return jsonBody({
      success: true,
      data: {
        from: javaInstantText(from), to: javaInstantText(to),
        servers: [...store.servers].sort((left, right) => (left.server < right.server ? -1 : 1)).map(observeMapServerRow),
        edges: [...store.edges].sort((left, right) => (order(left) < order(right) ? -1 : order(left) > order(right) ? 1 : 0)).map(observeEdgeRow),
        extra: UPSTREAM_RAW_MARKER,
      },
    });
  };
  return { store, calls, handler };
}

/** 사례 — 채팅 한 건이 지나는 선들 + 헬스 하나. */
export function chatMapEdges(): FakeEdge[] {
  return [
    fakeEdge({ service: "front", caller: "edge", count: 40, status: { "2xx": 38, "3xx": 0, "4xx": 1, "5xx": 1, other: 0 }, p50: { le_ms: 250 }, p95: { le_ms: 5000 }, maxMilliseconds: 4100 }),
    fakeEdge({ service: "backend", caller: "front", count: 20, status: { "2xx": 18, "3xx": 0, "4xx": 0, "5xx": 2, other: 0 }, p50: { le_ms: 5 }, p95: { le_ms: 1000 }, maxMilliseconds: 200_000, fillingCount: 50 }),
    fakeEdge({ service: "llm-wrapper", caller: "backend", count: 0, status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 }, p50: null, p95: null, maxMilliseconds: null, fillingCount: 3 }),
    fakeEdge({ service: "llm-wrapper", caller: "backend", trafficClass: "stream", count: 8, status: { "2xx": 8, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 }, p50: null, p95: null, maxMilliseconds: null }),
    fakeEdge({ service: "observe", caller: "alert", trafficClass: "health", count: 4, status: { "2xx": 4, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 }, p50: null, p95: null, maxMilliseconds: null }),
  ];
}

/** 어드민 쪽 꼴(클라이언트가 읽은 결과와 같은 값). */
export function trafficMapEdgeOf(edge: FakeEdge): TrafficMapEdge {
  const quantile = (value: FakeEdge["p50"]): TrafficQuantile | null =>
    value === null ? null : "le_ms" in value ? { kind: "at_most", milliseconds: value.le_ms } : { kind: "over", milliseconds: value.gt_ms };
  return {
    service: edge.service, caller: edge.caller, trafficClass: edge.trafficClass, count: edge.count, status: { ...edge.status },
    errorRate: edge.count === 0 ? null : edge.status["5xx"] / edge.count, p50: quantile(edge.p50), p95: quantile(edge.p95),
    maxMilliseconds: edge.maxMilliseconds, fillingCount: edge.fillingCount,
  };
}

export function trafficMapServerOf(server: FakeMapServer): TrafficMapServer {
  return {
    server: server.server, readProgressAt: server.readProgressMilliseconds === null ? null : javaInstantText(server.readProgressMilliseconds),
    receiveDelayed: server.receiveDelayed, sequenceGaps: server.sequenceGaps,
    lastReceivedAt: server.lastReceivedMilliseconds === null ? null : javaInstantText(server.lastReceivedMilliseconds),
    missing: [...server.missing], requestsDropped: server.requestsDropped, requestsRejected: server.requestsRejected, firstSeqSeen: server.firstSeqSeen,
  };
}

export function trafficMapSnapshotOf(edges: FakeEdge[], servers: FakeMapServer[] = [fakeMapServer()]): TrafficMapSnapshot {
  return { from: "2026-11-25T04:05:00Z", to: "2026-11-25T04:10:00Z", servers: servers.map(trafficMapServerOf), edges: edges.map(trafficMapEdgeOf) };
}

/** 사건 하나(허브가 보내는 꼴) — 지도는 buildTrafficMapView 로. */
export function trafficMapEventOf(sequence: number, edges: FakeEdge[], options: { servers?: FakeMapServer[]; range?: TrafficMapRange; fetchedAt?: number } = {}): TrafficMapEvent {
  return {
    sequence, fetchedAt: new Date(options.fetchedAt ?? Date.UTC(2026, 10, 25, 4, 10, sequence)).toISOString(), range: options.range ?? "5m",
    map: { ok: true, value: buildTrafficMapView(trafficMapSnapshotOf(edges, options.servers)) },
  };
}

/** 테스트 전용 EventSource — 붙인 듣는 함수를 남기고, emit 으로 사건을 일으킨다. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  constructor(public readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() { this.readyState = 2; this.closed = true; }
  emit(type: string, data?: unknown) {
    if (type === "open") this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  listenerTypes(): string[] { return [...this.listeners.keys()].sort(); }
}
