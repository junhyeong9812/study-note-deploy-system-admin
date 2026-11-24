/** 상태 한눈에의 서버 자원 요약 — 명세 §2.6 "'상태 한눈에': 서버별 한 줄(CPU · 메모리 · 디스크 · 마지막 수신 시각)과 넘어 있는 임계값을 요약에 더한다.
 * '서버 자원'으로 가는 링크" · "지표가 오래된 서버는 'N분 전 값'" · §2.3 "한 구역이 실패해도 다른 구역은 보인다" · §11.4 · §16 "수신 없음(마지막 수신 시각은 낸다)" ·
 * §16.3 "firing — 표가 아직 없으면 울리는 것이 없는 것으로 답한다". 클라이언트의 실패 종류 · 상한은 resource-metrics-client.test 가 본다 — 여기서는 전하는 꼴만. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectStatusOverview, type StatusOverviewOptions } from "@/features/status/lib/status-overview";
import {
  STATUS_RESOURCE_SERVER_LIMIT, collectStatusResources, collectStatusScreen, statusResourceSummaryItems, statusResourcesFromLatest,
  type StatusResourcesSummary,
} from "@/features/status/lib/status-resources";
import type { LatestResources, ServerLatest, FiringRule } from "@/features/resources/lib/resource-metrics-client";
import {
  MINUTE, NOW_MILLISECONDS, SECOND, javaInstantText, observeFiring, observeLatestBody, observeLatestServer, observeSilentServer,
} from "@/features/resources/lib/resource-metrics-test-fakes";
import type { UpstreamResult } from "@/shared/lib/upstream-result";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, createRoutedFetch,
  createTimerTimeoutSignal, expectFailure, expectNoForbiddenText, hangUntilAborted, headersOf, jsonBody, leakyErrorBody, okValue,
  respondAfter, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";

function host(overrides: Partial<NonNullable<ServerLatest["host"]>> = {}): NonNullable<ServerLatest["host"]> {
  return {
    cpuPct: 3.4, load1: 0.1, memTotal: 16_000_000_000, memUsed: 2_100_000_000, diskTotal: 500_235_124_736, diskUsed: 80_570_650_624,
    netRxBps: 1, netTxBps: 1, ioReadBps: 0, ioWriteBps: 0, ...overrides,
  };
}

function server(name: string, overrides: Partial<ServerLatest> = {}): ServerLatest {
  return {
    server: name, measuredAt: javaInstantText(NOW_MILLISECONDS - 20 * SECOND), receivedAt: javaInstantText(NOW_MILLISECONDS - 19 * SECOND),
    ageMilliseconds: 19_000, stale: false, host: host(), containers: [], gpus: [], missing: [], ...overrides,
  };
}

function silent(name: string, overrides: Partial<ServerLatest> = {}): ServerLatest {
  return server(name, { measuredAt: null, receivedAt: null, ageMilliseconds: null, stale: true, host: null, ...overrides });
}

function firing(overrides: Partial<FiringRule> = {}): FiringRule {
  return { server: "158", rule: "disk_warning", target: null, severity: "warning", since: javaInstantText(NOW_MILLISECONDS - 30 * MINUTE), lastValue: 86, ...overrides };
}

function latest(servers: ServerLatest[], firingRules: FiringRule[] | null = []): LatestResources {
  return { servers, firing: firingRules };
}

function rowOf(summary: StatusResourcesSummary, name: string) {
  const row = summary.rows.find((each) => each.server === name);
  if (!row) throw new Error(`no row ${name}`);
  return row;
}

describe("statusResourcesFromLatest — 서버마다 한 줄", () => {
  it("이름순 · CPU · 메모리 · 디스크 · 마지막 수신 시각 · 신선도", () => {
    const summary = statusResourcesFromLatest(latest([silent("9"), server("164"), server("158")]));
    expect(summary.rows.map((row) => row.server)).toEqual(["158", "164", "9"]);
    const row = rowOf(summary, "158");
    expect(row.cpu).toEqual({ state: "value", value: 3.4, text: "3.4%" });
    expect(row.memory.state).toBe("value");
    expect(row.memory.value).toBeCloseTo(13.125, 10);
    expect(row.memory.text).toBe("13.1%");
    expect(row.disk).toMatchObject({ state: "value", text: "16.1%" });
    expect(row.receivedAt).toBe(javaInstantText(NOW_MILLISECONDS - 19 * SECOND));
    expect(row.freshness).toEqual({ kind: "fresh", label: null, ageMilliseconds: 19_000 });
    expect(summary.hiddenServerCount).toBe(0);
  });

  it("링크 — 서버 자원 화면의 그 서버 묶음 · 화면 링크", () => {
    const summary = statusResourcesFromLatest(latest([server("158")]));
    expect(rowOf(summary, "158").href).toBe("/resources?range=1h#resource-server-158");
    expect(summary.screenHref).toBe("/resources?range=1h");
  });

  it("값이 없으면 0 이 아니라 '없음'(null 값 · total 0)", () => {
    const row = rowOf(statusResourcesFromLatest(latest([server("158", { host: host({ cpuPct: null, memTotal: 0, diskUsed: null }) })])), "158");
    expect(row.cpu).toEqual({ state: "none", value: null, text: "없음" });
    expect(row.memory).toEqual({ state: "none", value: null, text: "없음" });
    expect(row.disk).toEqual({ state: "none", value: null, text: "없음" });
  });

  it("0 은 값이다", () => {
    expect(rowOf(statusResourcesFromLatest(latest([server("158", { host: host({ cpuPct: 0 }) })])), "158").cpu).toEqual({ state: "value", value: 0, text: "0.0%" });
  });

  it("missing 에 host → '읽지 못함'", () => {
    const row = rowOf(statusResourcesFromLatest(latest([server("158", { host: null, missing: ["host"] })])), "158");
    for (const value of [row.cpu, row.memory, row.disk]) expect(value).toEqual({ state: "unread", value: null, text: "읽지 못함" });
  });

  it("오래됨 — 'N분 전 값', age 를 모르면 '오래된 값'", () => {
    const summary = statusResourcesFromLatest(latest([
      server("158", { stale: true, ageMilliseconds: 12 * MINUTE + 5 * SECOND }), server("164", { stale: true, ageMilliseconds: null }),
    ]));
    expect(rowOf(summary, "158").freshness).toEqual({ kind: "stale", label: "12분 전 값", ageMilliseconds: 12 * MINUTE + 5 * SECOND });
    expect(rowOf(summary, "158").cpu.text).toBe("3.4%");   // 값은 보이되 신선도로 구분한다
    expect(rowOf(summary, "164").freshness).toMatchObject({ kind: "stale", label: "오래된 값" });
  });

  it("수신 없음 — 값은 전부 '없음', 마지막 수신 기록이 있으면 시각 · age 를 낸다(§16)", () => {
    const summary = statusResourcesFromLatest(latest([
      silent("9"), silent("77", { receivedAt: javaInstantText(NOW_MILLISECONDS - 3 * 24 * 60 * MINUTE), ageMilliseconds: 3 * 24 * 60 * MINUTE }),
    ]));
    expect(rowOf(summary, "9").freshness).toEqual({ kind: "never", label: "수신 없음", ageMilliseconds: null });
    expect(rowOf(summary, "9").receivedAt).toBeNull();
    for (const value of [rowOf(summary, "9").cpu, rowOf(summary, "9").memory, rowOf(summary, "9").disk]) expect(value).toEqual({ state: "none", value: null, text: "없음" });
    expect(rowOf(summary, "77").freshness).toEqual({ kind: "never", label: "수신 없음", ageMilliseconds: 3 * 24 * 60 * MINUTE });
    expect(rowOf(summary, "77").receivedAt).toBe(javaInstantText(NOW_MILLISECONDS - 3 * 24 * 60 * MINUTE));
  });

  it("stale 을 모름 → '확인하지 못함' · 음수 age 는 0", () => {
    const summary = statusResourcesFromLatest(latest([server("158", { stale: null }), server("164", { ageMilliseconds: -800 })]));
    expect(rowOf(summary, "158").freshness).toMatchObject({ kind: "unknown", label: "확인하지 못함" });
    expect(rowOf(summary, "164").freshness.ageMilliseconds).toBe(0);
  });

  it(`앞 ${STATUS_RESOURCE_SERVER_LIMIT}대만 — 숨긴 수를 센다`, () => {
    const names = Array.from({ length: 12 }, (_, index) => `s${String(index).padStart(2, "0")}`);
    const summary = statusResourcesFromLatest(latest([...names].reverse().map((name) => server(name))));
    expect(summary.rows.map((row) => row.server)).toEqual(names.slice(0, 10));
    expect(summary.hiddenServerCount).toBe(2);
  });
});

describe("statusResourcesFromLatest — 지금 울리는 임계값의 수와 가장 심한 것", () => {
  it("critical 이 warning 보다 심하다 · 수는 그 서버의 전부", () => {
    const summary = statusResourcesFromLatest(latest([server("158"), server("164")], [
      firing({ rule: "cpu", severity: "warning" }), firing({ rule: "disk_critical", severity: "critical" }), firing({ rule: "memory" }),
    ]));
    expect(summary.firingKnown).toBe(true);
    expect(rowOf(summary, "158").firingCount).toBe(3);
    expect(rowOf(summary, "158").worstFiring).toEqual({ rule: "disk_critical", ruleLabel: "디스크 위험", severity: "critical", severityLabel: "위험", target: null });
    expect(rowOf(summary, "164")).toMatchObject({ firingCount: 0, worstFiring: null });
  });

  it("같은 심각도면 받은 순서의 앞 · 재시작은 대상까지 · 모르는 낱말은 그대로", () => {
    const summary = statusResourcesFromLatest(latest([server("158"), server("164")], [
      firing({ rule: "restarts", target: "front-app-green" }), firing({ rule: "cpu" }),
      firing({ server: "164", rule: "brand_new", severity: "info" }),
    ]));
    expect(rowOf(summary, "158").worstFiring).toEqual({ rule: "restarts", ruleLabel: "컨테이너 재시작 반복", severity: "warning", severityLabel: "경고", target: "front-app-green" });
    expect(rowOf(summary, "164").worstFiring).toMatchObject({ rule: "brand_new", ruleLabel: "brand_new", severity: "info", severityLabel: "info" });
  });

  it("warning 이 모르는 심각도보다 심하다", () => {
    const summary = statusResourcesFromLatest(latest([server("158")], [firing({ rule: "x", severity: "info" }), firing({ rule: "memory", severity: "warning" })]));
    expect(rowOf(summary, "158").worstFiring?.rule).toBe("memory");
  });

  it("끊김(silent)은 수신 없음 서버에도 붙는다", () => {
    const summary = statusResourcesFromLatest(latest([silent("9")], [firing({ server: "9", rule: "silent", lastValue: null })]));
    expect(rowOf(summary, "9")).toMatchObject({ firingCount: 1, worstFiring: { rule: "silent", ruleLabel: "지표 끊김" } });
  });

  it("줄에 없는 서버의 firing 은 elsewhereFiringCount", () => {
    const summary = statusResourcesFromLatest(latest([server("158")], [firing({ server: "77", rule: "silent" }), firing()]));
    expect(summary.elsewhereFiringCount).toBe(1);
    expect(rowOf(summary, "158").firingCount).toBe(1);
  });

  it("firing 이 null(칸 없음) → firingKnown false, 줄에는 0 · null", () => {
    const summary = statusResourcesFromLatest(latest([server("158")], null));
    expect(summary.firingKnown).toBe(false);
    expect(rowOf(summary, "158")).toMatchObject({ firingCount: 0, worstFiring: null });
  });
});

describe("statusResourceSummaryItems — 맨 위 요약에 더할 재료", () => {
  it("울리는 것마다 problems(줄의 서버 이름순 → 받은 순서, 그 다음 다른 서버)", () => {
    const summary = statusResourcesFromLatest(latest([server("164"), server("158")], [
      firing({ server: "164", rule: "memory" }), firing({ server: "77", rule: "silent" }),
      firing({ server: "158", rule: "restarts", target: "front-app-green" }), firing({ server: "158", rule: "disk_critical", severity: "critical" }),
    ]));
    expect(statusResourceSummaryItems({ ok: true, value: summary })).toEqual({
      problems: [
        { label: "서버 158 컨테이너 재시작 반복 front-app-green(경고)" }, { label: "서버 158 디스크 위험(위험)" },
        { label: "서버 164 메모리(경고)" }, { label: "서버 77 지표 끊김(경고)" },
      ],
      unreachable: [],
    });
  });

  it("울리는 것이 없으면 둘 다 빈 목록", () => {
    expect(statusResourceSummaryItems({ ok: true, value: statusResourcesFromLatest(latest([server("158")])) })).toEqual({ problems: [], unreachable: [] });
  });

  it("firing 을 모름 → unreachable '서버 자원 임계값'", () => {
    expect(statusResourceSummaryItems({ ok: true, value: statusResourcesFromLatest(latest([server("158")], null)) }))
      .toEqual({ problems: [], unreachable: [{ label: "서버 자원 임계값" }] });
  });

  it("조회 실패 → unreachable '서버 자원'", () => {
    const failure: UpstreamResult<StatusResourcesSummary> = { ok: false, reason: "unreachable", message: "닿지 않음" };
    expect(statusResourceSummaryItems(failure)).toEqual({ problems: [], unreachable: [{ label: "서버 자원" }] });
  });
});

describe("collectStatusResources — latest 한 번", () => {
  it("GET /metrics/latest 만 · X-Observe-Secret · 결과는 요약", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("158"), observeSilentServer("9")], [observeFiring()]));
    const result = await collectStatusResources({ observeUrl: FAKE_OBSERVE_URL, observeSecret: FAKE_OBSERVE_SECRET, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    expect(new URL(input).pathname).toBe("/metrics/latest");
    expect(headersOf(init).get("X-Observe-Secret")).toBe(FAKE_OBSERVE_SECRET);
    const summary = okValue(result);
    expect(summary.rows.map((row) => row.server)).toEqual(["158", "9"]);
    expect(rowOf(summary, "158")).toMatchObject({ firingCount: 1, worstFiring: { rule: "disk_warning" } });
    expectNoForbiddenText(summary);
  });

  it.each([
    [401, "unauthorized"], [503, "unavailable"], [500, "bad_status"],
  ] as const)("HTTP %i → %s 그대로 전한다", async (status, reason) => {
    const fetch = createRoutedFetch(() => textResponse(leakyErrorBody(), status));
    expectFailure(await collectStatusResources({ observeUrl: FAKE_OBSERVE_URL, observeSecret: FAKE_OBSERVE_SECRET, fetch }), reason, status);
  });

  it("꼴이 틀림 → unparseable", async () => {
    const fetch = createRoutedFetch(() => jsonBody({ success: true, data: { servers: "x" } }));
    expectFailure(await collectStatusResources({ observeUrl: FAKE_OBSERVE_URL, observeSecret: FAKE_OBSERVE_SECRET, fetch }), "unparseable");
  });

  it.each([["주소 빔", { observeUrl: "" }], ["비밀값 빔", { observeSecret: "" }]] as const)("%s → 호출 없이 not_configured", async (_label, overrides) => {
    const fetch = createRoutedFetch(() => observeLatestBody([]));
    expectFailure(await collectStatusResources({ observeUrl: FAKE_OBSERVE_URL, observeSecret: FAKE_OBSERVE_SECRET, fetch, ...overrides }), "not_configured");
    expect(fetch).not.toHaveBeenCalled();
  });
});

/** 기존 다섯 칸의 정상 응답(status-overview.test 와 같은 계약 꼴) + 관측 서버 latest. */
function statusRoutes(latestResponse: (init: RequestInit) => Promise<Response> | Response) {
  return createRoutedFetch((url, init) => {
    const key = `${url.origin}${url.pathname}`;
    if (key === `${FAKE_OBSERVE_URL}/metrics/latest`) return latestResponse(init);
    if (key === `${FAKE_ALERT_URL}/monitors`) return jsonBody({ success: true, data: { monitors: [], last_round_at: "", undelivered: 0 } });
    if (key === `${FAKE_ALERT_URL}/health`) return jsonBody({ status: "ok", last_round_at: "", active: true });
    if (key === `${FAKE_OBSERVE_URL}/health`) return jsonBody({ status: "ok", failure: "", lag: 0 });
    if (key === `${FAKE_BACKEND_URL}/api/health/dependencies`) return jsonBody({ status: "UP", components: { redis: { status: "UP" } } });
    if (key === `${FAKE_DEPLOY_MASTER_URL}/health`) return jsonBody({ success: true, data: { mode: "master" } });
    throw new Error(`unexpected ${key}`);
  });
}

