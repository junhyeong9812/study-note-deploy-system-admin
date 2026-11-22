/** 로그 조회 — 명세 ② 화면 "observe GET /logs — 기간 · 서비스 · 레벨 · 요청 ID · 검색어(2자 이상), 이어 보기(next_before + 응답의 from·to)" ·
 * 세부 "목록 화면의 기간·건수 상한은 어드민 서버 쪽에서도 강제" · "필요한 칸만" · "상태 코드와 짧은 사유만" · "각각 5초" · 읽기 전용. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogClient } from "@/features/logs/lib/log-client";
import {
  LOG_QUERY_DEFAULT_LIMIT, LOG_QUERY_MAXIMUM_LIMIT, LOG_QUERY_MAXIMUM_RANGE_MILLISECONDS, nextLogPageQuery, parseLogQuery,
  type LogPage, type LogQuery,
} from "@/features/logs/lib/log-query";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal, expectFailure,
  expectReadOnlyRequest, hangUntilAborted, headersOf, headersThenStalledBody, jsonBody, leakyErrorBody, leakyNetworkError,
  okValue, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const OBSERVE_MAX_LIMIT = 500;                       // observe LogController.kt:147
const OBSERVE_MAX_RANGE = 31 * DAY;                  // LogController.kt:149

const EMPTY_QUERY: LogQuery = { from: null, to: null, service: null, level: null, requestId: null, text: null, before: null, limit: 100 };

function iso(epochMilliseconds: number) {
  return new Date(epochMilliseconds).toISOString().replace(".000Z", "Z");
}

function expectInvalid(input: Parameters<typeof parseLogQuery>[0], field: string) {
  const result = parseLogQuery(input, NOW);
  expectFailure(result, "invalid_input");
  expect(!result.ok && result.field).toBe(field);
}

describe("parseLogQuery — 기본값", () => {
  it("아무것도 없으면 전부 null · 100건(관측 서버의 기본 — 최근 1시간)", () => {
    expect(parseLogQuery({}, NOW)).toEqual({ ok: true, query: EMPTY_QUERY });
    expect(LOG_QUERY_DEFAULT_LIMIT).toBe(100);
  });

  it("빈 글자는 없는 것과 같다", () => {
    expect(parseLogQuery({ from: "", to: "", service: "", level: "", request_id: "", q: "", before: "", limit: "" }, NOW))
      .toEqual({ ok: true, query: EMPTY_QUERY });
  });

  it("모든 조건이 맞으면 그대로", () => {
    const input = {
      from: "2026-11-22T10:00:00Z", to: "2026-11-22T11:00:00.123Z", service: "backend", level: "error",
      request_id: "req_1.a-B", q: "timeout", before: "1763805600000-3", limit: "20",
    };
    expect(parseLogQuery(input, NOW)).toEqual({ ok: true, query: {
      from: "2026-11-22T10:00:00Z", to: "2026-11-22T11:00:00.123Z", service: "backend", level: "error",
      requestId: "req_1.a-B", text: "timeout", before: "1763805600000-3", limit: 20,
    } });
  });
});

describe("parseLogQuery — 기간", () => {
  it.each(["2026-11-22", "2026-11-22T10:00:00", "2026-11-22T10:00:00+09:00", "2026-11-22 10:00:00Z", "yesterday", "1763805600000",
    "2026-13-01T00:00:00Z", "2026-11-31T00:00:00Z", "2026-11-22T25:00:00Z"])("ISO-8601 UTC 가 아닌 from %j → invalid_input(from)", (from) => {
    expectInvalid({ from, to: "2026-11-22T11:00:00Z" }, "from");
  });

  it("to 도 같은 꼴만", () => {
    expectInvalid({ from: "2026-11-22T10:00:00Z", to: "now" }, "to");
  });

  it("from 이 to 보다 늦으면 거절", () => {
    expectInvalid({ from: "2026-11-22T11:00:00Z", to: "2026-11-22T10:00:00Z" }, "from");
  });

  it("어드민의 기간 상한은 관측 서버의 상한 이하 — 정확히 상한이면 통과, 1초 넘으면 거절", () => {
    expect(LOG_QUERY_MAXIMUM_RANGE_MILLISECONDS).toBeLessThanOrEqual(OBSERVE_MAX_RANGE);
    const to = NOW - DAY;
    expect(parseLogQuery({ from: iso(to - LOG_QUERY_MAXIMUM_RANGE_MILLISECONDS), to: iso(to) }, NOW).ok).toBe(true);
    expectInvalid({ from: iso(to - LOG_QUERY_MAXIMUM_RANGE_MILLISECONDS - 1000), to: iso(to) }, "from");
  });

  it("from 만 있으면 지금까지로 잰다 — 상한을 넘으면 거절", () => {
    expect(parseLogQuery({ from: iso(NOW - 2 * DAY) }, NOW).ok).toBe(true);
    expectInvalid({ from: iso(NOW - LOG_QUERY_MAXIMUM_RANGE_MILLISECONDS - 60_000) }, "from");
  });

  it("to 만 있으면 통과(그 앞 1시간)", () => {
    expect(parseLogQuery({ to: iso(NOW - DAY) }, NOW)).toMatchObject({ ok: true, query: { from: null, to: iso(NOW - DAY) } });
  });
});

describe("parseLogQuery — 이어 보기(before 만 넘기지 않는다)", () => {
  it("before 만 있으면 거절", () => {
    expectInvalid({ before: "1763805600000-3" }, "before");
  });

  it("before 에 from 만 · to 만 있어도 거절(둘 다 있어야 한다)", () => {
    expectInvalid({ before: "1763805600000-3", from: "2026-11-22T10:00:00Z" }, "before");
    expectInvalid({ before: "1763805600000-3", to: "2026-11-22T11:00:00Z" }, "before");
  });

  it.each(["abc", "123", "1-2-3", "-1", "1763805600000-", "1763805600000-3 ", "1234567890123456-1", `${UPSTREAM_RAW_MARKER}`])(
    "next_before 꼴이 아닌 before %j → invalid_input(before)", (before) => {
      expectInvalid({ before, from: "2026-11-22T10:00:00Z", to: "2026-11-22T11:00:00Z" }, "before");
    });
});

describe("parseLogQuery — 서비스 · 레벨 · 요청 ID · 검색어 · 건수", () => {
  it.each(["Backend", "back end", "back_end", "a".repeat(41), "백엔드", "backend;"])("service %j → 거절", (service) => {
    expectInvalid({ service }, "service");
  });

  it.each(["front", "backend", "admin", "deploy-master", "a".repeat(40)])("service %j → 통과", (service) => {
    expect(parseLogQuery({ service }, NOW)).toMatchObject({ ok: true, query: { service } });
  });

  it.each(["debug", "info", "warning", "error"])("level %s → 통과", (level) => {
    expect(parseLogQuery({ level }, NOW)).toMatchObject({ ok: true, query: { level } });
  });

  it.each(["warn", "WARNING", "fatal", "Error"])("level %j → 거절", (level) => {
    expectInvalid({ level }, "level");
  });

  it.each(["a b", "a/b", "a".repeat(81), "요청"])("request_id %j → 거절", (requestId) => {
    expectInvalid({ request_id: requestId }, "request_id");
  });

  it.each(["a", " a ", "   ", "\t\n"])("q %j(앞뒤 공백을 빼고 2자 미만) → 거절", (text) => {
    expectInvalid({ q: text }, "q");
  });

  it("q 201자 → 거절, 200자 · 2자 → 통과", () => {
    expectInvalid({ q: "가".repeat(201) }, "q");
    expect(parseLogQuery({ q: "가".repeat(200) }, NOW)).toMatchObject({ ok: true, query: { text: "가".repeat(200) } });
    expect(parseLogQuery({ q: "오류" }, NOW)).toMatchObject({ ok: true, query: { text: "오류" } });
  });

  it("어드민의 건수 상한은 관측 서버의 상한 이하", () => {
    expect(LOG_QUERY_MAXIMUM_LIMIT).toBeLessThanOrEqual(OBSERVE_MAX_LIMIT);
    expect(parseLogQuery({ limit: String(LOG_QUERY_MAXIMUM_LIMIT) }, NOW)).toMatchObject({ ok: true, query: { limit: LOG_QUERY_MAXIMUM_LIMIT } });
  });

  it.each(["0", String(LOG_QUERY_MAXIMUM_LIMIT + 1), "-5", "1.5", "ten", "1e2"])("limit %j → 거절", (limit) => {
    expectInvalid({ limit }, "limit");
  });

  it.each(["from", "to", "service", "level", "request_id", "q", "before", "limit"])("%s 가 여러 번(배열)이면 거절", (name) => {
    expectInvalid({ [name]: ["a", "b"] }, name);
  });
});

describe("nextLogPageQuery — 다음 쪽은 응답의 from·to 와 함께", () => {
  const page: LogPage = { logs: [], nextBefore: "1763805600000-3", from: "2026-11-22T11:00:00Z", to: "2026-11-22T12:00:00Z" };

  it("기간을 주지 않은 조회의 다음 쪽 — before 와 함께 응답의 from · to 가 들어간다(before 만 넘기지 않는다)", () => {
    const query: LogQuery = { ...EMPTY_QUERY, service: "backend", level: "error", text: "timeout", limit: 50 };
    expect(nextLogPageQuery(query, page)).toEqual({
      ...query, before: "1763805600000-3", from: "2026-11-22T11:00:00Z", to: "2026-11-22T12:00:00Z",
    });
  });

  it("다음 쪽 조건은 다시 parseLogQuery 를 통과한다", () => {
    const next = nextLogPageQuery({ ...EMPTY_QUERY }, page)!;
    const input = { from: next.from!, to: next.to!, before: next.before!, limit: String(next.limit) };
    expect(parseLogQuery(input, NOW).ok).toBe(true);
  });

  it("next_before 가 없으면(끝) null", () => {
    expect(nextLogPageQuery(EMPTY_QUERY, { ...page, nextBefore: null })).toBeNull();
  });
});

function logEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      logs: [
        { id: "1763805600000-3", at: "2026-11-22T10:00:00Z", level: "error", service: "backend", request_id: "req-1", message: "boom", extra: UPSTREAM_RAW_MARKER },
        { id: "1763805599000-0", at: "2026-11-22T09:59:59Z", level: "info", service: "unknown", request_id: "", message: "line" },
      ],
      next_before: "1763805599000-0", from: "2026-11-22T09:00:00Z", to: "2026-11-22T10:00:00Z", extra: UPSTREAM_RAW_MARKER,
      ...overrides,
    },
  };
}

describe("createLogClient — 요청", () => {
  it("GET <base>/logs · null 이 아닌 조건만 + limit · X-Observe-Secret · redirect manual · 본문 없음", async () => {
    const fetch = createRoutedFetch(() => jsonBody(logEnvelope()));
    const client = createLogClient({ baseUrl: `${FAKE_OBSERVE_URL}/`, secret: FAKE_OBSERVE_SECRET, fetch });
    await client.searchLogs({ ...EMPTY_QUERY, service: "backend", text: "에러 a&b=1", limit: 30 });
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.pathname).toBe("/logs");
    expect(Object.fromEntries(url.searchParams)).toEqual({ service: "backend", q: "에러 a&b=1", limit: "30" });
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("X-Observe-Secret")).toBe(FAKE_OBSERVE_SECRET);
    expect(headersOf(init).get("X-Deploy-Secret")).toBeNull();
    expect(init?.redirect).toBe("manual");
  });

  it("이어 보기 조건은 before · from · to 를 함께 보낸다 · request_id 이름으로", async () => {
    const fetch = createRoutedFetch(() => jsonBody(logEnvelope()));
    const client = createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch });
    await client.searchLogs({ ...EMPTY_QUERY, requestId: "req-1", level: "warning", before: "1-0", from: "2026-11-22T09:00:00Z", to: "2026-11-22T10:00:00Z" });
    expect(Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams)).toEqual({
      request_id: "req-1", level: "warning", before: "1-0", from: "2026-11-22T09:00:00Z", to: "2026-11-22T10:00:00Z", limit: "100",
    });
  });

  it("제한 시간 신호를 5000ms 로", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch(() => jsonBody(logEnvelope()));
    await createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch, timeoutSignal: timeout.factory }).searchLogs(EMPTY_QUERY);
    expect(timeout.requestedMilliseconds).toEqual([5_000]);
  });
});

describe("createLogClient — 응답 칸 선택", () => {
  it("logs 의 id · at · level · service · requestId · message 와 nextBefore · from · to 만", async () => {
    const fetch = createRoutedFetch(() => jsonBody(logEnvelope()));
    const page = okValue(await createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).searchLogs(EMPTY_QUERY));
    expect(page).toStrictEqual({
      logs: [
        { id: "1763805600000-3", at: "2026-11-22T10:00:00Z", level: "error", service: "backend", requestId: "req-1", message: "boom" },
        { id: "1763805599000-0", at: "2026-11-22T09:59:59Z", level: "info", service: "unknown", requestId: "", message: "line" },
      ],
      nextBefore: "1763805599000-0", from: "2026-11-22T09:00:00Z", to: "2026-11-22T10:00:00Z",
    });
    expect(JSON.stringify(page)).not.toContain(UPSTREAM_RAW_MARKER);
  });

  it("next_before 가 빈 글자면 null(끝)", async () => {
    const fetch = createRoutedFetch(() => jsonBody(logEnvelope({ next_before: "" })));
    const page = okValue(await createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).searchLogs(EMPTY_QUERY));
    expect(page.nextBefore).toBeNull();
  });

  const malformed: [string, Record<string, unknown>][] = [
    ["logs 없음", { logs: undefined }],
    ["logs 가 객체", { logs: { a: 1 } }],
    ["level 이 열거 밖", { logs: [{ id: "1-0", at: "2026-11-22T10:00:00Z", level: "fatal", service: "x", request_id: "", message: "m" }] }],
    ["message 가 숫자", { logs: [{ id: "1-0", at: "2026-11-22T10:00:00Z", level: "info", service: "x", request_id: "", message: 3 }] }],
    ["request_id 빠짐", { logs: [{ id: "1-0", at: "2026-11-22T10:00:00Z", level: "info", service: "x", message: "m" }] }],
    ["from 빠짐", { from: undefined }],
    ["next_before 가 null", { next_before: null }],
  ];

  it.each(malformed)("%s → unparseable", async (_label, overrides) => {
    const body = logEnvelope(overrides);
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete (body.data as Record<string, unknown>)[key];
    const fetch = createRoutedFetch(() => jsonBody(body));
    expectFailure(await createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).searchLogs(EMPTY_QUERY), "unparseable");
  });

  it("JSON 이 아닌 200 → unparseable", async () => {
    const fetch = createRoutedFetch(() => textResponse(`not json ${UPSTREAM_RAW_MARKER}`));
    expectFailure(await createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).searchLogs(EMPTY_QUERY), "unparseable");
  });
});

describe("createLogClient — 관측 서버의 오류(401 · 422 · 503 · 504)를 화면용 짧은 사유로", () => {
  it.each([
    [401, "unauthorized"], [422, "invalid_request"], [503, "unavailable"], [504, "server_timeout"], [500, "bad_status"], [307, "bad_status"],
  ] as const)("HTTP %i → %s, detail · 원문 · 비밀값 · 주소 없음", async (status, reason) => {
    const fetch = createRoutedFetch(() => textResponse(leakyErrorBody(), status));
    expectFailure(await createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).searchLogs(EMPTY_QUERY), reason, status);
  });

  it("관측 서버의 실제 422 꼴(detail 에 한국어 사유) — detail 은 넘기지 않는다", async () => {
    const fetch = createRoutedFetch(() => jsonBody({ success: false, error: { code: "invalid_request", detail: `q 는 2자 이상 ${UPSTREAM_RAW_MARKER}` } }, 422));
    const result = await createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).searchLogs(EMPTY_QUERY);
    expectFailure(result, "invalid_request", 422);
    expect(JSON.stringify(result)).not.toContain("2자 이상");
  });

  it("연결 실패 → unreachable", async () => {
    const fetch = createRoutedFetch(() => Promise.reject(leakyNetworkError()));
    expectFailure(await createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).searchLogs(EMPTY_QUERY), "unreachable");
  });
});

describe("createLogClient — 5초 기한(가짜 타이머)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ["응답하지 않음", (init: RequestInit) => hangUntilAborted(init)],
    ["본문이 끝나지 않음", (init: RequestInit) => Promise.resolve(headersThenStalledBody(init))],
  ] as const)("%s → 5초에 timeout", async (_label, behave) => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((_url, init) => behave(init));
    const pending = track(createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch, timeoutSignal: timeout.factory }).searchLogs(EMPTY_QUERY));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expectFailure(pending.value!, "timeout");
  });
});
