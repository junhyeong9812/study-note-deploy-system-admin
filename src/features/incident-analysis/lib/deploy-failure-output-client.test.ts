/** 배포 마스터의 실패 출력 조회(12-2 — ci-cd internal/master/failure_output.go · README "조회") — 읽기 하나.
 * 계약: GET <base>/deploys/<요청 ID>/output 한 번 · X-Deploy-Secret · 5초(기존 getUpstream) · 요청 ID 가 [A-Za-z0-9_-]{1,64} 가 아니면 부르지 않고 invalid_request_id ·
 * 200 의 data(request_id · failed_stage · recorded_at · output · truncated · omitted_bytes)를 그대로(꼴이 틀리면 unparseable — output 의 글은 고치지 않는다) ·
 * 404 output_not_recorded → not_recorded · 404 not_found → not_found · 410 → expired · 409 not_finished · not_failed → 그 낱말 · 500 output_read_failed → read_failed ·
 * 401 → unauthorized · 422 → invalid_request_id · 그 밖의 5xx → unavailable · 닿지 못함 → unreachable · 5초 → timeout. 까닭의 글은 고정(다른 서버의 글을 싣지 않는다). */
import { describe, expect, it } from "vitest";
import {
  DEPLOY_FAILURE_OUTPUT_UNAVAILABLE_REASONS, DEPLOY_FAILURE_OUTPUT_UNAVAILABLE_TEXT, createDeployFailureOutputClient,
} from "@/features/incident-analysis/lib/deploy-failure-output-client";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, createRoutedFetch, createTimerTimeoutSignal, expectNoForbiddenText, expectReadOnlyRequest, hangUntilAborted, headersOf,
  jsonBody, leakyErrorBody, textResponse,
} from "@/shared/lib/upstream-test-fakes";
import { vi } from "vitest";

function outputBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { success: true, data: {
    request_id: "req-failed-1", service: "backend", commit_sha: "b".repeat(40), failed_stage: "ci_test", recorded_at: "2026-11-25T05:30:00.123456789Z",
    output: "go test ./...\n--- FAIL: TestPool\npassword=[가림:secret_field]", truncated: false, omitted_bytes: 0, bytes: 61, redactions: { secret_field: 1 }, ...overrides,
  } };
}

function clientWith(respond: (url: URL, init: RequestInit) => Response | Promise<Response>, timeoutSignal?: ReturnType<typeof createTimerTimeoutSignal>) {
  const fetch = createRoutedFetch(respond);
  return { fetch, client: createDeployFailureOutputClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch, timeoutSignal: timeoutSignal?.factory }) };
}

describe("200 — 가린 출력을 그대로", () => {
  it("GET /deploys/<요청 ID>/output · X-Deploy-Secret · 칸 여섯", async () => {
    const { client, fetch } = clientWith(() => jsonBody(outputBody()));
    expect(await client.readFailureOutput("req-failed-1")).toEqual({ ok: true, output: {
      requestId: "req-failed-1", failedStage: "ci_test", recordedAt: "2026-11-25T05:30:00.123456789Z",
      output: "go test ./...\n--- FAIL: TestPool\npassword=[가림:secret_field]", truncated: false, omittedBytes: 0,
    } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    expect(String(input)).toBe(`${FAKE_DEPLOY_MASTER_URL}/deploys/req-failed-1/output`);
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("x-deploy-secret")).toBe(FAKE_DEPLOY_SECRET);
  });

  it("truncated · omitted_bytes 를 그대로(글 안의 `[가운데 …]` 줄은 보지 않는다)", async () => {
    const { client } = clientWith(() => jsonBody(outputBody({ output: "[가운데 999바이트를 버렸다]\n끝", truncated: false, omitted_bytes: 0 })));
    const result = await client.readFailureOutput("req-failed-1");
    expect(result.ok && result.output.truncated).toBe(false);
    const truncated = await clientWith(() => jsonBody(outputBody({ truncated: true, omitted_bytes: 4096 }))).client.readFailureOutput("req-failed-1");
    expect(truncated.ok && [truncated.output.truncated, truncated.output.omittedBytes]).toEqual([true, 4096]);
  });

  it.each([
    ["output 이 글이 아님", { output: 1 }], ["truncated 가 참거짓이 아님", { truncated: "no" }], ["omitted_bytes 가 음수", { omitted_bytes: -1 }],
    ["failed_stage 가 없음", { failed_stage: undefined }],
  ])("꼴이 틀림(%s) → unparseable", async (_label, overrides) => {
    expect(await clientWith(() => jsonBody(outputBody(overrides))).client.readFailureOutput("req-failed-1")).toEqual({ ok: false, reason: "unparseable" });
  });
});

describe("요청 ID 의 꼴 — 경로를 잇기 전에", () => {
  it.each([["../x"], ["a/b"], [""], ["a".repeat(65)], ["req 1"], ["요청"]])("%j → 부르지 않고 invalid_request_id", async (requestId) => {
    const { client, fetch } = clientWith(() => jsonBody(outputBody()));
    expect(await client.readFailureOutput(requestId)).toEqual({ ok: false, reason: "invalid_request_id" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("얻지 못함 — 저마다 다른 고정 까닭", () => {
  it.each([
    [404, "output_not_recorded", "not_recorded"], [404, "not_found", "not_found"], [410, "output_expired", "expired"], [409, "not_finished", "not_finished"],
    [409, "not_failed", "not_failed"], [500, "output_read_failed", "read_failed"], [401, "unauthorized", "unauthorized"], [422, "invalid_request_id", "invalid_request_id"],
    [503, "busy", "unavailable"], [502, "x", "unavailable"],
  ] as const)("%i %s → %s", async (status, code, reason) => {
    const { client } = clientWith(() => jsonBody({ success: false, error: { code, detail: leakyErrorBody() } }, status));
    const result = await client.readFailureOutput("req-failed-1");
    expect(result).toEqual({ ok: false, reason });
    expectNoForbiddenText(result);
  });

  it("닿지 못함 → unreachable · 5초 → timeout", async () => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    expect(await clientWith(() => { throw refused; }).client.readFailureOutput("req-failed-1")).toEqual({ ok: false, reason: "unreachable" });
    vi.useFakeTimers();
    try {
      const timer = createTimerTimeoutSignal();
      const { client } = clientWith((_url, init) => hangUntilAborted(init), timer);
      const pending = client.readFailureOutput("req-failed-1");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({ ok: false, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("까닭의 글은 까닭마다 다르고 비지 않는다", () => {
    const texts = DEPLOY_FAILURE_OUTPUT_UNAVAILABLE_REASONS.map((reason) => DEPLOY_FAILURE_OUTPUT_UNAVAILABLE_TEXT[reason]);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
    expect(textResponse).toBeDefined();
  });
});
