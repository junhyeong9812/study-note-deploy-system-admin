import { describe, expect, it, vi } from "vitest";
import { OBSERVE_TIMEOUT_MILLISECONDS, createObserveClient } from "@/features/auth/lib/observe-client";
import { FAKE_IP, FAKE_USER_AGENT, createFakeFetch, jsonResponse, type FetchStep } from "@/features/auth/lib/test-fakes";
import type { AttemptRecordBody, RejectedAttemptBody } from "@/features/auth/lib/types";

const BASE_URL = "http://observe.example.test:17000";
const SECRET = "fake-observe-secret";

const ATTEMPT: AttemptRecordBody = {
  attempt_id: "11111111-1111-4111-8111-111111111111",
  at: "2026-01-01T00:00:00.000Z",
  credential_ok: true, ip: FAKE_IP, user_agent: FAKE_USER_AGENT, replayed: false,
};

const REJECTED: RejectedAttemptBody = {
  attempt_id: "22222222-2222-4222-8222-222222222222",
  at: "2026-01-01T00:00:01.000Z",
  reason: "rate_limited", ip: FAKE_IP, user_agent: FAKE_USER_AGENT,
};

const VERDICT_DATA = { allowed: false, outcome: "locked", locked_until: "2026-01-01T00:15:00.000Z", lock_started: true, failures: 5 };

const FIXED_NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

function client(steps: FetchStep[]) {
  const fetch = createFakeFetch(steps);
  const timeoutSignal = vi.fn((milliseconds: number) => new AbortController().signal);
  // 세부 3: 기한을 재는 시계 — 멈춘 시계면 남은 시간은 언제나 5000
  return { fetch, timeoutSignal, observe: createObserveClient({ baseUrl: BASE_URL, secret: SECRET, fetch, timeoutSignal, clock: () => FIXED_NOW }) };
}

/** 신호가 끊길 때까지 응답하지 않는 fetch 단계 — 느린 관측 서버(죽지 않음). */
function hangUntilAborted(controller: AbortController): FetchStep {
  return (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
    queueMicrotask(() => controller.abort());
  });
}

