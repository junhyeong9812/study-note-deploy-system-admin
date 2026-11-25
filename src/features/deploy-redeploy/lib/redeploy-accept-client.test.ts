/** master 접수 클라이언트 — ci-cd internal/master/master.go handleDeploy 의 계약: 본문 {service, commit_sha, request_id, requested_by} ·
 * 202 {request_id, service, state[, duplicate:true]} · 409 deploy_in_progress · 409 request_id_conflict · 422 invalid_requested_by · invalid_sha ·
 * unknown_service · invalid_request · 401 unauthorized. 한 번만 보낸다 · 시간 초과는 "접수 여부 모름"으로 가른다. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS, createRedeployAcceptClient, type RedeployAcceptRequest,
} from "@/features/deploy-redeploy/lib/redeploy-accept-client";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, createTimerTimeoutSignal, expectNoForbiddenText, hangUntilAborted, headersOf, jsonBody, leakyErrorBody,
  leakyNetworkError, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";

const REQUEST: RedeployAcceptRequest = {
  service: "backend", commitSha: "0123456789abcdef0123456789abcdef01234567", requestId: "adm-Fake_Request-01", requestedBy: "admin:fake-admin-id-zq",
};

function failureBody(code: string): string {
  return JSON.stringify({ success: false, error: { code, detail: "raw-upstream-text-marker-zz9" } });
}

function clientWith(respond: (url: string, init: RequestInit) => Promise<Response> | Response, timeoutSignal?: (milliseconds: number) => AbortSignal) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => respond(url, init));
  return { fetch, client: createRedeployAcceptClient({ baseUrl: `${FAKE_DEPLOY_MASTER_URL}/`, secret: FAKE_DEPLOY_SECRET, fetch, timeoutSignal }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("요청", () => {
  it("POST <base>/deploy 한 번 · JSON 본문 네 칸 · X-Deploy-Secret · Content-Type · redirect manual", async () => {
    const { fetch, client } = clientWith(() => jsonBody({ success: true, data: { request_id: REQUEST.requestId, service: "backend", state: "accepted" } }, 202));
    await client.accept(REQUEST);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${FAKE_DEPLOY_MASTER_URL}/deploy`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body))).toEqual({
      service: "backend", commit_sha: REQUEST.commitSha, request_id: REQUEST.requestId, requested_by: "admin:fake-admin-id-zq",
    });
    const headers = headersOf(init);
    expect(headers.get("x-deploy-secret")).toBe(FAKE_DEPLOY_SECRET);
    expect(headers.get("content-type") ?? "").toContain("application/json");
    expect(url).not.toContain(FAKE_DEPLOY_SECRET);
  });
});

describe("답 → 결과(원문을 담지 않는다)", () => {
  it.each([
    ["202 새 접수", () => jsonBody({ success: true, data: { request_id: REQUEST.requestId, service: "backend", state: "accepted" } }, 202),
      { kind: "accepted", requestId: REQUEST.requestId, duplicate: false }],
    ["202 duplicate", () => jsonBody({ success: true, data: { request_id: REQUEST.requestId, service: "backend", state: "ci_running", duplicate: true } }, 202),
      { kind: "accepted", requestId: REQUEST.requestId, duplicate: true }],
    ["202 + 해석 못 하는 본문", () => textResponse("not json", 202), { kind: "accepted", requestId: REQUEST.requestId, duplicate: false }],
    ["409 deploy_in_progress", () => textResponse(failureBody("deploy_in_progress"), 409), { kind: "in_progress" }],
    ["409 request_id_conflict", () => textResponse(failureBody("request_id_conflict"), 409), { kind: "request_id_conflict" }],
    ["422 invalid_requested_by", () => textResponse(failureBody("invalid_requested_by"), 422), { kind: "rejected", code: "invalid_requested_by" }],
    ["422 invalid_sha", () => textResponse(failureBody("invalid_sha"), 422), { kind: "rejected", code: "invalid_sha" }],
    ["422 unknown_service", () => textResponse(failureBody("unknown_service"), 422), { kind: "rejected", code: "unknown_service" }],
    ["422 invalid_request", () => textResponse(failureBody("invalid_request"), 422), { kind: "rejected", code: "invalid_request" }],
    ["422 모르는 코드", () => textResponse(failureBody("brand_new_code"), 422), { kind: "rejected", code: "unexpected" }],
    ["401", () => textResponse(failureBody("unauthorized"), 401), { kind: "rejected", code: "unauthorized" }],
    ["302", () => new Response(null, { status: 302, headers: { Location: "http://elsewhere.example.test/" } }), { kind: "rejected", code: "unexpected" }],
    ["500(기록 실패)", () => textResponse(leakyErrorBody(), 500), { kind: "not_accepted", status: 500 }],
    ["503", () => textResponse(leakyErrorBody(), 503), { kind: "not_accepted", status: 503 }],
    ["연결 실패", () => Promise.reject(leakyNetworkError()), { kind: "not_accepted" }],
    ["AbortError(끊김)", () => Promise.reject(new DOMException("aborted", "AbortError")), { kind: "unknown" }],
    ["TimeoutError", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), { kind: "unknown" }],
  ] as const)("%s", async (_label, respond, expected) => {
    const { fetch, client } = clientWith(respond);
    const result = await client.accept(REQUEST);
    expect(result).toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(1);   // 다시 보내지 않는다
    expectNoForbiddenText(result);
  });
});

describe("기한 — 접수 여부 모름", () => {
  it(`응답하지 않는 master → ${REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS}ms 에 unknown, 그 전에는 끝나지 않는다 · 한 번만 보낸다`, async () => {
    vi.useFakeTimers();
    const timer = createTimerTimeoutSignal();
    const { fetch, client } = clientWith((_url, init) => hangUntilAborted(init), timer.factory);
    const pending = track(client.accept(REQUEST));
    await vi.advanceTimersByTimeAsync(REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS - 1);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expect(pending.value).toEqual({ kind: "unknown" });
    expect(timer.requestedMilliseconds).toEqual([REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("기한은 10초", () => {
    expect(REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS).toBe(10_000);
  });
});
