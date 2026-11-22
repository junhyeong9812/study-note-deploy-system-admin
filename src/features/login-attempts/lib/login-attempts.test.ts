/** 로그인 시도 기록 — 명세 ② 세부 관측 서버 계약 "GET /auth/attempts?from=&to=&before=&limit=(1~200, 기본 50, 기간 최대 90일)
 * → {attempts:[{id,at,outcome,ip,user_agent,replayed}], next_before} · GET /auth/lock → {locked, locked_until, failures}" ·
 * "목록 화면의 기간·건수 상한은 어드민 서버 쪽에서도 강제" · "필요한 칸만" · "각각 5초" · 읽기 전용. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoginAttemptsClient } from "@/features/login-attempts/lib/login-attempts-client";
import {
  LOGIN_ATTEMPTS_DEFAULT_LIMIT, LOGIN_ATTEMPTS_MAXIMUM_LIMIT, LOGIN_ATTEMPTS_MAXIMUM_RANGE_MILLISECONDS, LOGIN_ATTEMPT_OUTCOMES,
  nextLoginAttemptsPageQuery, parseLoginAttemptsQuery, type LoginAttemptsPage, type LoginAttemptsQuery,
} from "@/features/login-attempts/lib/login-attempts-query";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal, expectFailure,
  expectReadOnlyRequest, hangUntilAborted, headersOf, jsonBody, leakyErrorBody, leakyNetworkError, okValue, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const CURSOR = "2026-11-22T10:00:00.123456Z_0f8fad5b-d9cb-469f-a165-70867728950e";   // AuthAttemptCursor.toString — `${at}_${id}`
const EMPTY_QUERY: LoginAttemptsQuery = { from: null, to: null, before: null, limit: 50 };
const FAKE_ATTEMPT_IP = "203.0.113.9";   // 문서용 대역(TEST-NET-3)

function expectInvalid(input: Parameters<typeof parseLoginAttemptsQuery>[0], field: string) {
  const result = parseLoginAttemptsQuery(input, NOW);
  expectFailure(result, "invalid_input");
  expect(!result.ok && result.field).toBe(field);
}

describe("parseLoginAttemptsQuery", () => {
  it("기본: 기간 없음(관측 서버 기본 90일) · 50건", () => {
    expect(parseLoginAttemptsQuery({}, NOW)).toEqual({ ok: true, query: EMPTY_QUERY });
    expect(LOGIN_ATTEMPTS_DEFAULT_LIMIT).toBe(50);
  });

  it("상한은 관측 서버 이하(건수 200 · 기간 90일)", () => {
    expect(LOGIN_ATTEMPTS_MAXIMUM_LIMIT).toBeLessThanOrEqual(200);
    expect(LOGIN_ATTEMPTS_MAXIMUM_RANGE_MILLISECONDS).toBeLessThanOrEqual(90 * DAY);
  });

  it("맞는 조건은 그대로", () => {
    expect(parseLoginAttemptsQuery({ from: "2026-11-01T00:00:00Z", to: "2026-11-22T00:00:00Z", before: CURSOR, limit: "200" }, NOW))
      .toEqual({ ok: true, query: { from: "2026-11-01T00:00:00Z", to: "2026-11-22T00:00:00Z", before: CURSOR, limit: 200 } });
  });

  it.each(["0", "201", "abc", "-1", "2.5"])("limit %j → 거절", (limit) => { expectInvalid({ limit }, "limit"); });

  it.each(["2026-11-01", "2026-11-01T00:00:00+09:00", "어제"])("from %j → 거절", (from) => { expectInvalid({ from }, "from"); });

  it("from > to 거절", () => { expectInvalid({ from: "2026-11-22T00:00:00Z", to: "2026-11-21T00:00:00Z" }, "from"); });

  it("기간 90일 초과 거절 — from 만 있으면 지금까지로 잰다", () => {
    expectInvalid({ from: "2026-01-01T00:00:00Z", to: "2026-11-22T00:00:00Z" }, "from");
    expectInvalid({ from: new Date(NOW - LOGIN_ATTEMPTS_MAXIMUM_RANGE_MILLISECONDS - 60_000).toISOString() }, "from");
    expect(parseLoginAttemptsQuery({ from: new Date(NOW - 10 * DAY).toISOString() }, NOW).ok).toBe(true);
  });

  it("before 만 · before 와 from 만 → 거절(응답의 from·to 를 함께)", () => {
    expectInvalid({ before: CURSOR }, "before");
    expectInvalid({ before: CURSOR, from: "2026-11-01T00:00:00Z" }, "before");
  });

  it.each(["abc", "2026-11-22T10:00:00Z", "2026-11-22T10:00:00Z_not-a-uuid", "0f8fad5b-d9cb-469f-a165-70867728950e", `${CURSOR}_x`])(
    "next_before 꼴이 아닌 before %j → 거절", (before) => {
      expectInvalid({ before, from: "2026-11-01T00:00:00Z", to: "2026-11-22T00:00:00Z" }, "before");
    });

  it("배열 거절", () => { expectInvalid({ limit: ["1", "2"] }, "limit"); });
});

describe("nextLoginAttemptsPageQuery", () => {
  const page: LoginAttemptsPage = { attempts: [], nextBefore: CURSOR, from: "2026-08-24T12:00:00Z", to: "2026-11-22T12:00:00Z" };

  it("before 와 함께 응답의 from · to", () => {
    expect(nextLoginAttemptsPageQuery({ ...EMPTY_QUERY, limit: 20 }, page)).toEqual({
      from: "2026-08-24T12:00:00Z", to: "2026-11-22T12:00:00Z", before: CURSOR, limit: 20,
    });
  });

  it("끝이면 null", () => {
    expect(nextLoginAttemptsPageQuery(EMPTY_QUERY, { ...page, nextBefore: null })).toBeNull();
  });
});

function attemptsEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      attempts: [
        { id: "0f8fad5b-d9cb-469f-a165-70867728950e", at: "2026-11-22T10:00:00Z", outcome: "failure", ip: FAKE_ATTEMPT_IP,
          user_agent: "FakeBrowser/1.0", replayed: false, credential_ok: UPSTREAM_RAW_MARKER },
      ],
      next_before: "", from: "2026-08-24T12:00:00Z", to: "2026-11-22T12:00:00Z",
      ...overrides,
    },
  };
}

describe("createLoginAttemptsClient — 목록", () => {
  it("GET <base>/auth/attempts · 조건 + limit · X-Observe-Secret · redirect manual", async () => {
    const fetch = createRoutedFetch(() => jsonBody(attemptsEnvelope()));
    const client = createLoginAttemptsClient({ baseUrl: `${FAKE_OBSERVE_URL}/`, secret: FAKE_OBSERVE_SECRET, fetch });
    await client.listAttempts({ from: "2026-11-01T00:00:00Z", to: "2026-11-22T00:00:00Z", before: CURSOR, limit: 20 });
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.pathname).toBe("/auth/attempts");
    expect(Object.fromEntries(url.searchParams)).toEqual({ from: "2026-11-01T00:00:00Z", to: "2026-11-22T00:00:00Z", before: CURSOR, limit: "20" });
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("X-Observe-Secret")).toBe(FAKE_OBSERVE_SECRET);
    expect(init?.redirect).toBe("manual");
  });

  it("칸 선택 — id · at · outcome · ip · userAgent · replayed 만, next_before \"\" → null", async () => {
    const fetch = createRoutedFetch(() => jsonBody(attemptsEnvelope()));
    const page = okValue(await createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).listAttempts(EMPTY_QUERY));
    expect(page).toStrictEqual({
      attempts: [{ id: "0f8fad5b-d9cb-469f-a165-70867728950e", at: "2026-11-22T10:00:00Z", outcome: "failure", ip: FAKE_ATTEMPT_IP,
        userAgent: "FakeBrowser/1.0", replayed: false }],
      nextBefore: null, from: "2026-08-24T12:00:00Z", to: "2026-11-22T12:00:00Z",
    });
    expect(JSON.stringify(page)).not.toContain(UPSTREAM_RAW_MARKER);
  });

  it.each([...LOGIN_ATTEMPT_OUTCOMES])("결과 낱말 %s 를 받는다", async (outcome) => {
    const fetch = createRoutedFetch(() => jsonBody(attemptsEnvelope({ attempts: [{ id: "a", at: "2026-11-22T10:00:00Z", outcome, ip: "x", user_agent: "", replayed: true }] })));
    const page = okValue(await createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).listAttempts(EMPTY_QUERY));
    expect(page.attempts[0].outcome).toBe(outcome);
  });

  it.each([
    ["outcome 열거 밖", { attempts: [{ id: "a", at: "t", outcome: "maybe", ip: "x", user_agent: "", replayed: false }] }],
    ["replayed 가 글자", { attempts: [{ id: "a", at: "t", outcome: "success", ip: "x", user_agent: "", replayed: "false" }] }],
    ["ip 빠짐", { attempts: [{ id: "a", at: "t", outcome: "success", user_agent: "", replayed: false }] }],
    ["attempts 가 배열이 아님", { attempts: "x" }],
    ["next_before 가 숫자", { next_before: 3 }],
  ])("%s → unparseable", async (_label, overrides) => {
    const fetch = createRoutedFetch(() => jsonBody(attemptsEnvelope(overrides)));
    expectFailure(await createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).listAttempts(EMPTY_QUERY), "unparseable");
  });

  it.each([[401, "unauthorized"], [422, "invalid_request"], [503, "unavailable"], [500, "bad_status"]] as const)(
    "HTTP %i → %s(원문 없음)", async (status, reason) => {
      const fetch = createRoutedFetch(() => textResponse(leakyErrorBody(), status));
      expectFailure(await createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).listAttempts(EMPTY_QUERY), reason, status);
    });
});

describe("createLoginAttemptsClient — 잠금 상태", () => {
  it("GET <base>/auth/lock → locked · lockedUntil · failures 만", async () => {
    const fetch = createRoutedFetch(() => jsonBody({ success: true, data: { locked: true, locked_until: "2026-11-22T10:15:00Z", failures: 5, extra: UPSTREAM_RAW_MARKER } }));
    const client = createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch });
    const lock = okValue(await client.readLock());
    expect(lock).toStrictEqual({ locked: true, lockedUntil: "2026-11-22T10:15:00Z", failures: 5 });
    const [input, init] = fetch.mock.calls[0];
    expect(new URL(input).pathname).toBe("/auth/lock");
    expect([...new URL(input).searchParams].length).toBe(0);
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("X-Observe-Secret")).toBe(FAKE_OBSERVE_SECRET);
  });

  it("locked_until null 은 그대로 null", async () => {
    const fetch = createRoutedFetch(() => jsonBody({ success: true, data: { locked: false, locked_until: null, failures: 0 } }));
    expect(okValue(await createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).readLock()))
      .toStrictEqual({ locked: false, lockedUntil: null, failures: 0 });
  });

  it.each([
    ["locked 가 글자", { locked: "true", locked_until: null, failures: 0 }],
    ["failures 가 음수", { locked: false, locked_until: null, failures: -1 }],
    ["failures 빠짐", { locked: false, locked_until: null }],
  ])("%s → unparseable", async (_label, data) => {
    const fetch = createRoutedFetch(() => jsonBody({ success: true, data }));
    expectFailure(await createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).readLock(), "unparseable");
  });

  it("연결 실패 → unreachable", async () => {
    const fetch = createRoutedFetch(() => Promise.reject(leakyNetworkError()));
    expectFailure(await createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).readLock(), "unreachable");
  });
});

describe("createLoginAttemptsClient — 5초 기한(가짜 타이머)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(["listAttempts", "readLock"] as const)("%s — 응답하지 않으면 5초에 timeout, 신호는 5000ms", async (method) => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((_url, init) => hangUntilAborted(init));
    const client = createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch, timeoutSignal: timeout.factory });
    const pending = track<UpstreamResult<unknown>>(method === "listAttempts" ? client.listAttempts(EMPTY_QUERY) : client.readLock());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expectFailure(pending.value!, "timeout");
    expect(timeout.requestedMilliseconds).toEqual([5_000]);
  });
});
