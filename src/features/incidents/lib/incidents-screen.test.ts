/** 문제 화면의 조립 — 가짜 fetch(각 서버의 실제 응답 꼴)로 호출의 차례 · 수 · 동시성 · 5초 기한 · 설정 없음 · 닫힌 문제를 본다.
 * 기존 클라이언트를 그대로 쓴다(새 조회 경로 없음): 목록은 네 호출, 근거 묶음은 INCIDENT_EVIDENCE_MAXIMUM_CALLS 이하. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { INCIDENT_LIST_CALLS, SELECTED_INCIDENT_TEXT, collectIncidentsScreen, type IncidentsScreenOptions } from "@/features/incidents/lib/incidents-screen";
import { INCIDENT_EVIDENCE_MAXIMUM_CALLS } from "@/features/incidents/lib/incident-evidence";
import { isUncovered } from "@/features/incidents/lib/incident-list";
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
    // 끝의 "/deploys" = 조치 구역의 그 서비스의 이력(명세 ⑫ §25 — 서비스가 하나로 정해질 때만 하나)
    ["감시 대상 DOWN", monitorIncidentId("front"), ["/incidents", "/logs", "/logs", "/metrics/latest", "/metrics/containers", "/metrics/series", "/metrics/series", "/deploys"]],
    ["배포 실패", deployIncidentId("backend", "req-failed-1"), ["/incidents", "/logs", "/deploys/git/commits", "/metrics/latest", "/metrics/containers", "/metrics/series", "/metrics/series", "/deploys"]],
    ["자원 임계값", resourceIncidentId("s158", "disk_warning", null), ["/incidents", "/logs", "/logs", "/deploys"]],
    ["오류 로그", errorLogsIncidentId("llm"), ["/logs", "/metrics/latest", "/metrics/containers", "/metrics/series", "/metrics/series", "/deploys"]],
  ])("%s — 목록 넷 + 그 종류의 호출만 + 조치의 이력 하나, 합이 상한 안", async (_label, id, evidencePaths) => {
    const fetch = fakeServers();
    const data = await collectIncidentsScreen(options(fetch), id);
    const paths = calledPaths(fetch);
    expect(paths.slice(INCIDENT_LIST_CALLS).sort()).toEqual([...evidencePaths].sort());
    expect(paths.length).toBeLessThanOrEqual(INCIDENT_LIST_CALLS + INCIDENT_EVIDENCE_MAXIMUM_CALLS + 1);
    for (const [, init] of fetch.mock.calls) expectReadOnlyRequest(init);
    expect(data.selected?.kind).toBe("evidence");
    if (data.selected?.kind !== "evidence") throw new Error("evidence");
    expect(data.selected.evidence.incident.id).toBe(id);
    expectNoForbiddenText(data);
  });

  it("근거 묶음은 목록이 끝난 뒤에 시작한다(목록의 배포 이력 · latest 를 다시 쓴다 — 모든 서비스의 배포 이력은 한 번만 · 조치의 그 서비스 이력이 하나 더)", async () => {
    const fetch = fakeServers();
    await collectIncidentsScreen(options(fetch), deployIncidentId("backend", "req-failed-1"));
    const deploysUrls = fetch.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname === "/deploys");
    expect(deploysUrls.filter((url) => url.searchParams.get("service") === null)).toHaveLength(1);
    expect(deploysUrls.filter((url) => url.searchParams.get("service") !== null).map((url) => [url.searchParams.get("service"), url.searchParams.get("limit")]))
      .toEqual([["backend", "200"]]);
    expect(calledPaths(fetch).slice(0, INCIDENT_LIST_CALLS).sort()).toEqual(["/deploys", "/logs", "/metrics/latest", "/monitors"]);
  });

  it("화면 글은 맞춘 묶음의 글과 같다(text = incidentEvidenceText(evidence) · evidence = fitIncidentEvidence 를 거친 것)", async () => {
    const data = await collectIncidentsScreen(options(fakeServers()), monitorIncidentId("front"));
    if (data.selected?.kind !== "evidence") throw new Error("evidence");
    expect(data.selected.text).toBe(incidentEvidenceText(data.selected.evidence));
    expect(fitIncidentEvidence(data.selected.evidence)).toEqual(data.selected.evidence);
  });

  it("근거 칸 하나가 5초 기한에 걸려도 묶음은 5초에 끝나고 그 칸만 확인하지 못함(다른 칸은 값)", async () => {
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

  /** 목록의 오류 로그 호출(서비스 거름 없음 · error)만 바꾼다 — 그 밖의 로그 호출은 빈 답. */
  function errorLogsListing(rows: Record<string, unknown>[], nextBefore: string): Handler {
    return (url) => {
      const from = url.searchParams.get("from")!;
      const to = url.searchParams.get("to")!;
      const listing = url.searchParams.get("level") === "error" && url.searchParams.get("service") === null;
      return jsonBody(logsBody(listing ? rows : [], from, to, listing ? nextBefore : ""));
    };
  }
  const FULL_PAGE = Array.from({ length: 500 }, (_, index) => logRow({ id: `${NOW - MINUTE}-${index}`, service: "llm", message: `llm 오류 ${index}` }));

  it("오류 로그가 상한(500건)을 채웠으면 목록에 없는 서비스의 오류 로그 문제는 unchecked — 닫혔다고 말하지 않는다", async () => {
    const fetch = fakeServers({ [`${FAKE_OBSERVE_URL}/logs`]: errorLogsListing(FULL_PAGE, `${NOW - 10 * MINUTE}-0`) });
    const data = await collectIncidentsScreen(options(fetch), errorLogsIncidentId("backend"));
    expect(data.list.errorLogsTruncated).toBe(true);
    expect(data.list.incidents.map((incident) => incident.id)).toContain(errorLogsIncidentId("llm"));
    expect(data.selected).toEqual({ kind: "unchecked", incidentId: errorLogsIncidentId("backend") });
    expect(fetch).toHaveBeenCalledTimes(INCIDENT_LIST_CALLS);
  });

  it("오류 로그가 상한을 채우지 않았으면(499건 · next_before 없음) 목록에 없는 서비스의 오류 로그 문제는 closed", async () => {
    const fetch = fakeServers({ [`${FAKE_OBSERVE_URL}/logs`]: errorLogsListing(FULL_PAGE.slice(1), "") });
    const data = await collectIncidentsScreen(options(fetch), errorLogsIncidentId("backend"));
    expect(data.list.errorLogsTruncated).toBe(false);
    expect(data.selected).toEqual({ kind: "closed", incidentId: errorLogsIncidentId("backend") });
  });

  it("오류 로그가 상한을 채웠어도 다른 종류의 문제는 그대로 closed", async () => {
    const fetch = fakeServers({ [`${FAKE_OBSERVE_URL}/logs`]: errorLogsListing(FULL_PAGE, `${NOW - 10 * MINUTE}-0`) });
    const data = await collectIncidentsScreen(options(fetch), monitorIncidentId("backend"));
    expect(data.selected).toEqual({ kind: "closed", incidentId: monitorIncidentId("backend") });
  });

  it("firing 칸이 없어 임계값을 확인하지 못했으면 자원 임계값 문제는 unchecked", async () => {
    const fetch = fakeServers({ [`${FAKE_OBSERVE_URL}/metrics/latest`]: () => jsonBody({ success: true, data: { servers: [latestServerRow("s158")] } }) });
    const data = await collectIncidentsScreen(options(fetch), resourceIncidentId("s158", "disk_warning", null));
    expect(data.selected?.kind).toBe("unchecked");
  });
});