function screenOptions(fetch: ReturnType<typeof createRoutedFetch>, overrides: Partial<StatusOverviewOptions & { observeSecret: string }> = {}) {
  return {
    alertUrl: FAKE_ALERT_URL, alertSecret: FAKE_ALERT_SECRET, observeUrl: FAKE_OBSERVE_URL, observeSecret: FAKE_OBSERVE_SECRET,
    backendUrl: FAKE_BACKEND_URL, deployMasterUrl: FAKE_DEPLOY_MASTER_URL, fetch, ...overrides,
  };
}

describe("collectStatusScreen — 기존 다섯 칸 + 자원 요약", () => {
  it("overview 는 collectStatusOverview 와 같은 값 · resources 는 요약 · 호출은 여섯 주소 한 번씩", async () => {
    const fetch = statusRoutes(() => observeLatestBody([observeLatestServer("158")]));
    const data = await collectStatusScreen(screenOptions(fetch));
    expect(Object.keys(data).sort()).toEqual(["overview", "resources"]);
    const expectedOverview = await collectStatusOverview(screenOptions(statusRoutes(() => observeLatestBody([]))));
    expect(data.overview).toStrictEqual(expectedOverview);
    expect(okValue(data.resources).rows.map((row) => row.server)).toEqual(["158"]);
    const paths = fetch.mock.calls.map(([input]) => `${new URL(input).origin}${new URL(input).pathname}`).sort();
    expect(paths).toEqual([
      `${FAKE_ALERT_URL}/health`, `${FAKE_ALERT_URL}/monitors`, `${FAKE_BACKEND_URL}/api/health/dependencies`, `${FAKE_DEPLOY_MASTER_URL}/health`,
      `${FAKE_OBSERVE_URL}/health`, `${FAKE_OBSERVE_URL}/metrics/latest`,
    ].sort());
    expectNoForbiddenText(data);
  });

  it("자원 조회가 실패해도 다섯 칸은 그대로", async () => {
    const fetch = statusRoutes(() => textResponse(leakyErrorBody(), 503));
    const data = await collectStatusScreen(screenOptions(fetch));
    expectFailure(data.resources, "unavailable", 503);
    for (const cell of [data.overview.alertMonitors, data.overview.alertHealth, data.overview.observeHealth, data.overview.backendDependencies, data.overview.deployMasterHealth]) {
      okValue(cell as UpstreamResult<unknown>);
    }
    expectNoForbiddenText(data);
  });

  it("OBSERVE_SECRET 이 비면 자원만 not_configured — 관측 서버 헬스(비밀값 불필요)는 그대로 부른다", async () => {
    const fetch = statusRoutes(() => observeLatestBody([]));
    const data = await collectStatusScreen(screenOptions(fetch, { observeSecret: "" }));
    expectFailure(data.resources, "not_configured");
    okValue(data.overview.observeHealth);
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === "/metrics/latest")).toBe(false);
  });

  it("비밀 헤더 — /metrics/latest 에만 X-Observe-Secret(관측 서버 헬스에는 없다)", async () => {
    const fetch = statusRoutes(() => observeLatestBody([]));
    await collectStatusScreen(screenOptions(fetch));
    for (const [input, init] of fetch.mock.calls) {
      const path = new URL(input).pathname;
      expect(headersOf(init).get("X-Observe-Secret"), path).toBe(path === "/metrics/latest" ? FAKE_OBSERVE_SECRET : null);
    }
  });
});

describe("collectStatusScreen — 병렬(가짜 타이머)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("여섯 호출을 0초에 함께 시작한다 — 자원 조회가 4초 걸리면 전체도 4초(더하지 않는다)", async () => {
    const timeout = createTimerTimeoutSignal();
    const startedAt: number[] = [];
    const start = Date.now();
    const inner = statusRoutes((init) => respondAfter(4_000, () => observeLatestBody([observeLatestServer("158")]), init));
    const fetch = createRoutedFetch((url, init) => { startedAt.push(Date.now() - start); return inner(url.toString(), init); });
    const pending = track(collectStatusScreen({ ...screenOptions(fetch), timeoutSignal: timeout.factory }));
    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt).toEqual([0, 0, 0, 0, 0, 0]);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    okValue(pending.value!.resources);
  });

  it("자원 조회가 멈추면 5초에 timeout — 다섯 칸은 값이 있다", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = statusRoutes((init) => hangUntilAborted(init));
    const pending = track(collectStatusScreen({ ...screenOptions(fetch), timeoutSignal: timeout.factory }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expectFailure(pending.value!.resources, "timeout");
    okValue(pending.value!.overview.alertHealth);
  });
});