describe("관측 서버 — POST /auth/attempts", () => {
  it("URL · 메서드 · X-Observe-Secret · JSON 본문 · 5초 제한 신호", async () => {
    const { fetch, timeoutSignal, observe } = client([jsonResponse({ success: true, data: VERDICT_DATA })]);
    await observe.recordAttempt(ATTEMPT);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/auth/attempts`);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Observe-Secret")).toBe(SECRET);
    expect(headers.get("Content-Type")).toMatch(/application\/json/);
    expect(JSON.parse(String(init.body))).toEqual(ATTEMPT);
    expect(OBSERVE_TIMEOUT_MILLISECONDS).toBe(5000);
    expect(timeoutSignal).toHaveBeenCalledWith(5000);
    expect(init.signal).toBeDefined();
  });

  it("응답 data 를 판정으로 바꾼다", async () => {
    const { observe } = client([jsonResponse({ success: true, data: VERDICT_DATA })]);
    expect(await observe.recordAttempt(ATTEMPT)).toEqual({
      ok: true,
      value: { allowed: false, outcome: "locked", lockedUntil: "2026-01-01T00:15:00.000Z", lockStarted: true, failures: 5 },
    });
  });

  it("locked_until 이 null 인 판정", async () => {
    const { observe } = client([jsonResponse({ success: true, data: { ...VERDICT_DATA, allowed: true, outcome: "success", locked_until: null, lock_started: false, failures: 0 } })]);
    const result = await observe.recordAttempt(ATTEMPT);
    expect(result).toEqual({ ok: true, value: { allowed: true, outcome: "success", lockedUntil: null, lockStarted: false, failures: 0 } });
  });

  it("첫 호출이 실패하면 같은 attempt_id 로 1회 재시도해 성공", async () => {
    const { fetch, observe } = client([new TypeError("fetch failed"), jsonResponse({ success: true, data: VERDICT_DATA })]);
    const result = await observe.recordAttempt(ATTEMPT);
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1].attempt_id).toBe(ATTEMPT.attempt_id);
  });

  it("성공하면 재시도하지 않는다", async () => {
    const { fetch, observe } = client([jsonResponse({ success: true, data: VERDICT_DATA }), jsonResponse({ success: true, data: VERDICT_DATA })]);
    await observe.recordAttempt(ATTEMPT);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  const outages: [string, () => FetchStep, string][] = [
    ["연결 실패", () => new TypeError("fetch failed: ECONNREFUSED"), "unreachable"],
    ["500", () => jsonResponse({ success: false, error: { code: "internal" } }, 500), "bad_status"],
    ["401(비밀값 불일치)", () => jsonResponse({ success: false, error: { code: "unauthorized" } }, 401), "bad_status"],
    ["302", () => new Response(null, { status: 302, headers: { Location: "/elsewhere" } }), "bad_status"],
    ["JSON 아님", () => new Response("<html>bad gateway</html>", { status: 200 }), "bad_body"],
    ["빈 본문", () => new Response("", { status: 200 }), "bad_body"],
    ["success:false 봉투", () => jsonResponse({ success: false, error: { code: "x" } }, 200), "bad_body"],
    ["data 없음", () => jsonResponse({ success: true }, 200), "bad_body"],
    ["allowed 가 bool 아님", () => jsonResponse({ success: true, data: { ...VERDICT_DATA, allowed: "true" } }), "bad_body"],
    ["outcome 이 모르는 값", () => jsonResponse({ success: true, data: { ...VERDICT_DATA, outcome: "maybe" } }), "bad_body"],
    ["failures 없음", () => jsonResponse({ success: true, data: { ...VERDICT_DATA, failures: undefined } }), "bad_body"],
    ["lock_started 없음", () => jsonResponse({ success: true, data: { ...VERDICT_DATA, lock_started: undefined } }), "bad_body"],
  ];

  it.each(outages)("장애(%s) — 2회 호출 뒤 ok:false", async (_label, makeStep, reason) => {
    const { fetch, observe } = client([makeStep(), makeStep()]);
    const result = await observe.recordAttempt(ATTEMPT);
    expect(result).toMatchObject({ ok: false, reason });   // 세부 3: bad_status 는 status 칸이 더 붙는다
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("시간 초과(느리지만 죽지 않은 관측 서버) — 5초 신호가 끊기면 재시도 없이 바로 timeout(세부 2)", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const fetch = createFakeFetch([hangUntilAborted(first), hangUntilAborted(second)]);
    const signals = [first.signal, second.signal];
    const timeoutSignal = vi.fn((_milliseconds: number) => signals.shift()!);
    const observe = createObserveClient({ baseUrl: BASE_URL, secret: SECRET, fetch, timeoutSignal });
    const result = await observe.recordAttempt(ATTEMPT);
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(timeoutSignal).toHaveBeenCalledTimes(1);
    expect(timeoutSignal).toHaveBeenCalledWith(5000);
  });

  it("fetch 가 TimeoutError 로 거절해도(신호 모양과 무관) 재시도 없이 timeout", async () => {
    const { fetch, observe } = client([new DOMException("timed out", "TimeoutError"), jsonResponse({ success: true, data: VERDICT_DATA })]);
    expect(await observe.recordAttempt(ATTEMPT)).toEqual({ ok: false, reason: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("첫 호출이 연결 실패, 재시도가 시간 초과면 timeout — 호출은 2회에서 끝", async () => {
    const controller = new AbortController();
    const fetch = createFakeFetch([new TypeError("fetch failed"), hangUntilAborted(controller)]);
    const signals = [new AbortController().signal, controller.signal];
    const observe = createObserveClient({ baseUrl: BASE_URL, secret: SECRET, fetch, timeoutSignal: () => signals.shift()! });
    expect(await observe.recordAttempt(ATTEMPT)).toEqual({ ok: false, reason: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejected 기록도 시간 초과면 재시도 없음", async () => {
    const { fetch, observe } = client([new DOMException("timed out", "TimeoutError"), jsonResponse({ success: true, data: {} })]);
    expect(await observe.recordRejected(REJECTED)).toEqual({ ok: false, reason: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("재전송 본문(replayed:true + outcome)은 그대로 보낸다", async () => {
    const { fetch, observe } = client([jsonResponse({ success: true, data: VERDICT_DATA })]);
    const replay = { ...ATTEMPT, replayed: true, outcome: "locked" as const };
    await observe.recordAttempt(replay);
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual(replay);
  });

  it("baseUrl 뒤의 / 는 겹치지 않는다", async () => {
    const fetch = createFakeFetch([jsonResponse({ success: true, data: VERDICT_DATA })]);
    const observe = createObserveClient({ baseUrl: `${BASE_URL}/`, secret: SECRET, fetch, timeoutSignal: () => new AbortController().signal });
    await observe.recordAttempt(ATTEMPT);
    expect(fetch.mock.calls[0][0]).toBe(`${BASE_URL}/auth/attempts`);
  });
});

describe("관측 서버 — POST /auth/attempts/rejected", () => {
  it("URL · 비밀값 · 본문", async () => {
    const { fetch, observe } = client([jsonResponse({ success: true, data: {} })]);
    expect(await observe.recordRejected(REJECTED)).toEqual({ ok: true, value: null });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/auth/attempts/rejected`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-Observe-Secret")).toBe(SECRET);
    expect(JSON.parse(String(init.body))).toEqual(REJECTED);
  });

  it("2xx 아님 → 1회 재시도 뒤 ok:false", async () => {
    const { fetch, observe } = client([jsonResponse({}, 503), jsonResponse({}, 503)]);
    expect((await observe.recordRejected(REJECTED)).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("세부 3 — 관측 판정의 전체 기한 5초(첫 호출 + 재시도)", () => {
  /** 주입한 시계와 신호 — 신호는 요청한 밀리초만큼 시계를 앞당긴 뒤 끊긴다(실제 대기 없음). */
  function deadlineHarness(steps: ((clock: { now: number }) => FetchStep)[]) {
    const clock = { now: FIXED_NOW };
    const requested: number[] = [];
    const timeoutSignal = vi.fn((milliseconds: number) => {
      requested.push(milliseconds);
      const controller = new AbortController();
      if (milliseconds <= 0) controller.abort(new DOMException("timed out", "TimeoutError"));
      return Object.assign(controller.signal, { expireNow: () => { clock.now += Math.max(milliseconds, 0); controller.abort(new DOMException("timed out", "TimeoutError")); } });
    });
    const fetch = createFakeFetch(steps.map((makeStep) => makeStep(clock)));
    return { clock, requested, timeoutSignal, fetch };
  }
  const after = (clock: { now: number }, milliseconds: number, response: () => Response): FetchStep =>
    async () => { clock.now += milliseconds; return response(); };
  const hangUntilExpired: FetchStep = (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal as AbortSignal & { expireNow?: () => void };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", () => reject(signal.reason));
    queueMicrotask(() => signal.expireNow?.());
  });

  it("첫 호출이 4.9초 뒤 503 → 재시도는 남은 시간(≤100ms) 안에서만, 전체 5초(+50ms 여유) 안에 ok:false", async () => {
    const harness = deadlineHarness([
      (clock) => after(clock, 4_900, () => jsonResponse({ success: false }, 503)),
      () => hangUntilExpired,
    ]);
    const observe = createObserveClient({ baseUrl: BASE_URL, secret: SECRET, fetch: harness.fetch, timeoutSignal: harness.timeoutSignal, clock: () => harness.clock.now });
    const result = await observe.recordAttempt(ATTEMPT);
    expect(result.ok).toBe(false);
    expect(harness.requested[0]).toBe(5_000);
    if (harness.requested.length > 1) expect(harness.requested[1]).toBeLessThanOrEqual(100);
    expect(harness.clock.now - FIXED_NOW).toBeLessThanOrEqual(5_050);
  });

  it("첫 호출이 5초를 다 쓰고 503 이면 재시도하지 않는다", async () => {
    const harness = deadlineHarness([
      (clock) => after(clock, 5_000, () => jsonResponse({ success: false }, 503)),
      () => jsonResponse({ success: true, data: VERDICT_DATA }),
    ]);
    const observe = createObserveClient({ baseUrl: BASE_URL, secret: SECRET, fetch: harness.fetch, timeoutSignal: harness.timeoutSignal, clock: () => harness.clock.now });
    expect((await observe.recordAttempt(ATTEMPT)).ok).toBe(false);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });

  it("첫 호출이 빨리 실패하면(10ms 뒤 연결 실패) 남은 시간으로 정상 재시도해 성공", async () => {
    const harness = deadlineHarness([
      (clock) => async () => { clock.now += 10; throw new TypeError("fetch failed"); },
      () => jsonResponse({ success: true, data: VERDICT_DATA }),
    ]);
    const observe = createObserveClient({ baseUrl: BASE_URL, secret: SECRET, fetch: harness.fetch, timeoutSignal: harness.timeoutSignal, clock: () => harness.clock.now });
    expect((await observe.recordAttempt(ATTEMPT)).ok).toBe(true);
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.requested[1]).toBeGreaterThanOrEqual(4_900);
    expect(harness.requested[1]).toBeLessThanOrEqual(4_990);
  });

  it("거절 기록 호출도 같은 기한 — 4.9초 뒤 503 이면 전체 5초(+50ms) 안에 끝", async () => {
    const harness = deadlineHarness([
      (clock) => after(clock, 4_900, () => jsonResponse({ success: false }, 503)),
      () => hangUntilExpired,
    ]);
    const observe = createObserveClient({ baseUrl: BASE_URL, secret: SECRET, fetch: harness.fetch, timeoutSignal: harness.timeoutSignal, clock: () => harness.clock.now });
    expect((await observe.recordRejected(REJECTED)).ok).toBe(false);
    if (harness.requested.length > 1) expect(harness.requested[1]).toBeLessThanOrEqual(100);
    expect(harness.clock.now - FIXED_NOW).toBeLessThanOrEqual(5_050);
  });
});

describe("세부 3 — 실패 결과의 상태 코드", () => {
  it.each([422, 401, 429, 500, 503])("%i → bad_status + status", async (status) => {
    const { observe } = client([jsonResponse({ success: false }, status), jsonResponse({ success: false }, status)]);
    expect(await observe.recordAttempt({ ...ATTEMPT, replayed: true, outcome: "failure" })).toEqual({ ok: false, reason: "bad_status", status });
  });
});
