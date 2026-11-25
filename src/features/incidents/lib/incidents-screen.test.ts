/** 문제 화면의 조립 — 가짜 fetch(각 서버의 실제 응답 꼴)로 호출의 차례 · 수 · 동시성 · 5초 기한 · 설정 없음 · 닫힌 문제를 본다.
 * 기존 클라이언트를 그대로 쓴다(새 조회 경로 없음): 목록은 네 호출, 근거 묶음은 INCIDENT_EVIDENCE_MAXIMUM_CALLS 이하. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { INCIDENT_LIST_CALLS, SELECTED_INCIDENT_TEXT, collectIncidentsScreen, type IncidentsScreenOptions } from "@/features/incidents/lib/incidents-screen";
import { INCIDENT_EVIDENCE_MAXIMUM_CALLS } from "@/features/incidents/lib/incident-evidence";
import { fitIncidentEvidence, incidentEvidenceText } from "@/features/incidents/lib/incident-evidence-text";
import { deployIncidentId, errorLogsIncidentId, monitorIncidentId, resourceIncidentId } from "@/features/incidents/lib/incident-id";
import {
  MINUTE, NOW, alertRecordRow, alertRecordsBody, commitsBody, deploymentRow, deploymentsBody, emptySeriesBody, firingRow, iso, latestBody, latestServerRow,
  logRow, logsBody, monitorsBody, seenContainersBody,
} from "@/features/incidents/lib/incidents-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, SECRET_HEADER_NAMES,
  createRoutedFetch, createTimerTimeoutSignal, expectNoForbiddenText, expectReadOnlyRequest, hangUntilAborted, headersOf, jsonBody, leakyErrorBody, textResponse,
} from "@/shared/lib/upstream-test-fakes";

type Handler = (url: URL, init: RequestInit) => Promise<Response> | Response;

const DOWN_AT = NOW - 20 * MINUTE;

/** 가짜 세 서버 — 경로마다 기본 응답(열린 문제: front DOWN · s158 디스크 경고 · backend 배포 실패 · llm 오류 로그). overrides 로 경로마다 바꾼다. */
function fakeServers(overrides: Record<string, Handler> = {}) {
  const defaults: Record<string, Handler> = {
    [`${FAKE_ALERT_URL}/monitors`]: () => jsonBody(monitorsBody([
      { name: "front", status: "DOWN", down_since: iso(DOWN_AT), reason: "status 502" }, { name: "backend", status: "UP", down_since: "", reason: "" },
    ])),
    [`${FAKE_ALERT_URL}/incidents`]: () => jsonBody(alertRecordsBody([alertRecordRow({ at: iso(DOWN_AT), key: "front" })])),
    [`${FAKE_OBSERVE_URL}/metrics/latest`]: () => jsonBody(latestBody([latestServerRow("s158")], [firingRow({ server: "s158" })])),
    [`${FAKE_OBSERVE_URL}/metrics/containers`]: (url) => jsonBody(seenContainersBody(url.searchParams.get("server")!, Date.parse(url.searchParams.get("at")!), ["front-app", "backend-app", "llm-wrapper"])),
    [`${FAKE_OBSERVE_URL}/metrics/series`]: (url) => jsonBody(emptySeriesBody(url.searchParams)),
    [`${FAKE_OBSERVE_URL}/logs`]: (url) => {
      const from = url.searchParams.get("from") ?? iso(NOW - 60 * MINUTE);
      const to = url.searchParams.get("to") ?? iso(NOW);
      const rows = url.searchParams.get("level") === "error" && url.searchParams.get("service") === null ? [logRow({ service: "llm", message: "llm 오류" })] : [];
      return jsonBody(logsBody(rows, from, to));
    },
    [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: () => jsonBody(deploymentsBody([
      deploymentRow({ request_id: "req-failed-1", service: "backend", state: "failed", failed_stage: "ci_test", commit_sha: "b".repeat(40), accepted_at: iso(NOW - 40 * MINUTE), finished_at: iso(NOW - 30 * MINUTE) }),
      deploymentRow({ request_id: "req-ok-1", service: "backend", state: "succeeded", commit_sha: "c".repeat(40), accepted_at: iso(NOW - 3 * 60 * MINUTE), finished_at: iso(NOW - 3 * 60 * MINUTE + MINUTE) }),
    ])),
    [`${FAKE_DEPLOY_MASTER_URL}/deploys/git/commits`]: () => jsonBody(commitsBody(["b".repeat(40)])),
  };
  const routes = { ...defaults, ...overrides };
  return createRoutedFetch((url, init) => {
    const route = routes[`${url.origin}${url.pathname}`];
    if (!route) throw new Error(`unexpected ${url.pathname}`);
    return route(url, init);
  });
}

function options(fetch: ReturnType<typeof fakeServers>, overrides: Partial<IncidentsScreenOptions> = {}): IncidentsScreenOptions {
  return {
    alertUrl: FAKE_ALERT_URL, alertSecret: FAKE_ALERT_SECRET, observeUrl: FAKE_OBSERVE_URL, observeSecret: FAKE_OBSERVE_SECRET,
    deployMasterUrl: FAKE_DEPLOY_MASTER_URL, deploySecret: FAKE_DEPLOY_SECRET, fetch, now: () => NOW, ...overrides,
  };
}

function calledPaths(fetch: ReturnType<typeof fakeServers>): string[] {
  return fetch.mock.calls.map(([input]) => new URL(input).pathname);
}

function calledUrls(fetch: ReturnType<typeof fakeServers>): URL[] {
  return fetch.mock.calls.map(([input]) => new URL(input));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("목록 — 네 호출(기존 클라이언트 그대로)", () => {
  it("감시 대상 · latest · 배포 이력(200건, 서비스 거름 없음) · 최근 10분 오류 로그(500건), 전부 GET · 비밀 헤더는 그 서버의 것 하나", async () => {
    const fetch = fakeServers();
    const data = await collectIncidentsScreen(options(fetch), null);
    expect(INCIDENT_LIST_CALLS).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(4);
    const urls = calledUrls(fetch);
    expect(urls.map((url) => `${url.origin}${url.pathname}`).sort()).toEqual([
      `${FAKE_ALERT_URL}/monitors`, `${FAKE_DEPLOY_MASTER_URL}/deploys`, `${FAKE_OBSERVE_URL}/logs`, `${FAKE_OBSERVE_URL}/metrics/latest`,
    ].sort());
    const deploys = urls.find((url) => url.pathname === "/deploys")!;
    expect([...deploys.searchParams]).toEqual([["limit", "200"]]);
    const logs = urls.find((url) => url.pathname === "/logs")!;
    expect([...logs.searchParams]).toEqual([["from", iso(NOW - 10 * MINUTE)], ["to", iso(NOW)], ["level", "error"], ["limit", "500"]]);
    const expectedSecret: Record<string, [string, string]> = {
      "/monitors": ["x-alert-secret", FAKE_ALERT_SECRET], "/metrics/latest": ["x-observe-secret", FAKE_OBSERVE_SECRET],
      "/deploys": ["x-deploy-secret", FAKE_DEPLOY_SECRET], "/logs": ["x-observe-secret", FAKE_OBSERVE_SECRET],
    };
    for (const [input, init] of fetch.mock.calls) {
      expectReadOnlyRequest(init);
      const [name, secret] = expectedSecret[new URL(input).pathname];
      for (const header of SECRET_HEADER_NAMES) expect(headersOf(init).get(header)).toBe(header === name ? secret : null);
    }
    expect(data.selected).toBeNull();
    expect(data.checkedAt).toBe(iso(NOW));
    expect(data.list.incidents.map((incident) => incident.id)).toEqual([
      // 위험(DOWN) → 경고 셋: 배포 실패와 임계값은 같은 시각(30분 전)이라 종류 순서 → 오류 로그(언제부터 모름)
      monitorIncidentId("front"), deployIncidentId("backend", "req-failed-1"), resourceIncidentId("s158", "disk_warning", null), errorLogsIncidentId("llm"),
    ]);
  });

  it("네 호출을 한꺼번에 시작한다 — 하나가 5초 동안 멈춰도 전체는 5초(그 출처만 확인하지 못함)", async () => {
    vi.useFakeTimers();
    const timer = createTimerTimeoutSignal();
    const fetch = fakeServers({ [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: (_url, init) => hangUntilAborted(init) });
    let settled = false;
    const pending = collectIncidentsScreen(options(fetch, { timeoutSignal: timer.factory }), null).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    const data = await pending;
    expect(timer.requestedMilliseconds.every((milliseconds) => milliseconds === 5_000)).toBe(true);
    expect(data.list.unchecked.map((failure) => failure.text)).toEqual(["배포 서버(배포 이력): 확인하지 못함 — 닿지 않음(5초 초과)"]);
    expect(data.list.incidents.map((incident) => incident.kind)).toEqual(["monitor_down", "resource_threshold", "error_logs"]);
  });

  it("설정이 빈 출처는 그 출처만 '설정 없음'(그 서버를 부르지 않는다)", async () => {
    const fetch = fakeServers();
    const data = await collectIncidentsScreen(options(fetch, { alertSecret: "" }), null);
    expect(calledPaths(fetch)).not.toContain("/monitors");
    expect(data.list.unchecked.map((failure) => failure.text)).toEqual(["알림 서버(감시 대상): 확인하지 못함 — 설정 없음"]);
    const withoutMaster = fakeServers();
    const second = await collectIncidentsScreen(options(withoutMaster, { deployMasterUrl: "not-a-url" }), null);
    expect(calledPaths(withoutMaster)).not.toContain("/deploys");
    expect(second.list.unchecked.map((failure) => failure.source)).toEqual(["deployments"]);
  });

  it("다른 서버의 오류 본문 · 주소 · 비밀값이 결과에 없다", async () => {
    const leaky: Handler = () => textResponse(leakyErrorBody(), 500);
    const fetch = fakeServers({
      [`${FAKE_ALERT_URL}/monitors`]: leaky, [`${FAKE_OBSERVE_URL}/metrics/latest`]: leaky, [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: leaky, [`${FAKE_OBSERVE_URL}/logs`]: leaky,
    });
    const data = await collectIncidentsScreen(options(fetch), null);
    expect(data.list.unchecked).toHaveLength(4);
    expect(data.list.emptyText).toBe("확인된 범위에서는 열린 문제가 없습니다");
    expectNoForbiddenText(data);
  });
});

describe("문제 하나 — 목록 뒤에 근거 묶음(호출 수 상한 안)", () => {
  it.each([
    ["감시 대상 DOWN", monitorIncidentId("front"), ["/incidents", "/logs", "/logs", "/metrics/latest", "/metrics/containers", "/metrics/series", "/metrics/series"]],
    ["배포 실패", deployIncidentId("backend", "req-failed-1"), ["/incidents", "/logs", "/deploys/git/commits", "/metrics/latest", "/metrics/containers", "/metrics/series", "/metrics/series"]],
    ["자원 임계값", resourceIncidentId("s158", "disk_warning", null), ["/incidents", "/logs", "/logs"]],
    ["오류 로그", errorLogsIncidentId("llm"), ["/logs", "/metrics/latest", "/metrics/containers", "/metrics/series", "/metrics/series"]],
  ])("%s — 목록 넷 + 그 종류의 호출만, 합이 상한 안", async (_label, id, evidencePaths) => {
    const fetch = fakeServers();
    const data = await collectIncidentsScreen(options(fetch), id);
    const paths = calledPaths(fetch);
    expect(paths.slice(INCIDENT_LIST_CALLS).sort()).toEqual([...evidencePaths].sort());
    expect(paths.length).toBeLessThanOrEqual(INCIDENT_LIST_CALLS + INCIDENT_EVIDENCE_MAXIMUM_CALLS);
    for (const [, init] of fetch.mock.calls) expectReadOnlyRequest(init);
    expect(data.selected?.kind).toBe("evidence");
    if (data.selected?.kind !== "evidence") throw new Error("evidence");
    expect(data.selected.evidence.incident.id).toBe(id);
    expectNoForbiddenText(data);
  });

  it("근거 묶음은 목록이 끝난 뒤에 시작한다(목록의 배포 이력 · latest 를 다시 쓴다 — 배포 이력은 한 번만)", async () => {
    const fetch = fakeServers();
    await collectIncidentsScreen(options(fetch), deployIncidentId("backend", "req-failed-1"));
    expect(calledPaths(fetch).filter((path) => path === "/deploys")).toHaveLength(1);
    expect(calledPaths(fetch).slice(0, INCIDENT_LIST_CALLS).sort()).toEqual(["/deploys", "/logs", "/metrics/latest", "/monitors"]);
  });

  it("화면 글은 맞춘 묶음의 글과 같다(text = incidentEvidenceText(evidence) · evidence = fitIncidentEvidence 를 거친 것)", async () => {
    const data = await collectIncidentsScreen(options(fakeServers()), monitorIncidentId("front"));
    if (data.selected?.kind !== "evidence") throw new Error("evidence");
    expect(data.selected.text).toBe(incidentEvidenceText(data.selected.evidence));
    expect(fitIncidentEvidence(data.selected.evidence)).toEqual(data.selected.evidence);
  });

  it("근거 칸들은 한꺼번에 — 알림 서버가 5초 멈춰도 묶음은 5초에 끝나고 그 칸만 확인하지 못함", async () => {
    vi.useFakeTimers();
    const timer = createTimerTimeoutSignal();
    const fetch = fakeServers({ [`${FAKE_ALERT_URL}/incidents`]: (_url, init) => hangUntilAborted(init) });
    let settled = false;
    const pending = collectIncidentsScreen(options(fetch, { timeoutSignal: timer.factory }), monitorIncidentId("front")).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const data = await pending;
    if (data.selected?.kind !== "evidence") throw new Error("evidence");
    expect(data.selected.evidence.alertHistory).toMatchObject({ state: "failed", failure: { reason: "timeout" } });
    expect(data.selected.evidence.logs.state).toBe("value");
    expect(data.selected.evidence.resources.state).toBe("value");
  });

  it("목록 · 근거가 모두 멈춰도 화면은 붙잡히지 않는다 — 목록 5초 + 근거 8초 안", async () => {
    vi.useFakeTimers();
    const timer = createTimerTimeoutSignal();
    const hang: Handler = (_url, init) => hangUntilAborted(init);
    const fetch = fakeServers({
      [`${FAKE_ALERT_URL}/incidents`]: hang, [`${FAKE_OBSERVE_URL}/metrics/latest`]: (_url, init) => {
        // 목록의 latest 는 곧바로, 자원 칸의 latest 는 멈춘다
        const count = fetch.mock.calls.filter(([input]) => new URL(input).pathname === "/metrics/latest").length;
        return count === 1 ? jsonBody(latestBody([latestServerRow("s158")], [])) : hangUntilAborted(init);
      },
      [`${FAKE_OBSERVE_URL}/logs`]: (url, init) => (url.searchParams.get("service") === null ? jsonBody(logsBody([], url.searchParams.get("from")!, url.searchParams.get("to")!)) : hangUntilAborted(init)),
    });
    let settled = false;
    const pending = collectIncidentsScreen(options(fetch, { timeoutSignal: timer.factory }), monitorIncidentId("front")).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(13_000);
    expect(settled).toBe(true);
    const data = await pending;
    if (data.selected?.kind !== "evidence") throw new Error("evidence");
    expect(data.selected.evidence.alertHistory.state).toBe("failed");
    expect(data.selected.evidence.logs.state).toBe("failed");
    expect(data.selected.evidence.resources.state).toBe("failed");
  });
});

describe("고른 문제가 지금은 목록에 없을 때", () => {
  it("그 종류의 출처가 성공했으면 closed — 근거 호출 없음", async () => {
    const fetch = fakeServers();
    const data = await collectIncidentsScreen(options(fetch), monitorIncidentId("backend"));
    expect(data.selected).toEqual({ kind: "closed", incidentId: monitorIncidentId("backend") });
    expect(fetch).toHaveBeenCalledTimes(INCIDENT_LIST_CALLS);
    expect(SELECTED_INCIDENT_TEXT.closed).toBe("이 문제는 지금 열려 있지 않습니다");
    expect(SELECTED_INCIDENT_TEXT.toList).toBe("문제 목록으로");
  });

  it("실패 뒤 성공한 배포가 생겼으면 그 배포 실패는 closed", async () => {
    const fetch = fakeServers({ [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: () => jsonBody(deploymentsBody([
      deploymentRow({ request_id: "req-fix-2", service: "backend", state: "succeeded", accepted_at: iso(NOW - 5 * MINUTE) }),
      deploymentRow({ request_id: "req-failed-1", service: "backend", state: "failed", failed_stage: "ci_test", accepted_at: iso(NOW - 40 * MINUTE) }),
    ])) });
    const data = await collectIncidentsScreen(options(fetch), deployIncidentId("backend", "req-failed-1"));
    expect(data.selected).toEqual({ kind: "closed", incidentId: deployIncidentId("backend", "req-failed-1") });
  });

  it("그 종류의 출처가 실패했으면 unchecked — '열려 있지 않습니다'라고 말하지 않는다", async () => {
    const fetch = fakeServers({ [`${FAKE_ALERT_URL}/monitors`]: () => textResponse(leakyErrorBody(), 503) });
    const data = await collectIncidentsScreen(options(fetch), monitorIncidentId("front"));
    expect(data.selected).toEqual({ kind: "unchecked", incidentId: monitorIncidentId("front") });
    expect(fetch).toHaveBeenCalledTimes(INCIDENT_LIST_CALLS);
    expect(SELECTED_INCIDENT_TEXT.unchecked).toBe("이 문제가 지금 열려 있는지 확인하지 못했습니다");
  });

  it("다른 종류의 출처만 실패했으면 closed 그대로", async () => {
    const fetch = fakeServers({ [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: () => textResponse("", 503) });
    const data = await collectIncidentsScreen(options(fetch), monitorIncidentId("backend"));
    expect(data.selected).toEqual({ kind: "closed", incidentId: monitorIncidentId("backend") });
  });

  it("firing 칸이 없어 임계값을 확인하지 못했으면 자원 임계값 문제는 unchecked", async () => {
    const fetch = fakeServers({ [`${FAKE_OBSERVE_URL}/metrics/latest`]: () => jsonBody({ success: true, data: { servers: [latestServerRow("s158")] } }) });
    const data = await collectIncidentsScreen(options(fetch), resourceIncidentId("s158", "disk_warning", null));
    expect(data.selected?.kind).toBe("unchecked");
  });
});
