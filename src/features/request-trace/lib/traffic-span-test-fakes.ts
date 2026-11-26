/** 테스트 전용 — 요청 추적의 구간(T7) 사례. 가짜 관측 서버의 `GET /traffic/requests` · `GET /traffic/map` 은 관측 서버의 실제 소스대로 흉내 낸다:
 * - 인증이 먼저(비밀값이 틀리면 401 `unauthorized`) — observe traffic/TrafficController.kt:49-54,165
 * - `/traffic/requests`: request_id 없음 · 꼴 밖(`^[A-Za-z0-9_.-]{1,80}$`)이면 422 `invalid_request`(TrafficController.kt:166-167,228) ·
 *   구간은 end_ms · 서비스순(TrafficStore.kt:501 `ORDER BY end_ms, service`) · 500 개까지, 넘치면 truncated(TrafficController.kt:169-177) ·
 *   구간의 칸과 형은 TrafficControllerTest.kt:197-200 이 고정한 꼴 그대로(`end_at` = Java Instant 글자, `duration_ms` · `bytes_sent` 수, `upstream_ms` 수 또는 null,
 *   `upstream_status` · `slot` 글자 또는 null). 응답에 request_id 가 실린다.
 * - `/traffic/map`: `{from, to, servers, edges}`(TrafficController.kt:97-113) · from/to 는 ISO(Instant.parse) · 거꾸로 · 24시간 초과는 422 ·
 *   `servers[]` 의 칸은 TrafficControllerTest.kt:119-123 이 고정한 꼴 그대로(`read_progress_at` ISO 또는 null · `receive_delayed` · `sequence_gaps` ·
 *   `last_received_at` · `missing[]` · `requests_dropped` · `requests_rejected` · `first_seq_seen` 수 또는 null).
 * 응답에는 일부러 계약 밖 칸(extra — 원문 표식)을 붙인다: 화면 · 데이터에 나오면 원문을 흘린 것이다. */
import { javaInstantText } from "@/features/log-trace/lib/log-trace-test-fakes";
import type { TrafficServerReceipt, TrafficSpan } from "@/features/request-trace/lib/traffic-span-client";
import { FAKE_OBSERVE_SECRET, UPSTREAM_RAW_MARKER, headersOf, jsonBody, type RoutedFetchHandler } from "@/shared/lib/upstream-test-fakes";

/** 관측 서버 TrafficControllerTest.kt:197-200 의 `spans.first()` 그대로(end_at 만 사례의 시각으로). */
export const OBSERVE_SPAN_FIXTURE = {
  server: "ci-agent-158", service: "backend", caller: "front", method: "GET", path: "/api/doc", path_truncated: false,
  status: 200, end_at: "2026-11-25T04:09:57Z", duration_ms: 41, upstream_ms: null, upstream_status: "200", slot: "blue", bytes_sent: 5120,
} as const;

/** 관측 서버 TrafficControllerTest.kt:119-123 의 `servers` 한 항목 그대로. */
export const OBSERVE_SERVER_FIXTURE = {
  server: "ci-agent-158", read_progress_at: "2026-11-25T04:09:00Z", receive_delayed: false, sequence_gaps: 1,
  last_received_at: "2026-11-25T04:09:40Z", missing: ["backend-nginx:rotated"], requests_dropped: 7, requests_rejected: 3, first_seq_seen: 5,
} as const;

export interface FakeSpan {
  requestId: string;
  server: string;
  service: string;
  caller: string;
  method: string;
  path: string;
  pathTruncated: boolean;
  status: number;
  endMilliseconds: number;
  durationMilliseconds: number;
  upstreamMilliseconds: number | null;
  upstreamStatus: string | null;
  slot: string | null;
  bytesSent: number;
}

export function fakeSpan(overrides: Partial<FakeSpan> = {}): FakeSpan {
  return {
    requestId: "req-0123456789ab", server: "ci-agent-158", service: "backend", caller: "front", method: "GET", path: "/api/doc", pathTruncated: false,
    status: 200, endMilliseconds: Date.UTC(2026, 10, 22, 10, 0, 0, 41), durationMilliseconds: 41, upstreamMilliseconds: 40, upstreamStatus: "200",
    slot: "blue", bytesSent: 5120, ...overrides,
  };
}

