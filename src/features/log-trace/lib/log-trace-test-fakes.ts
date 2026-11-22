/** 테스트 전용 — 연관 로그 사례의 가짜 관측 서버 · master · 알림 서버. 주소는 문서용 도메인(.test), 비밀값은 명백한 가짜(upstream-test-fakes).
 * 가짜 관측 서버는 `GET /logs` 의 규칙을 실제 소스대로 흉내 낸다(observe api/LogController.kt:88-121 · log/LogStore.kt:76-95):
 * from · to 는 밀리초 양끝 포함 · service · level · request_id 는 같음 · before 는 (밀리초, 순번) 엄격히 작음 · 최신순 · limit 1~500(기본 100)
 * · next_before = 꽉 채웠으면 마지막 id, 아니면 "" · 응답의 from · to 는 Java Instant 글자(밀리초 0 이면 소수 없음). 비밀값이 틀리면 401. */
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  UPSTREAM_RAW_MARKER, createRoutedFetch, headersOf, jsonBody, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;

/** 기준 시각 — 밀리초가 0 이 아니다(소수 자리 처리를 함께 본다). */
export const SELECTED_MILLISECONDS = Date.UTC(2026, 10, 22, 10, 0, 0, 123);
export const SELECTED_SEQUENCE = 2;
export const SELECTED_LOG_ID = `${SELECTED_MILLISECONDS}-${SELECTED_SEQUENCE}`;
export const SELECTED_REQUEST_ID = "req-trace-1";

/** 어드민이 보내는 시각 글자(밀리초 3자리). */
export function isoMilliseconds(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}

/** Java Instant.toString 과 같은 글자(밀리초가 0 이면 소수 없음). */
export function javaInstantText(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString().replace(".000Z", "Z");
}

export interface FakeLogLine {
  milliseconds: number;
  sequence: number;
  level: string;
  service: string;
  requestId: string;
  message: string;
}

export function fakeLogLine(overrides: Partial<FakeLogLine> = {}): FakeLogLine {
  return {
    milliseconds: SELECTED_MILLISECONDS, sequence: SELECTED_SEQUENCE, level: "error", service: "backend",
    requestId: SELECTED_REQUEST_ID, message: "boom", ...overrides,
  };
}

export function logIdOf(line: FakeLogLine): string {
  return `${line.milliseconds}-${line.sequence}`;
}

/** 관측 서버가 주는 한 줄(일부러 계약 밖 칸 extra 를 붙인다 — 화면에 나가면 원문을 흘린 것이다). */
export function observeRow(line: FakeLogLine): Record<string, unknown> {
  return {
    id: logIdOf(line), at: javaInstantText(line.milliseconds), level: line.level, service: line.service,
    request_id: line.requestId, message: line.message, extra: UPSTREAM_RAW_MARKER,
  };
}

/** 어드민 화면 꼴의 한 줄(LogEntryView). */
export function logEntryView(line: FakeLogLine) {
  return {
    id: logIdOf(line), at: javaInstantText(line.milliseconds), level: line.level, service: line.service,
    requestId: line.requestId, message: line.message,
  };
}

function compareDescending(left: FakeLogLine, right: FakeLogLine): number {
  return right.milliseconds - left.milliseconds || right.sequence - left.sequence;
}

/** 가짜 관측 서버의 `/logs` 처리기 — 저장된 줄(lines)을 실제 규칙대로 거른다. 받은 조건은 calls 에 남는다. */
export function createFakeObserveLogs(initialLines: FakeLogLine[]) {
  const store = { lines: [...initialLines] };
  const calls: Record<string, string>[] = [];
  const handler: RoutedFetchHandler = (url, init) => {
    if (headersOf(init).get("X-Observe-Secret") !== FAKE_OBSERVE_SECRET) return jsonBody({ success: false, error: { code: "unauthorized" } }, 401);
    if (url.pathname !== "/logs") return jsonBody({ success: false, error: { code: "not_found" } }, 404);
    const parameters = Object.fromEntries(url.searchParams);
    calls.push(parameters);
    const invalid = (detail: string) => jsonBody({ success: false, error: { code: "invalid_request", detail: `${detail} ${UPSTREAM_RAW_MARKER}` } }, 422);
    if (parameters.before && !parameters.from && !parameters.to) return invalid("before");
    const toMilliseconds = parameters.to ? Date.parse(parameters.to) : Date.now();
    const fromMilliseconds = parameters.from ? Date.parse(parameters.from) : toMilliseconds - HOUR;
    if (Number.isNaN(fromMilliseconds) || Number.isNaN(toMilliseconds) || fromMilliseconds > toMilliseconds) return invalid("range");
    const limit = parameters.limit ? Number(parameters.limit) : 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return invalid("limit");
    let before: { milliseconds: number; sequence: number } | null = null;
    if (parameters.before) {
      const match = /^(\d{1,15})-(\d{1,9})$/.exec(parameters.before);
      if (!match) return invalid("before");
      before = { milliseconds: Number(match[1]), sequence: Number(match[2]) };
    }
    const rows = store.lines
      .filter((line) => line.milliseconds >= fromMilliseconds && line.milliseconds <= toMilliseconds)
      .filter((line) => !parameters.service || line.service === parameters.service)
      .filter((line) => !parameters.level || line.level === parameters.level)
      .filter((line) => !parameters.request_id || line.requestId === parameters.request_id)
      .filter((line) => before === null || line.milliseconds < before.milliseconds
        || (line.milliseconds === before.milliseconds && line.sequence < before.sequence))
      .sort(compareDescending)
      .slice(0, limit);
    return jsonBody({
      success: true,
      data: {
        logs: rows.map(observeRow),
        next_before: rows.length === limit ? logIdOf(rows[rows.length - 1]) : "",
        from: javaInstantText(fromMilliseconds), to: javaInstantText(toMilliseconds), extra: UPSTREAM_RAW_MARKER,
      },
    });
  };
  return { store, calls, handler };
}

