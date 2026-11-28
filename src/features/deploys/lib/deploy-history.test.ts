/** 배포 이력 — 명세 ② 화면 "master GET /deploys — 서비스 선택, 최신순, 상태 · 커밋 · 실패 단계 · 걸린 시간" ·
 * 세부 "목록 화면의 건수 상한은 어드민 서버 쪽에서도 강제" · "다른 서버의 응답은 서버 쪽에서 화면에 필요한 칸만 골라 넘긴다" ·
 * "한 곳이 죽어도 … 상태 코드와 짧은 사유만" · "각각 5초" · 읽기 전용(GET 만). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import {
  DEPLOY_HISTORY_DEFAULT_LIMIT, DEPLOY_HISTORY_MAXIMUM_LIMIT, DEPLOY_SERVICES, parseDeployHistoryQuery,
} from "@/features/deploys/lib/deploy-history-query";
import { UPSTREAM_FAILURE_MESSAGES } from "@/shared/lib/upstream-result";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal,
  expectFailure, expectNoForbiddenText, expectReadOnlyRequest, hangUntilAborted, headersOf, headersThenStalledBody,
  jsonBody, leakyErrorBody, leakyNetworkError, okValue, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";

const MASTER_LIMIT = 200;   // ci-cd internal/master/master.go:342

function deploymentRow(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "request-id-1", service: "backend", commit_sha: "0123456789abcdef0123456789abcdef01234567",
    state: "failed", failed_stage: "ci_test", detail: `${UPSTREAM_RAW_MARKER} build output tail`,
    accepted_at: "2026-11-22T01:00:00Z", finished_at: "2026-11-22T01:05:00Z", ci_ms: 120000, cd_ms: 0,
    ...overrides,
  };
}

function envelope(deployments: unknown) {
  return { success: true, data: { deployments } };
}

describe("parseDeployHistoryQuery — 입력 검증(호출 전에 거절)", () => {
  it("아무것도 없으면 전체 서비스 · 기본 50건", () => {
    expect(parseDeployHistoryQuery({})).toEqual({ ok: true, query: { service: null, limit: DEPLOY_HISTORY_DEFAULT_LIMIT } });
    expect(DEPLOY_HISTORY_DEFAULT_LIMIT).toBe(50);
  });

  it("빈 service 는 전체", () => {
    expect(parseDeployHistoryQuery({ service: "" })).toEqual({ ok: true, query: { service: null, limit: 50 } });
  });

  it.each([...DEPLOY_SERVICES])("허용 목록의 %s 는 그대로", (service) => {
    expect(parseDeployHistoryQuery({ service, limit: "20" })).toEqual({ ok: true, query: { service, limit: 20 } });
  });

  it("허용 목록은 master 의 열거(front·backend·llm·alert·observe)를 모두 담는다", () => {
    for (const service of ["front", "backend", "llm", "alert", "observe"]) expect(DEPLOY_SERVICES).toContain(service);
  });

  it.each([
    "unknown", "Front", "BACKEND", " front", "front ", "front;drop", "../front", "front&limit=1", "a".repeat(41), "프론트",
  ])("허용 목록 밖 · 형식이 틀린 service %j → invalid_input(service)", (service) => {
    const result = parseDeployHistoryQuery({ service });
    expectFailure(result, "invalid_input");
    expect(!result.ok && result.field).toBe("service");
  });

  it("같은 이름이 여러 번(배열)이면 거절", () => {
    const result = parseDeployHistoryQuery({ service: ["front", "backend"] });
    expectFailure(result, "invalid_input");
    expect(!result.ok && result.field).toBe("service");
  });

  it("어드민의 건수 상한은 master 의 상한 이하", () => {
    expect(DEPLOY_HISTORY_MAXIMUM_LIMIT).toBeLessThanOrEqual(MASTER_LIMIT);
    expect(parseDeployHistoryQuery({ limit: String(DEPLOY_HISTORY_MAXIMUM_LIMIT) })).toEqual({
      ok: true, query: { service: null, limit: DEPLOY_HISTORY_MAXIMUM_LIMIT },
    });
    expect(parseDeployHistoryQuery({ limit: "1" })).toEqual({ ok: true, query: { service: null, limit: 1 } });
  });

  it.each(["0", "-1", String(DEPLOY_HISTORY_MAXIMUM_LIMIT + 1), "100000", "1.5", "abc", "1e2", " 5", "5 ", "0x10", "+5"])(
    "범위 밖 · 정수 글자가 아닌 limit %j → invalid_input(limit)", (limit) => {
      const result = parseDeployHistoryQuery({ limit });
      expectFailure(result, "invalid_input");
      expect(!result.ok && result.field).toBe("limit");
    });

  it("limit 배열도 거절", () => {
    const result = parseDeployHistoryQuery({ limit: ["5", "6"] });
    expectFailure(result, "invalid_input");
  });
});

describe("createDeployHistoryClient — 요청", () => {
  it("GET <base>/deploys?service=&limit= · X-Deploy-Secret · redirect manual · 본문 없음(끝의 / 허용)", async () => {
    const fetch = createRoutedFetch(() => jsonBody(envelope([])));
    const client = createDeployHistoryClient({ baseUrl: `${FAKE_DEPLOY_MASTER_URL}/`, secret: FAKE_DEPLOY_SECRET, fetch });
    await client.listDeployments({ service: "front", limit: 20 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.origin).toBe(new URL(FAKE_DEPLOY_MASTER_URL).origin);
    expect(url.pathname).toBe("/deploys");
    expect([...url.searchParams]).toEqual(expect.arrayContaining([["service", "front"], ["limit", "20"]]));
    expect([...url.searchParams].length).toBe(2);
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("X-Deploy-Secret")).toBe(FAKE_DEPLOY_SECRET);
    expect(headersOf(init).get("X-Observe-Secret")).toBeNull();
    expect(headersOf(init).get("X-Alert-Secret")).toBeNull();
    expect(init?.redirect).toBe("manual");
  });

  it("service 가 null 이면 service 인자를 보내지 않는다", async () => {
    const fetch = createRoutedFetch(() => jsonBody(envelope([])));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    await client.listDeployments({ service: null, limit: 50 });
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.has("service")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("제한 시간 신호를 5000ms 로 만들어 fetch 에 넘긴다", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch(() => jsonBody(envelope([])));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch, timeoutSignal: timeout.factory });
    await client.listDeployments({ service: null, limit: 50 });
    expect(timeout.requestedMilliseconds).toEqual([5_000]);
    expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("createDeployHistoryClient — 응답에서 화면에 필요한 칸만", () => {
  it("요청 ID · 상태 · 서비스 · 커밋 · 실패 단계 · 접수/종료 시각 · 걸린 시간만 — detail · 봉투는 넘기지 않는다", async () => {
    const fetch = createRoutedFetch(() => jsonBody(envelope([deploymentRow()])));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    const deployments = okValue(await client.listDeployments({ service: null, limit: 50 }));
    expect(deployments).toStrictEqual([{
      requestId: "request-id-1", state: "failed", service: "backend", commitSha: "0123456789abcdef0123456789abcdef01234567", failedStage: "ci_test",
      acceptedAt: "2026-11-22T01:00:00Z", finishedAt: "2026-11-22T01:05:00Z", integrationMilliseconds: 120000, deliveryMilliseconds: 0,
      requestedBy: null,
    }]);
    const serialized = JSON.stringify(deployments);
    expect(serialized).not.toContain(UPSTREAM_RAW_MARKER);
    expect(serialized).not.toContain("success");
  });

  it("failed_stage · finished_at 이 빠졌거나(omitempty) 빈 글자면 null — 진행 중인 건", async () => {
    const running = deploymentRow({ state: "ci_running", ci_ms: 0 });
    delete (running as Record<string, unknown>).failed_stage;
    delete (running as Record<string, unknown>).finished_at;
    delete (running as Record<string, unknown>).detail;
    const fetch = createRoutedFetch(() => jsonBody(envelope([running, deploymentRow({ state: "succeeded", failed_stage: "", finished_at: "" })])));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    const deployments = okValue(await client.listDeployments({ service: null, limit: 50 }));
    expect(deployments.map((deployment) => [deployment.state, deployment.failedStage, deployment.finishedAt])).toEqual([
      ["ci_running", null, null], ["succeeded", null, null],
    ]);
  });

  it("master 가 준 순서(최신순)를 그대로 둔다", async () => {
    const rows = ["2026-11-22T03:00:00Z", "2026-11-22T02:00:00Z", "2026-11-22T01:00:00Z"].map((acceptedAt, index) =>
      deploymentRow({ accepted_at: acceptedAt, commit_sha: `sha${index}` }));
    const fetch = createRoutedFetch(() => jsonBody(envelope(rows)));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    const deployments = okValue(await client.listDeployments({ service: null, limit: 50 }));
    expect(deployments.map((deployment) => deployment.commitSha)).toEqual(["sha0", "sha1", "sha2"]);
  });

  it("빈 목록은 성공(빈 배열)", async () => {
    const fetch = createRoutedFetch(() => jsonBody(envelope([])));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    expect(okValue(await client.listDeployments({ service: null, limit: 50 }))).toEqual([]);
  });
});

describe("createDeployHistoryClient — 계약과 다른 꼴은 해석 불가(원문을 넘기지 않는다)", () => {
  const cases: [string, () => Response][] = [
    ["JSON 이 아닌 200", () => textResponse(`<html>${UPSTREAM_RAW_MARKER}</html>`, 200, "text/html")],
    ["빈 본문", () => textResponse("", 200)],
    ["success:false 인 200", () => jsonBody({ success: false, error: { code: UPSTREAM_RAW_MARKER } })],
    ["data 없음", () => jsonBody({ success: true })],
    ["deployments 가 배열이 아님", () => jsonBody({ success: true, data: { deployments: UPSTREAM_RAW_MARKER } })],
    ["항목이 null", () => jsonBody(envelope([null]))],
    ["request_id 빠짐", () => { const row = deploymentRow(); delete (row as Record<string, unknown>).request_id; return jsonBody(envelope([row])); }],
    ["request_id 가 숫자", () => jsonBody(envelope([deploymentRow({ request_id: 7 })]))],
    ["commit_sha 빠짐", () => { const row = deploymentRow(); delete (row as Record<string, unknown>).commit_sha; return jsonBody(envelope([row])); }],
    ["accepted_at 빠짐", () => { const row = deploymentRow(); delete (row as Record<string, unknown>).accepted_at; return jsonBody(envelope([row])); }],
    ["ci_ms 가 글자", () => jsonBody(envelope([deploymentRow({ ci_ms: "120000" })]))],
    ["cd_ms 가 음수", () => jsonBody(envelope([deploymentRow({ cd_ms: -1 })]))],
    ["state 가 열거 밖", () => jsonBody(envelope([deploymentRow({ state: UPSTREAM_RAW_MARKER })]))],
    ["service 가 숫자", () => jsonBody(envelope([deploymentRow({ service: 7 })]))],
    ["한 항목만 틀려도 전체", () => jsonBody(envelope([deploymentRow(), deploymentRow({ failed_stage: 3 })]))],
  ];

  it.each(cases)("%s → unparseable", async (_label, makeResponse) => {
    const fetch = createRoutedFetch(() => makeResponse());
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    expectFailure(await client.listDeployments({ service: null, limit: 50 }), "unparseable");
  });
});

describe("createDeployHistoryClient — 실패는 상태 코드와 짧은 사유만", () => {
  it.each([
    [401, "unauthorized"], [422, "invalid_request"], [500, "bad_status"], [503, "unavailable"], [504, "server_timeout"],
    [404, "bad_status"], [302, "bad_status"], [301, "bad_status"],
  ] as const)("HTTP %i → %s(상태 코드 함께), 오류 본문 원문 · 비밀값 · 주소 없음", async (status, reason) => {
    const fetch = createRoutedFetch(() => textResponse(leakyErrorBody(), status));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    expectFailure(await client.listDeployments({ service: null, limit: 50 }), reason, status);
  });

  it("연결 실패(예외 문구에 주소 · 비밀값) → unreachable, 문구는 넘기지 않는다", async () => {
    const fetch = createRoutedFetch(() => Promise.reject(leakyNetworkError()));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    const result = await client.listDeployments({ service: null, limit: 50 });
    expectFailure(result, "unreachable");
    expect(!result.ok && result.status).toBeFalsy();
  });

  it("fetch 가 동기로 던져도 거부하지 않고 unreachable", async () => {
    const fetch = createRoutedFetch(() => { throw leakyNetworkError(); });
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    expectFailure(await client.listDeployments({ service: null, limit: 50 }), "unreachable");
  });

  it("message 는 언제나 고정 표의 글자", () => {
    for (const message of Object.values(UPSTREAM_FAILURE_MESSAGES)) expectNoForbiddenText(message);
  });
});

describe("createDeployHistoryClient — 5초 기한(가짜 타이머)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("응답하지 않는 master → 5초에 timeout, 그 전에는 끝나지 않는다", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((_url, init) => hangUntilAborted(init));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch, timeoutSignal: timeout.factory });
    const pending = track(client.listDeployments({ service: null, limit: 50 }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expectFailure(pending.value!, "timeout");
  });

  it("머리글만 주고 본문을 끝내지 않는 master → 5초에 timeout(본문까지 기한 안)", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((_url, init) => headersThenStalledBody(init));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch, timeoutSignal: timeout.factory });
    const pending = track(client.listDeployments({ service: null, limit: 50 }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pending.settled).toBe(true);
    expectFailure(pending.value!, "timeout");
  });
});

describe("createDeployHistoryClient — 요청한 사람(requested_by — 명세 ⑫ §24)", () => {
  it.each([
    ["문제에서 온 접수", "admin:jun:incident:monitor:front", "admin:jun:incident:monitor:front"],
    ["사람의 접수", "admin:jun", "admin:jun"],
    ["워크플로", "github", "github"],
    ["빈 글자", "", null],
    ["null", null, null],
  ] as const)("%s → %s", async (_label, requestedBy, expected) => {
    const fetch = createRoutedFetch(() => jsonBody(envelope([deploymentRow({ requested_by: requestedBy })])));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    expect(okValue(await client.listDeployments({ service: null, limit: 50 }))[0].requestedBy).toBe(expected);
  });

  it("칸이 없으면(옛 master) null", async () => {
    const fetch = createRoutedFetch(() => jsonBody(envelope([deploymentRow()])));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    expect(okValue(await client.listDeployments({ service: null, limit: 50 }))[0].requestedBy).toBeNull();
  });

  it("글자가 아니면 해석 불가(원문을 넘기지 않는다)", async () => {
    const fetch = createRoutedFetch(() => jsonBody(envelope([deploymentRow({ requested_by: 7 })])));
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    expectFailure(await client.listDeployments({ service: null, limit: 50 }), "unparseable");
  });
});