/** 관측 서버가 주는 구간 한 줄(request_id 는 응답의 줄에 없다 — TrafficController.kt:171-175). */
export function observeSpanRow(span: FakeSpan): Record<string, unknown> {
  return {
    server: span.server, service: span.service, caller: span.caller, method: span.method, path: span.path, path_truncated: span.pathTruncated,
    status: span.status, end_at: javaInstantText(span.endMilliseconds), duration_ms: span.durationMilliseconds, upstream_ms: span.upstreamMilliseconds,
    upstream_status: span.upstreamStatus, slot: span.slot, bytes_sent: span.bytesSent,
  };
}

/** 어드민 쪽 꼴(TrafficSpan) — 클라이언트가 읽은 결과와 같은 글자(end_at 은 Java Instant 글자). */
export function trafficSpanOf(span: FakeSpan): TrafficSpan {
  return {
    server: span.server, service: span.service, caller: span.caller, method: span.method, path: span.path, pathTruncated: span.pathTruncated,
    status: span.status, endAt: javaInstantText(span.endMilliseconds), durationMilliseconds: span.durationMilliseconds,
    upstreamMilliseconds: span.upstreamMilliseconds, upstreamStatus: span.upstreamStatus, slot: span.slot, bytesSent: span.bytesSent,
  };
}