/** master `GET /deploys` 의 한 항목(ci-cd internal/master/store.go:22-33). */
export function masterDeployment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: "deploy-1", service: "backend", commit_sha: "a".repeat(40), state: "succeeded",
    accepted_at: javaInstantText(SELECTED_MILLISECONDS - 10 * MINUTE), finished_at: javaInstantText(SELECTED_MILLISECONDS - 8 * MINUTE),
    ci_ms: 60000, cd_ms: 30000, detail: `${UPSTREAM_RAW_MARKER} build output`, ...overrides,
  };
}

export function masterDeploymentsBody(rows: Record<string, unknown>[]): Response {
  return jsonBody({ success: true, data: { deployments: rows } });
}

/** 알림 서버 `GET /incidents` 의 한 항목(alert AlertController.kt:102-103). */
export function alertIncident(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: "2026-11-22T09:50:00.123456Z", kind: "monitor_down", key: "front", title: "front DOWN",
    detail: `${UPSTREAM_RAW_MARKER} ${FAKE_OBSERVE_URL} connection refused`, delivered_by: "telegram", suppressed: false, ...overrides,
  };
}

export function alertIncidentsBody(rows: Record<string, unknown>[]): Response {
  return jsonBody({ success: true, data: { incidents: rows } });
}

export interface TraceHandlers {
  observe: RoutedFetchHandler;
  master: RoutedFetchHandler;
  alert: RoutedFetchHandler;
}

/** 출처(origin)로 세 서버를 가른다. 그 밖의 주소는 던진다(사례 실패). */
export function createTraceFetch(handlers: TraceHandlers) {
  return createRoutedFetch((url, init) => {
    if (url.origin === new URL(FAKE_OBSERVE_URL).origin) return handlers.observe(url, init);
    if (url.origin === new URL(FAKE_DEPLOY_MASTER_URL).origin) return handlers.master(url, init);
    if (url.origin === new URL(FAKE_ALERT_URL).origin) return handlers.alert(url, init);
    throw new Error(`unexpected host ${url.hostname}`);
  });
}

export type TraceFetch = ReturnType<typeof createTraceFetch>;

/** 받은 호출을 출처별로. */
export function callsTo(fetch: TraceFetch, baseUrl: string) {
  return fetch.mock.calls.filter(([input]) => new URL(input).origin === new URL(baseUrl).origin);
}

export function observeCalls(fetch: TraceFetch) { return callsTo(fetch, FAKE_OBSERVE_URL); }
export function masterCalls(fetch: TraceFetch) { return callsTo(fetch, FAKE_DEPLOY_MASTER_URL); }
export function alertCalls(fetch: TraceFetch) { return callsTo(fetch, FAKE_ALERT_URL); }

/** 가짜 비밀값 확인이 있는 master · 알림 처리기. */
export function masterHandlerFor(rows: Record<string, unknown>[]): RoutedFetchHandler {
  return (_url, init) => (headersOf(init).get("X-Deploy-Secret") === FAKE_DEPLOY_SECRET
    ? masterDeploymentsBody(rows)
    : jsonBody({ success: false, error: { code: "unauthorized" } }, 401));
}

export function alertHandlerFor(rows: Record<string, unknown>[]): RoutedFetchHandler {
  return (_url, init) => (headersOf(init).get("X-Alert-Secret") === FAKE_ALERT_SECRET
    ? alertIncidentsBody(rows)
    : jsonBody({ success: false, error: { code: "unauthorized" } }, 401));
}