describe("덮지 못한 범위의 문제를 고르면 '닫힘'이 아니라 '확인하지 못함' — 목록과 같은 값을 읽는다(명세 ⑫ §12 1)", () => {
  const FRONT_ONLY_200 = () => jsonBody(deploymentsBody([
    deploymentRow({ request_id: "req-front-new", service: "front", state: "succeeded", accepted_at: iso(NOW - 2 * 60 * MINUTE) }),
    deploymentRow({ request_id: "req-front-old", service: "front", state: "failed", failed_stage: "ci_test", accepted_at: iso(NOW - 3 * 60 * MINUTE) }),
    ...Array.from({ length: 198 }, (_, index) => deploymentRow({ request_id: `req-front-${index}`, service: "front", accepted_at: iso(NOW - 4 * 60 * MINUTE - index * MINUTE) })),
  ]));
  const ALL_SERVICES_200 = () => jsonBody(deploymentsBody(Array.from({ length: 200 }, (_, index) => deploymentRow({
    request_id: `req-${index}`, service: ["front", "backend", "llm", "alert", "observe", "admin"][index % 6], accepted_at: iso(NOW - 2 * 60 * MINUTE - index * MINUTE),
  }))));
  const FRONT_UNKNOWN = () => jsonBody(monitorsBody([
    { name: "front", status: "UNKNOWN", down_since: "", reason: "연결 실패" }, { name: "backend", status: "UP", down_since: "", reason: "" },
  ]));
  const HASHED_DEPLOY = deployIncidentId("llm", "r".repeat(70));

  it("재현 — 배포 이력이 front 200건이면 deploy:llm:r999 는 unchecked(목록은 llm 을 확인하지 못했다고 말한다)", async () => {
    const fetch = fakeServers({ [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: FRONT_ONLY_200 });
    const data = await collectIncidentsScreen(options(fetch), "deploy:llm:r999");
    expect(data.list.scopeNotes).toContain("배포: 최근 200건 안에서만 확인 — backend, llm, alert, observe, admin 은 확인하지 못함");
    expect(data.selected).toEqual({ kind: "unchecked", incidentId: "deploy:llm:r999" });
    expect(fetch).toHaveBeenCalledTimes(INCIDENT_LIST_CALLS);
  });

  it("재현 — front 가 UNKNOWN 이면 monitor:front 는 unchecked(목록은 상태를 모른다고 말한다)", async () => {
    const fetch = fakeServers({ [`${FAKE_ALERT_URL}/monitors`]: FRONT_UNKNOWN });
    const data = await collectIncidentsScreen(options(fetch), monitorIncidentId("front"));
    expect(data.list.scopeNotes).toContain("감시 대상 1개는 아직 상태를 모름");
    expect(data.selected).toEqual({ kind: "unchecked", incidentId: monitorIncidentId("front") });
  });

  it.each([
    ["배포 200건 안에 보인 서비스의 지난 실패 — 실제로 확인했다", "closed", FRONT_ONLY_200, deployIncidentId("front", "req-front-old")],
    ["보이지 않은 서비스가 있고 식별자가 해시 꼴(서비스를 알 수 없음)", "unchecked", FRONT_ONLY_200, HASHED_DEPLOY],
    ["모든 서비스가 보인 200건 — 해시 꼴도", "closed", ALL_SERVICES_200, HASHED_DEPLOY],
    ["모든 서비스가 보인 200건 — llm 의 없는 배포", "closed", ALL_SERVICES_200, "deploy:llm:r999"],
  ] as const)("배포 — %s → %s", async (_label, expected, deploys, id) => {
    const data = await collectIncidentsScreen(options(fakeServers({ [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: deploys })), id);
    expect(data.selected).toEqual({ kind: expected, incidentId: id });
  });

  it.each([
    ["deploy:llm:r999"], ["deploy:front:r1"], [HASHED_DEPLOY],
  ])("배포가 200건 미만(전부 확인)이면 %s 는 closed", async (id) => {
    const data = await collectIncidentsScreen(options(fakeServers()), id);
    expect(data.selected).toEqual({ kind: "closed", incidentId: id });
  });

  it("UNKNOWN 이 아닌 감시 대상(UP)은 closed · A 가 UNKNOWN 이어도 B 를 고르면 closed", async () => {
    const quiet = await collectIncidentsScreen(options(fakeServers()), monitorIncidentId("backend"));
    expect(quiet.selected).toEqual({ kind: "closed", incidentId: monitorIncidentId("backend") });
    const withUnknown = await collectIncidentsScreen(options(fakeServers({ [`${FAKE_ALERT_URL}/monitors`]: FRONT_UNKNOWN })), monitorIncidentId("backend"));
    expect(withUnknown.selected).toEqual({ kind: "closed", incidentId: monitorIncidentId("backend") });
  });

  /** 목록이 말한 범위 ↔ 고른 결과. 기존의 두 경우(출처 실패 · 오류 로그 500건)를 함께 둔다. */
  const FULL_ERRORS: Handler = (url) => {
    const listing = url.searchParams.get("level") === "error" && url.searchParams.get("service") === null;
    const rows = listing ? Array.from({ length: 500 }, (_, index) => logRow({ id: `${NOW - MINUTE}-${index}`, service: "llm" })) : [];
    return jsonBody(logsBody(rows, url.searchParams.get("from")!, url.searchParams.get("to")!, listing ? `${NOW - 10 * MINUTE}-0` : ""));
  };
  const FAILING: Handler = () => textResponse("", 503);
  const SCENARIOS: [label: string, overrides: Record<string, Handler>, uncheckedIds: string[]][] = [
    ["모두 정상", {}, []],
    ["배포 front 200건", { [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: FRONT_ONLY_200 }, ["deploy:llm:r999", HASHED_DEPLOY]],
    ["배포 모든 서비스 200건", { [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: ALL_SERVICES_200 }, []],
    ["front UNKNOWN", { [`${FAKE_ALERT_URL}/monitors`]: FRONT_UNKNOWN }, [monitorIncidentId("front")]],
    ["감시 대상 실패", { [`${FAKE_ALERT_URL}/monitors`]: FAILING }, [monitorIncidentId("front"), monitorIncidentId("backend")]],
    ["배포 이력 실패", { [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: FAILING }, ["deploy:llm:r999", deployIncidentId("front", "req-front-old"), HASHED_DEPLOY]],
    ["오류 로그 500건", { [`${FAKE_OBSERVE_URL}/logs`]: FULL_ERRORS }, [errorLogsIncidentId("backend")]],
    ["firing 칸 없음", { [`${FAKE_OBSERVE_URL}/metrics/latest`]: () => jsonBody({ success: true, data: { servers: [latestServerRow("s158")] } }) }, [resourceIncidentId("s9", "cpu", null)]],
    ["배포 front 200건 + front UNKNOWN + 오류 로그 500건", {
      [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: FRONT_ONLY_200, [`${FAKE_ALERT_URL}/monitors`]: FRONT_UNKNOWN, [`${FAKE_OBSERVE_URL}/logs`]: FULL_ERRORS,
    }, ["deploy:llm:r999", HASHED_DEPLOY, monitorIncidentId("front"), errorLogsIncidentId("backend")]],
  ];
  const CANDIDATES = [
    monitorIncidentId("front"), monitorIncidentId("backend"), "deploy:llm:r999", deployIncidentId("front", "req-front-old"), HASHED_DEPLOY,
    errorLogsIncidentId("backend"), resourceIncidentId("s9", "cpu", null),
  ];

  it.each(SCENARIOS)("목록과 판정이 같은 값 — %s", async (_label, overrides, uncheckedIds) => {
    for (const id of CANDIDATES) {
      const data = await collectIncidentsScreen(options(fakeServers(overrides)), id);
      if (data.selected?.kind === "evidence") continue;   // 열려 있는 문제(목록에 있음)
      const expected = uncheckedIds.includes(id) ? "unchecked" : "closed";
      expect(data.selected, id).toEqual({ kind: expected, incidentId: id });
      // 판정은 목록이 실은 값에서 나온다
      expect(data.selected?.kind, `${id} — list.uncovered 와 다름`).toBe(isUncovered(data.list.uncovered, id) ? "unchecked" : "closed");
      // 목록이 아무 범위도 말하지 않으면 없는 식별자는 closed
      if (data.list.unchecked.length === 0 && !data.list.errorLogsTruncated && data.list.scopeNotes.length === 0) expect(data.selected?.kind, id).toBe("closed");
    }
  });
});
