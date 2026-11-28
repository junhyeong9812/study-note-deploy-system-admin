/** 실행 자리의 분석 부르기(명세 ⑫ §13 · §19 — runner/server.py POST /runs 의 계약).
 * 계약:
 * - POST <base>/runs 한 번(다시 보내지 않는다) · 머리 X-Claude-Runner-Secret(호출용 — 설정용 비밀값이 아니다) · Content-Type: application/json ·
 *   본문은 정확히 {"purpose":"analysis","prompt":<글>,"request_id":<요청 ID>} — 인자 · 모델 · 스키마는 보내지 않는다 · redirect manual · no-store ·
 *   기한 ANALYSIS_RUN_TIMEOUT_MILLISECONDS(260초 — 실행 자리의 240초 + 여유).
 * - 프롬프트가 6만 자(코드 포인트)를 넘으면 부르지 않고 prompt_too_long.
 * - 200 + data.answer 를 parseAnalysisAnswer 로 한 번 더 — 틀리면 answer_invalid(저장하지 않는다).
 * - 실패는 고정 낱말만(실행 자리의 글 · 주소 · 예외 문구를 싣지 않는다):
 *   502 invalid_answer · bad_output · claude_failed → 그 낱말 / 그 밖의 502 · 500 → internal / 504 → timeout /
 *   429 busy · limit_reached · disabled → 그 낱말(그 밖의 429 → rejected) / 503 token_missing · claude_unavailable → 그 낱말(그 밖의 503 → runner_unavailable) /
 *   401 → unauthorized / 그 밖의 4xx · 3xx → rejected / 연결을 맺지 못함 → unreachable / 기한 · 보낸 뒤 끊김 · 본문이 JSON 아님 → no_answer. */
import { describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_PROMPT_MAXIMUM_CHARACTERS, ANALYSIS_RUN_TIMEOUT_MILLISECONDS, createAnalysisRunnerClient,
} from "@/features/incident-analysis/lib/analysis-runner-client";
import { CLAUDE_CALL_SECRET_HEADER, FAKE_CLAUDE_RUNNER_CALL_SECRET, runnerFailureBody, runnerSuccessBody, validRunnerAnswer } from "@/features/incident-analysis/lib/analysis-test-fakes";
import { CLAUDE_SETTINGS_HEADER, FAKE_CLAUDE_RUNNER_URL } from "@/features/claude-usage/lib/claude-runner-test-fakes";
import { createRoutedFetch, headersOf, jsonBody, leakyErrorBody, leakyNetworkError, textResponse } from "@/shared/lib/upstream-test-fakes";

function clientWith(respond: (init: RequestInit) => Response | Promise<Response>) {
  const fetch = createRoutedFetch((_url, init) => respond(init));
  const requested: number[] = [];
  const client = createAnalysisRunnerClient({
    baseUrl: FAKE_CLAUDE_RUNNER_URL, callSecret: FAKE_CLAUDE_RUNNER_CALL_SECRET, fetch,
    timeoutSignal: (milliseconds) => { requested.push(milliseconds); return new AbortController().signal; },
  });
  return { client, fetch, requested };
}

describe("부르는 꼴", () => {
  it("POST /runs 한 번 · 호출용 비밀 머리 · 본문은 용도 · 프롬프트 · 요청 ID 셋뿐 · 260초 기한", async () => {
    const { client, fetch, requested } = clientWith(() => jsonBody(runnerSuccessBody()));
    const result = await client.runAnalysis("자료 프롬프트", "adm-analysis-1");
    expect(result).toEqual({ kind: "answered", answer: expect.objectContaining({ recommendedAction: "rollback" }) });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    expect(String(input)).toBe(`${FAKE_CLAUDE_RUNNER_URL}/runs`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    const headers = headersOf(init);
    expect(headers.get(CLAUDE_CALL_SECRET_HEADER)).toBe(FAKE_CLAUDE_RUNNER_CALL_SECRET);
    expect(headers.get(CLAUDE_SETTINGS_HEADER)).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ purpose: "analysis", prompt: "자료 프롬프트", request_id: "adm-analysis-1" });
    expect(requested).toEqual([ANALYSIS_RUN_TIMEOUT_MILLISECONDS]);
    expect(ANALYSIS_RUN_TIMEOUT_MILLISECONDS).toBe(260_000);
  });

  it(`프롬프트 ${ANALYSIS_PROMPT_MAXIMUM_CHARACTERS}자(코드 포인트)는 보내고, 한 자 넘으면 부르지 않는다`, async () => {
    expect(ANALYSIS_PROMPT_MAXIMUM_CHARACTERS).toBe(60_000);
    const inside = clientWith(() => jsonBody(runnerSuccessBody()));
    expect((await inside.client.runAnalysis("😀".repeat(60_000), "r1")).kind).toBe("answered");
    const outside = clientWith(() => jsonBody(runnerSuccessBody()));
    expect(await outside.client.runAnalysis("😀".repeat(60_001), "r1")).toEqual({ kind: "failed", reason: "prompt_too_long" });
    expect(outside.fetch).not.toHaveBeenCalled();
  });
});