export interface FakeServerReceipt {
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

export function fakeServerReceipt(overrides: Partial<FakeServerReceipt> = {}): FakeServerReceipt {
  return {
    server: "ci-agent-158", readProgressMilliseconds: null, receiveDelayed: false, sequenceGaps: 0, lastReceivedMilliseconds: null,
    missing: [], requestsDropped: 0, requestsRejected: 0, firstSeqSeen: 1, ...overrides,
  };
}

export function observeServerRow(receipt: FakeServerReceipt): Record<string, unknown> {
  return {
    server: receipt.server,
    read_progress_at: receipt.readProgressMilliseconds === null ? null : javaInstantText(receipt.readProgressMilliseconds),
    receive_delayed: receipt.receiveDelayed, sequence_gaps: receipt.sequenceGaps,
    last_received_at: receipt.lastReceivedMilliseconds === null ? null : javaInstantText(receipt.lastReceivedMilliseconds),
    missing: receipt.missing, requests_dropped: receipt.requestsDropped, requests_rejected: receipt.requestsRejected, first_seq_seen: receipt.firstSeqSeen,
  };
}

/** 어드민 쪽 꼴(TrafficServerReceipt). */
export function trafficServerReceiptOf(receipt: FakeServerReceipt): TrafficServerReceipt {
  return {
    server: receipt.server, readProgressAt: receipt.readProgressMilliseconds === null ? null : javaInstantText(receipt.readProgressMilliseconds),
    receiveDelayed: receipt.receiveDelayed, sequenceGaps: receipt.sequenceGaps, missing: receipt.missing,
    requestsDropped: receipt.requestsDropped, requestsRejected: receipt.requestsRejected,
  };
}

const OBSERVE_REQUEST_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const DAY = 24 * 60 * 60 * 1000;

/** 가짜 관측 서버의 `/traffic/*` 처리기 — 저장된 구간 · 서버 상태를 실제 규칙대로 돌려준다. 받은 조건은 calls 에 남는다(경로 · 인자). */
export function createFakeObserveTraffic(initial: { spans?: FakeSpan[]; servers?: FakeServerReceipt[] } = {}) {
  const store = { spans: [...(initial.spans ?? [])], servers: [...(initial.servers ?? [])] };
  const calls: { path: string; parameters: Record<string, string> }[] = [];
  const handler: RoutedFetchHandler = (url, init) => {
    if (headersOf(init).get("X-Observe-Secret") !== FAKE_OBSERVE_SECRET) return jsonBody({ success: false, error: { code: "unauthorized" } }, 401);
    const parameters = Object.fromEntries(url.searchParams);
    calls.push({ path: url.pathname, parameters });
    const invalid = (detail: string) => jsonBody({ success: false, error: { code: "invalid_request", detail: `${detail} ${UPSTREAM_RAW_MARKER}` } }, 422);
    if (url.pathname === "/traffic/requests") {
      const requestId = parameters.request_id;
      if (!requestId) return invalid("request_id 가 없다");
      if (!OBSERVE_REQUEST_ID.test(requestId)) return invalid("request_id 형식이 다르다");
      const found = store.spans.filter((span) => span.requestId === requestId)
        .sort((left, right) => left.endMilliseconds - right.endMilliseconds || (left.service < right.service ? -1 : left.service > right.service ? 1 : 0));
      return jsonBody({
        success: true,
        data: { request_id: requestId, spans: found.slice(0, 500).map(observeSpanRow), truncated: found.length > 500, extra: UPSTREAM_RAW_MARKER },
      });
    }
    if (url.pathname === "/traffic/map") {
      const toMilliseconds = parameters.to ? Date.parse(parameters.to) : Date.now();
      const fromMilliseconds = parameters.from ? Date.parse(parameters.from) : toMilliseconds - 5 * 60 * 1000;
      if (Number.isNaN(fromMilliseconds) || Number.isNaN(toMilliseconds)) return invalid("ISO 시각이어야 한다");
      if (fromMilliseconds > toMilliseconds) return invalid("from 이 to 보다 늦다");
      if (toMilliseconds - fromMilliseconds > DAY) return invalid("기간은 최대 24시간");
      return jsonBody({
        success: true,
        data: {
          from: javaInstantText(fromMilliseconds), to: javaInstantText(toMilliseconds),
          servers: [...store.servers].sort((left, right) => (left.server < right.server ? -1 : 1)).map(observeServerRow), edges: [], extra: UPSTREAM_RAW_MARKER,
        },
      });
    }
    return jsonBody({ success: false, error: { code: "not_found" } }, 404);
  };
  return { store, calls, handler };
}

/** 로그(`/logs`)와 통신(`/traffic/*`)을 경로로 가른다 — 관측 서버 하나. */
export function observeLogsAndTraffic(logs: RoutedFetchHandler, traffic: RoutedFetchHandler): RoutedFetchHandler {
  return (url, init) => (url.pathname.startsWith("/traffic/") ? traffic(url, init) : logs(url, init));
}

/** 받은 호출 가운데 그 경로의 것. */
export function callsToPath(calls: [string, RequestInit?][] | readonly (readonly [string, RequestInit?])[], path: string) {
  return calls.filter(([input]) => new URL(input).pathname === path);
}

/** T7 사례 — 채팅 한 건(기준 시각 T = 요청 추적 사례의 TRACE_START_MILLISECONDS).
 * 로그(시작에서 ms · 서비스 · 수준 · 글): front 10 · backend 130 · llm-wrapper 2700 · backend 3500(error) · front 3590(warning) · backend 3650 · ci-agent-158 3680.
 * 구간(서버 · 서비스 · 부른 쪽 · 요청 · 끝 · 걸린 시간 · upstream · 상태 · 바이트):
 *   ci-agent-158 front   ← outside  POST /api/chat  끝 3700 · 3700ms · upstream 3600 · 500 · 512   → 시작 0
 *   ci-agent-164 backend ← front    POST /api/chat  끝 3550 · 3440ms · upstream 3430 · 502 · 0     → 시작 110
 *   ci-agent-164 llm-wrapper ← backend POST /chat   끝 3300 · 1000ms · upstream 990  · 200 · 2048  → 시작 2300
 * 축: 0(front 구간의 시작) ~ 3700(front 구간의 끝) — 로그만이면 10 ~ 3680. */
export const OVERLAY_LOG_SCENARIO: readonly [number, string, "debug" | "info" | "warning" | "error", string][] = [
  [10, "front", "info", "POST /api/chat 받음"],
  [130, "backend", "info", "chat 시작"],
  [2700, "llm-wrapper", "info", "chat queued position=1"],
  [3500, "backend", "error", "응답 변환 실패"],
  [3590, "front", "warning", "응답 500 전달"],
  [3650, "backend", "info", "정리"],
  [3680, "ci-agent-158", "info", "헬스 확인"],
];

export function overlaySpanScenario(requestId: string, start: number): FakeSpan[] {
  return [
    fakeSpan({ requestId, server: "ci-agent-158", service: "front", caller: "outside", method: "POST", path: "/api/chat", status: 500,
      endMilliseconds: start + 3700, durationMilliseconds: 3700, upstreamMilliseconds: 3600, upstreamStatus: "500", slot: "green", bytesSent: 512 }),
    fakeSpan({ requestId, server: "ci-agent-164", service: "backend", caller: "front", method: "POST", path: "/api/chat", status: 502,
      endMilliseconds: start + 3550, durationMilliseconds: 3440, upstreamMilliseconds: 3430, upstreamStatus: "502", slot: "blue", bytesSent: 0 }),
    fakeSpan({ requestId, server: "ci-agent-164", service: "llm-wrapper", caller: "backend", method: "POST", path: "/chat", status: 200,
      endMilliseconds: start + 3300, durationMilliseconds: 1000, upstreamMilliseconds: 990, upstreamStatus: "200", slot: "blue", bytesSent: 2048 }),
  ];
}
