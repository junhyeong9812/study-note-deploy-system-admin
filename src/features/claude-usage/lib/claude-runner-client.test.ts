/** Claude 실행 자리 클라이언트 — 실행 자리 README 의 API 절(GET /usage · GET /limits · PUT /limits · GET /health) 그대로.
 * 읽기: 설정용 비밀값은 머리글로만(헬스에는 없음) · 실패는 고정 사유(원문 · 주소 · 비밀값 없음) · 꼴이 틀리면 unparseable(조용한 0 금지).
 * 쓰기: PUT 한 번 · 결과의 네 갈래(바뀜 · 거절 · 바뀌지 않음 · 모름) — 모름은 다시 보내지 않는다. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_LIMITS_PUT_TIMEOUT_MILLISECONDS, createClaudeRunnerClient, type ClaudeLimitsReplaceResult,
} from "@/features/claude-usage/lib/claude-runner-client";
import type { ClaudeLimitsChange } from "@/features/claude-usage/lib/claude-limits";
import {
  CLAUDE_FORBIDDEN_IN_RESULTS, CLAUDE_SETTINGS_HEADER, FAKE_CLAUDE_RUNNER_SETTINGS_SECRET, FAKE_CLAUDE_RUNNER_URL, createFakeClaudeRunner,
  defaultRunnerLimits, runnerCall, runnerUsageData, type FakeClaudeRunner,
} from "@/features/claude-usage/lib/claude-runner-test-fakes";
import { bodyCutResponse, fetchFailureWithoutCause, undiciFetchFailure } from "@/features/deploy-redeploy/lib/redeploy-test-fakes";
import { UPSTREAM_TIMEOUT_MILLISECONDS } from "@/shared/lib/upstream-result";
import {
  createTimerTimeoutSignal, expectFailure, expectNoForbiddenText, hangUntilAborted, headersThenStalledBody, jsonBody, leakyErrorBody, leakyNetworkError,
  okValue, textResponse,
} from "@/shared/lib/upstream-test-fakes";

function clientFor(runner: FakeClaudeRunner, timeoutSignal?: (milliseconds: number) => AbortSignal) {
  return createClaudeRunnerClient({
    baseUrl: `${FAKE_CLAUDE_RUNNER_URL}/`, settingsSecret: FAKE_CLAUDE_RUNNER_SETTINGS_SECRET,
    fetch: (input, init) => runner.fetch(input, init), timeoutSignal,
  });
}

const CHANGE: ClaudeLimitsChange = { enabled: false, total: { perDay: 20, perHour: 5 }, purposes: { chat: { perDay: 15, perHour: 4 } } };

afterEach(() => {
  vi.useRealTimers();
});

describe("readUsage — GET /usage", () => {
  it("설정용 비밀값을 머리글로 · GET · 본문 없음 · 주소에 비밀값 없음 · 실행 자리의 수를 그대로 옮긴다", async () => {
    const runner = createFakeClaudeRunner();
    runner.counts = { total: { today: 7, last_hour: 2 }, purposes: { chat: { today: 6, last_hour: 1 } } };
    runner.limits = defaultRunnerLimits({ total: { per_day: 40, per_hour: 12 }, purposes: { chat: { per_day: 25, per_hour: 8 } } });
    runner.recent = [
      runnerCall(),
      runnerCall({ request_id: "req-124", result: "limit_reached", duration_ms: 0, usage: null }),
      runnerCall({ request_id: "req-125", usage: { input_tokens: 5, output_tokens: null, cache_creation_input_tokens: "x" } }),
    ];
    const usage = okValue(await clientFor(runner).readUsage());
    expect(usage).toEqual({
      now: "2026-11-26T13:10:00+09:00", dayStartedAt: "2026-11-26T00:00:00+09:00", enabled: true,
      total: { today: 7, lastHour: 2, perDay: 40, perHour: 12 },
      purposes: { chat: { today: 6, lastHour: 1, perDay: 25, perHour: 8 } },
      recent: [
        { startedAt: "2026-11-26T13:05:00+09:00", requestId: "req-123", purpose: "chat", result: "succeeded", durationMs: 8123,
          usage: { inputTokens: 11, outputTokens: 22, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 } },
        { startedAt: "2026-11-26T13:05:00+09:00", requestId: "req-124", purpose: "chat", result: "limit_reached", durationMs: 0, usage: null },
        { startedAt: "2026-11-26T13:05:00+09:00", requestId: "req-125", purpose: "chat", result: "succeeded", durationMs: 8123,
          usage: { inputTokens: 5, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null } },
      ],
    });
    const [request] = runner.calls("GET", "/usage");
    expect(request.url.toString()).toBe(`${FAKE_CLAUDE_RUNNER_URL}/usage`);
    expect(request.headers.get(CLAUDE_SETTINGS_HEADER)).toBe(FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
    expect(request.body).toBeNull();
    const [, init] = runner.fetch.mock.calls[0];
    expect(init?.redirect).toBe("manual");
    expect(runner.requests).toHaveLength(1);
  });

  it("용도 목록은 응답에서 — 모르는 용도(analysis)도 응답의 차례대로 옮긴다 · 8개까지 받는다", async () => {
    const runner = createFakeClaudeRunner();
    runner.limits = defaultRunnerLimits({ purposes: { chat: { per_day: 30, per_hour: 10 }, analysis: { per_day: 6, per_hour: 2 } } });
    runner.counts = { total: { today: 5, last_hour: 2 }, purposes: { chat: { today: 3, last_hour: 1 }, analysis: { today: 2, last_hour: 1 } } };
    const usage = okValue(await clientFor(runner).readUsage());
    expect(usage.purposes).toEqual({ chat: { today: 3, lastHour: 1, perDay: 30, perHour: 10 }, analysis: { today: 2, lastHour: 1, perDay: 6, perHour: 2 } });
    expect(Object.keys(usage.purposes)).toEqual(["chat", "analysis"]);
    runner.limits = defaultRunnerLimits({ purposes: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`p${index + 1}`, { per_day: 1, per_hour: 1 }])) });
    expect(Object.keys(okValue(await clientFor(runner).readUsage()).purposes)).toHaveLength(8);
  });

  it.each([
    ["401(비밀값 거절)", () => jsonBody({ success: false, error: { code: "unauthorized" } }, 401), "unauthorized", 401],
    ["503 ledger_unavailable", () => textResponse(leakyErrorBody(), 503), "unavailable", 503],
    ["500", () => textResponse(leakyErrorBody(), 500), "bad_status", 500],
    ["302(따라가지 않는다)", () => new Response(null, { status: 302, headers: { Location: "http://elsewhere.example.test/" } }), "bad_status", 302],
    ["200 인데 JSON 이 아님", () => textResponse(`<html>${leakyErrorBody()}</html>`, 200, "text/html"), "unparseable", undefined],
    ["200 인데 success 가 거짓", () => jsonBody({ success: false, data: {} }), "unparseable", undefined],
  ] as const)("%s → %s(원문 없음)", async (_label, respond, reason, status) => {
    const runner = createFakeClaudeRunner();
    runner.override["GET /usage"] = () => respond();
    const result = await clientFor(runner).readUsage();
    expectFailure(result, reason, status);
    expectNoForbiddenText(result, CLAUDE_FORBIDDEN_IN_RESULTS);
  });

  /** 건수가 0 처럼 보일 수 있는 꼴 — 0 으로 메우지 않고 unparseable. */
  const brokenUsage: [string, (data: Record<string, unknown>) => void][] = [
    ["total.today 없음", (data) => { delete (data.total as Record<string, unknown>).today; }],
    ["total.last_hour 가 null", (data) => { (data.total as Record<string, unknown>).last_hour = null; }],
    ["total.per_day 가 글자", (data) => { (data.total as Record<string, unknown>).per_day = "30"; }],
    ["음수 건수", (data) => { (data.total as Record<string, unknown>).today = -1; }],
    ["소수 건수", (data) => { (data.total as Record<string, unknown>).today = 1.5; }],
    ["purposes 가 비었음(용도 0개)", (data) => { data.purposes = {}; }],
    ["purposes 가 배열", (data) => { data.purposes = [{ today: 0, last_hour: 0, per_day: 1, per_hour: 1 }]; }],
    ["용도 이름이 꼴 밖(대문자)", (data) => { (data.purposes as Record<string, unknown>).Study = { today: 0, last_hour: 0, per_day: 1, per_hour: 1 }; }],
    ["용도 이름이 꼴 밖(태그)", (data) => { (data.purposes as Record<string, unknown>)["<b>x</b>"] = { today: 0, last_hour: 0, per_day: 1, per_hour: 1 }; }],
    ["용도가 9개", (data) => { for (let index = 1; index <= 8; index += 1) (data.purposes as Record<string, unknown>)[`p${index}`] = { today: 0, last_hour: 0, per_day: 1, per_hour: 1 }; }],
    ["새 용도의 건수가 빠짐", (data) => { (data.purposes as Record<string, unknown>).analysis = { per_day: 1, per_hour: 1 }; }],
    ["purposes.chat.today 없음", (data) => { delete ((data.purposes as Record<string, Record<string, unknown>>).chat).today; }],
    ["enabled 가 글자", (data) => { data.enabled = "true"; }],
    ["recent 가 배열이 아님", (data) => { data.recent = null; }],
    ["recent 의 duration_ms 가 글자", (data) => { (data.recent as Record<string, unknown>[])[0].duration_ms = "8123"; }],
    ["now 없음", (data) => { delete data.now; }],
  ];
  for (const [label, breakData] of brokenUsage) {
    it(`꼴이 틀림 — ${label} → unparseable`, async () => {
      const runner = createFakeClaudeRunner();
      runner.override["GET /usage"] = () => {
        const data = runnerUsageData(runner.limits, runner.counts, [runnerCall()]) as unknown as Record<string, unknown>;
        breakData(data);
        return jsonBody({ success: true, data });
      };
      expectFailure(await clientFor(runner).readUsage(), "unparseable");
    });
  }

  it("연결 실패 → unreachable(예외 문구 없음)", async () => {
    const runner = createFakeClaudeRunner();
    runner.override["GET /usage"] = () => Promise.reject(leakyNetworkError());
    const result = await clientFor(runner).readUsage();
    expectFailure(result, "unreachable");
    expectNoForbiddenText(result, CLAUDE_FORBIDDEN_IN_RESULTS);
  });

  it("5초 안에 답하지 않으면 timeout — 머리글만 주고 본문을 끝내지 않아도", async () => {
    vi.useFakeTimers();
    for (const stall of [(init: RequestInit) => hangUntilAborted(init), (init: RequestInit) => Promise.resolve(headersThenStalledBody(init))]) {
      const runner = createFakeClaudeRunner();
      runner.override["GET /usage"] = (_url, init) => stall(init);
      const timer = createTimerTimeoutSignal();
      const pending = clientFor(runner, timer.factory).readUsage();
      await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MILLISECONDS);
      expectFailure(await pending, "timeout");
      expect(timer.requestedMilliseconds).toEqual([UPSTREAM_TIMEOUT_MILLISECONDS]);
    }
  });
});