describe("200 — 어드민도 다섯 칸을 검증한다", () => {
  it.each([
    ["모르는 칸", validRunnerAnswer({ extra: 1 })], ["목록 밖의 조치", validRunnerAnswer({ recommended_action: "restart" })],
    ["길이 넘침", validRunnerAnswer({ cause: "c".repeat(2001) })], ["형이 틀림", validRunnerAnswer({ evidence: "하나" })], ["답이 null", null],
  ])("%s → answer_invalid", async (_label, answer) => {
    const { client } = clientWith(() => jsonBody(runnerSuccessBody(answer)));
    expect(await client.runAnalysis("p", "r1")).toEqual({ kind: "failed", reason: "answer_invalid" });
  });

  it("봉투가 아니면(success 가 참이 아님 · data 없음) answer_invalid", async () => {
    const { client } = clientWith(() => jsonBody({ success: true }));
    expect(await client.runAnalysis("p", "r1")).toEqual({ kind: "failed", reason: "answer_invalid" });
  });
});

describe("실패 — 저마다 다른 고정 낱말(실행 자리의 글을 싣지 않는다)", () => {
  it.each([
    [502, "invalid_answer", "invalid_answer"], [502, "bad_output", "bad_output"], [502, "claude_failed", "claude_failed"], [502, "something_new", "internal"],
    [500, "internal", "internal"], [504, "timeout", "timeout"],
    [429, "busy", "busy"], [429, "limit_reached", "limit_reached"], [429, "disabled", "disabled"], [429, "other", "rejected"],
    [503, "token_missing", "token_missing"], [503, "claude_unavailable", "claude_unavailable"], [503, "limits_unavailable", "runner_unavailable"],
    [503, "ledger_unavailable", "runner_unavailable"], [401, "unauthorized", "unauthorized"], [422, "prompt_too_long", "rejected"], [422, "unknown_purpose", "rejected"],
    [404, "not_found", "rejected"], [302, "moved", "rejected"],
  ] as const)("%i %s → %s", async (status, code, reason) => {
    const { client } = clientWith(() => jsonBody({ ...runnerFailureBody(code, { scope: "total", detail: leakyErrorBody() }) }, status));
    const result = await client.runAnalysis("p", "r1");
    expect(result).toEqual({ kind: "failed", reason });
  });

  it("오류 본문이 JSON 이 아니어도 상태로 가른다(503 → runner_unavailable · 502 → internal)", async () => {
    expect(await clientWith(() => textResponse(leakyErrorBody(), 503, "text/html")).client.runAnalysis("p", "r1")).toEqual({ kind: "failed", reason: "runner_unavailable" });
    expect(await clientWith(() => textResponse(leakyErrorBody(), 502, "text/html")).client.runAnalysis("p", "r1")).toEqual({ kind: "failed", reason: "internal" });
  });

  it("연결을 맺지 못함 → unreachable", async () => {
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    const { client } = clientWith(() => { throw error; });
    expect(await client.runAnalysis("p", "r1")).toEqual({ kind: "failed", reason: "unreachable" });
  });

  it("기한 · 보낸 뒤 끊김 → no_answer(실행 자리는 한 번을 셌을 수 있다)", async () => {
    const aborted = clientWith(() => { throw new DOMException("The operation was aborted", "TimeoutError"); });
    expect(await aborted.client.runAnalysis("p", "r1")).toEqual({ kind: "failed", reason: "no_answer" });
    const cut = clientWith(() => { throw leakyNetworkError(); });
    expect(await cut.client.runAnalysis("p", "r1")).toEqual({ kind: "failed", reason: "no_answer" });
    const garbled = clientWith(() => textResponse("{not json", 200));
    expect(await garbled.client.runAnalysis("p", "r1")).toEqual({ kind: "failed", reason: "no_answer" });
  });

  it("결과에 실행 자리의 글 · 주소 · 비밀값이 없다", async () => {
    const results = await Promise.all([502, 503, 429, 401, 422].map((status) =>
      clientWith(() => jsonBody(runnerFailureBody("x", { detail: `${leakyErrorBody()} ${FAKE_CLAUDE_RUNNER_URL}` }), status)).client.runAnalysis("p", "r1")));
    const text = JSON.stringify(results);
    for (const word of ["claude-runner.example.test", FAKE_CLAUDE_RUNNER_CALL_SECRET, "detail"]) expect(text).not.toContain(word);
    vi.restoreAllMocks();
  });
});