describe("readLimits — GET /limits", () => {
  it("설정용 비밀값을 머리글로 · 실행 자리의 값 그대로(바꾼 적 없으면 changedAt · changedBy null)", async () => {
    const runner = createFakeClaudeRunner();
    expect(okValue(await clientFor(runner).readLimits())).toEqual({
      enabled: true, total: { perDay: 30, perHour: 10 }, purposes: { chat: { perDay: 30, perHour: 10 } }, changedAt: null, changedBy: null,
    });
    runner.limits = defaultRunnerLimits({ enabled: false, changed_at: "2026-11-26T12:00:00+09:00", changed_by: "admin:fake-admin-id-zq" });
    expect(okValue(await clientFor(runner).readLimits())).toMatchObject({
      enabled: false, changedAt: "2026-11-26T12:00:00+09:00", changedBy: "admin:fake-admin-id-zq",
    });
    for (const request of runner.calls("GET", "/limits")) expect(request.headers.get(CLAUDE_SETTINGS_HEADER)).toBe(FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
  });

  it("용도 목록은 응답에서 — chat 이 없고 analysis 만 있어도 받는다", async () => {
    const runner = createFakeClaudeRunner();
    runner.limits = defaultRunnerLimits({ purposes: { analysis: { per_day: 6, per_hour: 2 } } });
    expect(okValue(await clientFor(runner).readLimits()).purposes).toEqual({ analysis: { perDay: 6, perHour: 2 } });
  });

  it.each([
    ["purposes 가 비었음", { purposes: {} }],
    ["용도 이름이 꼴 밖(숫자로 시작)", { purposes: { chat: { per_day: 1, per_hour: 1 }, "2nd": { per_day: 1, per_hour: 1 } } }],
    ["용도 이름이 33자", { purposes: { ["a".repeat(33)]: { per_day: 1, per_hour: 1 } } }],
    ["용도의 per_day 없음", { purposes: { chat: { per_day: 1, per_hour: 1 }, analysis: { per_hour: 1 } } }],
    ["total.per_hour 가 글자", { total: { per_day: 30, per_hour: "10" } }],
    ["enabled 없음", { enabled: undefined }],
    ["changed_by 가 수", { changed_by: 5 }],
  ] as [string, Record<string, unknown>][])("꼴이 틀림 — %s → unparseable", async (_label, overrides) => {
    const runner = createFakeClaudeRunner();
    runner.override["GET /limits"] = () => jsonBody({ success: true, data: { ...defaultRunnerLimits(), ...overrides } });
    expectFailure(await clientFor(runner).readLimits(), "unparseable");
  });

  it("503 limits_unavailable → unavailable · 401 → unauthorized", async () => {
    const runner = createFakeClaudeRunner();
    runner.override["GET /limits"] = () => jsonBody({ success: false, error: { code: "limits_unavailable" } }, 503);
    expectFailure(await clientFor(runner).readLimits(), "unavailable", 503);
    runner.override["GET /limits"] = () => jsonBody({ success: false, error: { code: "unauthorized" } }, 401);
    expectFailure(await clientFor(runner).readLimits(), "unauthorized", 401);
  });
});

describe("readHealth — GET /health(인증 없음 · 봉투 없음)", () => {
  it.each(["ok", "token_missing", "claude_unavailable", "ledger_unavailable"] as const)("status %s → 그 상태(200 · 503 모두 읽는다)", async (status) => {
    const runner = createFakeClaudeRunner();
    runner.healthStatus = status;
    expect(okValue(await clientFor(runner).readHealth())).toEqual({ status });
  });

  it("헬스에는 비밀 머리글을 싣지 않는다", async () => {
    const runner = createFakeClaudeRunner();
    await clientFor(runner).readHealth();
    const [request] = runner.calls("GET", "/health");
    expect(request.headers.get(CLAUDE_SETTINGS_HEADER)).toBeNull();
    expect(JSON.stringify([...request.headers])).not.toContain(FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
  });

  it.each([
    ["503 인데 모르는 status", () => jsonBody({ status: "melting" }, 503), "unavailable"],
    ["503 인데 JSON 이 아님", () => textResponse(leakyErrorBody().slice(3), 503), "unavailable"],
    ["200 인데 status 가 ok 가 아님", () => jsonBody({ status: "token_missing" }, 200), "unparseable"],
    ["200 인데 status 없음", () => jsonBody({ ok: true }, 200), "unparseable"],
    ["연결 실패", () => Promise.reject(leakyNetworkError()), "unreachable"],
  ] as const)("%s → %s", async (_label, respond, reason) => {
    const runner = createFakeClaudeRunner();
    runner.override["GET /health"] = () => respond();
    const result = await clientFor(runner).readHealth();
    expectFailure(result, reason);
    expectNoForbiddenText(result, CLAUDE_FORBIDDEN_IN_RESULTS);
  });
});

describe("replaceLimits — PUT /limits 한 번", () => {
  it("본문은 실행 자리의 꼴(칸 넷 — snake_case) · 비밀값은 머리글로만 · JSON · redirect manual", async () => {
    const runner = createFakeClaudeRunner();
    const result = await clientFor(runner).replaceLimits(CHANGE, "admin:fake-admin-id-zq");
    expect(runner.calls("PUT", "/limits")).toHaveLength(1);
    const [request] = runner.calls("PUT", "/limits");
    expect(request.url.toString()).toBe(`${FAKE_CLAUDE_RUNNER_URL}/limits`);
    expect(request.body).toEqual({
      enabled: false, total: { per_day: 20, per_hour: 5 }, purposes: { chat: { per_day: 15, per_hour: 4 } }, changed_by: "admin:fake-admin-id-zq",
    });
    expect(request.headers.get(CLAUDE_SETTINGS_HEADER)).toBe(FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
    expect(request.headers.get("content-type") ?? "").toContain("application/json");
    expect(JSON.stringify(request.body)).not.toContain(FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
    expect(runner.fetch.mock.calls[0][1]?.redirect).toBe("manual");
    expect(result).toEqual({
      kind: "replaced",
      limits: { enabled: false, total: { perDay: 20, perHour: 5 }, purposes: { chat: { perDay: 15, perHour: 4 } },
        changedAt: "2026-11-26T13:11:00+09:00", changedBy: "admin:fake-admin-id-zq" },
    });
  });

  it("용도 둘 — 본문의 purposes 는 바꿀 값의 용도 그대로(chat · analysis)", async () => {
    const runner = createFakeClaudeRunner();
    runner.purposeNames = ["chat", "analysis"];
    const twoPurposes: ClaudeLimitsChange = { ...CHANGE, purposes: { chat: { perDay: 15, perHour: 4 }, analysis: { perDay: 3, perHour: 1 } } };
    const result = await clientFor(runner).replaceLimits(twoPurposes, "admin:fake-admin-id-zq");
    expect(runner.calls("PUT", "/limits")[0].body).toMatchObject({ purposes: { chat: { per_day: 15, per_hour: 4 }, analysis: { per_day: 3, per_hour: 1 } } });
    expect(result).toMatchObject({ kind: "replaced", limits: { purposes: { chat: { perDay: 15, perHour: 4 }, analysis: { perDay: 3, perHour: 1 } } } });
  });

  it("바뀜의 값은 실행 자리가 돌려준 것 — 보낸 값이 아니다", async () => {
    const runner = createFakeClaudeRunner();
    runner.override["PUT /limits"] = () => jsonBody({ success: true, data: defaultRunnerLimits({
      enabled: true, total: { per_day: 25, per_hour: 6 }, changed_at: "2026-11-26T13:12:00+09:00", changed_by: "admin:fake-admin-id-zq",
    }) });
    const result = await clientFor(runner).replaceLimits(CHANGE, "admin:fake-admin-id-zq");
    expect(result).toMatchObject({ kind: "replaced", limits: { enabled: true, total: { perDay: 25, perHour: 6 }, purposes: { chat: { perDay: 30, perHour: 10 } } } });
  });

  const outcomes: [string, () => Response | Promise<Response>, ClaudeLimitsReplaceResult][] = [
    ["422 invalid_limits", () => jsonBody({ success: false, error: { code: "invalid_limits" } }, 422), { kind: "rejected", code: "invalid_limits" }],
    ["422 invalid_changed_by", () => jsonBody({ success: false, error: { code: "invalid_changed_by" } }, 422), { kind: "rejected", code: "invalid_changed_by" }],
    ["422 unknown_field(detail 은 싣지 않는다)", () => jsonBody({ success: false, error: { code: "unknown_field", detail: "secret_field" } }, 422), { kind: "rejected", code: "unknown_field" }],
    ["422 invalid_body", () => jsonBody({ success: false, error: { code: "invalid_body" } }, 422), { kind: "rejected", code: "invalid_body" }],
    ["422 모르는 code", () => textResponse(leakyErrorBody(), 422), { kind: "rejected", code: "unexpected" }],
    ["401", () => jsonBody({ success: false, error: { code: "unauthorized" } }, 401), { kind: "rejected", code: "unauthorized" }],
    ["404", () => jsonBody({ success: false, error: { code: "not_found" } }, 404), { kind: "rejected", code: "unexpected" }],
    ["503 limits_unavailable", () => jsonBody({ success: false, error: { code: "limits_unavailable" } }, 503), { kind: "not_replaced", status: 503 }],
    ["500", () => textResponse(leakyErrorBody(), 500), { kind: "not_replaced", status: 500 }],
    ["ECONNREFUSED", () => Promise.reject(undiciFetchFailure("ECONNREFUSED")), { kind: "not_replaced" }],
    ["ENOTFOUND", () => Promise.reject(undiciFetchFailure("ENOTFOUND")), { kind: "not_replaced" }],
    ["UND_ERR_CONNECT_TIMEOUT", () => Promise.reject(undiciFetchFailure("UND_ERR_CONNECT_TIMEOUT")), { kind: "not_replaced" }],
    ["보낸 뒤 끊김(UND_ERR_SOCKET)", () => Promise.reject(undiciFetchFailure("UND_ERR_SOCKET")), { kind: "unknown" }],
    ["ECONNRESET", () => Promise.reject(undiciFetchFailure("ECONNRESET")), { kind: "unknown" }],
    ["cause 없는 TypeError", () => Promise.reject(fetchFailureWithoutCause()), { kind: "unknown" }],
    ["200 인데 본문을 읽다 끊김", () => bodyCutResponse(200), { kind: "unknown" }],
    ["200 인데 JSON 이 아님", () => textResponse("<html>ok</html>", 200, "text/html"), { kind: "unknown" }],
    ["200 인데 data 의 꼴이 틀림", () => jsonBody({ success: true, data: { enabled: true } }), { kind: "unknown" }],
  ];
  for (const [label, respond, expected] of outcomes) {
    it(`${label} → ${expected.kind} · PUT 한 번 · 원문 없음`, async () => {
      const runner = createFakeClaudeRunner();
      runner.override["PUT /limits"] = () => respond();
      const result = await clientFor(runner).replaceLimits(CHANGE, "admin:fake-admin-id-zq");
      expect(result).toEqual(expected);
      expect(runner.calls("PUT", "/limits")).toHaveLength(1);
      expect(runner.requests).toHaveLength(1);
      expectNoForbiddenText(result, [...CLAUDE_FORBIDDEN_IN_RESULTS, "secret_field"]);
    });
  }

  it(`${CLAUDE_LIMITS_PUT_TIMEOUT_MILLISECONDS}ms 안에 답하지 않으면 unknown — 다시 보내지 않는다`, async () => {
    vi.useFakeTimers();
    expect(CLAUDE_LIMITS_PUT_TIMEOUT_MILLISECONDS).toBe(10_000);
    const runner = createFakeClaudeRunner();
    runner.override["PUT /limits"] = (_url, init) => hangUntilAborted(init);
    const timer = createTimerTimeoutSignal();
    const pending = clientFor(runner, timer.factory).replaceLimits(CHANGE, "admin:fake-admin-id-zq");
    await vi.advanceTimersByTimeAsync(CLAUDE_LIMITS_PUT_TIMEOUT_MILLISECONDS);
    expect(await pending).toEqual({ kind: "unknown" });
    expect(timer.requestedMilliseconds).toEqual([CLAUDE_LIMITS_PUT_TIMEOUT_MILLISECONDS]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.calls("PUT", "/limits")).toHaveLength(1);
  });

  it("머리글만 주고 본문을 끝내지 않으면(200) 기한에 unknown", async () => {
    vi.useFakeTimers();
    const runner = createFakeClaudeRunner();
    runner.override["PUT /limits"] = (_url, init) => headersThenStalledBody(init, 200);
    const timer = createTimerTimeoutSignal();
    const pending = clientFor(runner, timer.factory).replaceLimits(CHANGE, "admin:fake-admin-id-zq");
    await vi.advanceTimersByTimeAsync(CLAUDE_LIMITS_PUT_TIMEOUT_MILLISECONDS);
    expect(await pending).toEqual({ kind: "unknown" });
    expect(runner.calls("PUT", "/limits")).toHaveLength(1);
  });
});
