/** 서버 자원 화면의 데이터 — 명세 §2.6 "서버 셋의 현재 값(CPU · 메모리 · 디스크 · 네트워크 · 디스크 입출력 · GPU)과 선 그래프, 기간 선택, 서버별 컨테이너 표
 * (CPU · 메모리 · 재시작 횟수 · 상태 — 누르면 그 컨테이너의 그래프). 넘어 있는 임계값은 그 자리에 표시한다" · "색만으로 구분하지 않고 값 · 단위 · 시각 축을 글자로" ·
 * "지표가 오래된 서버는 값 옆에 'N분 전 값'" · §2.3 "한 구역이 실패해도 다른 구역은 보인다" · §2.5 "화면은 'GPU 값 없음'" · §10.2 missing ·
 * §10.3 latest · series · §11.4 "한 번도 보내지 않은 서버 … '수신 없음'" · §11.5 "name 은 자리 이름을 뗀 이름" · §11.6 step_ms · source · §16 latest 의 서버 목록. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildChartGeometry, type ChartAxis, type ChartLineInput } from "@/features/resources/lib/resource-chart";
import {
  RESOURCE_CHART_HEIGHT, RESOURCE_CHART_WIDTH, RESOURCE_GPU_GRAPH_LIMIT, RESOURCE_SERVER_LIMIT, RESOURCE_TEXT, collectResourcesScreen, resourcesScreenFailures,
  type GraphView, type ResourcesScreen, type ResourcesScreenOptions, type ServerResourceView,
} from "@/features/resources/lib/resources-screen";
import { resourcesHref, type ResourcesQuery } from "@/features/resources/lib/resources-query";
import {
  HOUR, MINUTE, NOW_MILLISECONDS, SECOND, createFakeObserveMetrics, javaInstantText, observeContainer, observeFiring, observeGpu, observeHost,
  observeLatestBody, observeLatestServer, observePoint, observeSilentServer, seriesKey, type FakeObserveMetrics,
} from "@/features/resources/lib/resource-metrics-test-fakes";
import type { UpstreamResult } from "@/shared/lib/upstream-result";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, createRoutedFetch, createTimerTimeoutSignal, expectFailure, expectNoForbiddenText, expectReadOnlyRequest,
  hangUntilAborted, headersOf, jsonBody, leakyErrorBody, leakyNetworkError, okValue, respondAfter, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";

const FROM = NOW_MILLISECONDS - HOUR;
const TO = NOW_MILLISECONDS;
const DEFAULT_QUERY: ResourcesQuery = { range: "1h", container: null };

/** 기본 세 서버(관측 서버가 이름순으로 준다): 158 은 GPU 를 읽지 못함(§10.1 NVML), 164 는 GPU 하나, 9 는 수신 없음. */
function defaultServers(): Record<string, unknown>[] {
  return [
    observeLatestServer("158", { missing: ["gpus"] }),
    observeLatestServer("164", { gpus: [observeGpu()], containers: [observeContainer({ name: "llm-ollama", series_name: "llm-ollama", cpu_pct: 250, restarts: 4 })] }),
    observeSilentServer("9"),
  ];
}

let fake: FakeObserveMetrics;

function fakeFetch() {
  return createRoutedFetch((url, init) => {
    if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected host ${url.hostname}`);
    return fake.handler(url, init);
  });
}

function options(fetch: ReturnType<typeof createRoutedFetch>, overrides: Partial<ResourcesScreenOptions> = {}): ResourcesScreenOptions {
  return { observeUrl: FAKE_OBSERVE_URL, observeSecret: FAKE_OBSERVE_SECRET, fetch, nowMilliseconds: NOW_MILLISECONDS, query: DEFAULT_QUERY, ...overrides };
}

async function collect(overrides: Partial<ResourcesScreenOptions> = {}) {
  const fetch = fakeFetch();
  const screen = await collectResourcesScreen(options(fetch, overrides));
  return { screen, fetch };
}

function serversOf(screen: ResourcesScreen): ServerResourceView[] {
  return okValue(screen.servers);
}

function serverNamed(screen: ResourcesScreen, name: string): ServerResourceView {
  const found = serversOf(screen).find((server) => server.server === name);
  if (!found) throw new Error(`no server ${name}`);
  return found;
}

function seriesCalls() {
  return fake.calls.filter((call) => call.path === "/metrics/series");
}

beforeEach(() => {
  fake = createFakeObserveMetrics(() => observeLatestBody(defaultServers(), []));
});

describe("호출 — latest 1회 · 서버마다 host series · GPU 마다 gpu series", () => {
  it("관측 서버만, 전부 GET · X-Observe-Secret · redirect manual · /metrics/containers 는 부르지 않는다", async () => {
    const { fetch } = await collect();
    expect(fake.calls.filter((call) => call.path === "/metrics/latest")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.path === "/metrics/containers")).toHaveLength(0);
    for (const [, init] of fetch.mock.calls) {
      expectReadOnlyRequest(init);
      expect(init?.redirect).toBe("manual");
      expect(headersOf(init).get("X-Observe-Secret")).toBe(FAKE_OBSERVE_SECRET);
    }
  });

  it("series 는 기간의 from · to 로 — host 셋 + 164 의 gpu 0", async () => {
    await collect();
    const requested = seriesCalls().map((call) => call.parameters);
    const from = new Date(FROM).toISOString();
    const to = new Date(TO).toISOString();
    expect(requested).toHaveLength(4);
    expect(requested).toEqual(expect.arrayContaining([
      { server: "158", scope: "host", from, to }, { server: "164", scope: "host", from, to }, { server: "9", scope: "host", from, to },
      { server: "164", scope: "gpu", name: "0", from, to },
    ]));
  });

  it.each([["24h", 24 * HOUR], ["7d", 7 * 24 * HOUR], ["30d", 30 * 24 * HOUR]] as const)("기간 %s → from = now − 기간", async (range, length) => {
    await collect({ query: { range, container: null } });
    for (const call of seriesCalls()) {
      expect(Date.parse(call.parameters.from)).toBe(NOW_MILLISECONDS - length);
      expect(Date.parse(call.parameters.to)).toBe(NOW_MILLISECONDS);
    }
  });

  it("고른 컨테이너가 있으면 그 계열 1회 더(scope container · 자리 이름을 뗀 이름)", async () => {
    await collect({ query: { range: "1h", container: { server: "158", container: "front-app" } } });
    expect(seriesCalls().filter((call) => call.parameters.scope === "container").map((call) => call.parameters))
      .toEqual([{ server: "158", scope: "container", name: "front-app", from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() }]);
  });

  it("결과 어디에도 비밀값 · 주소 · 원문 표식이 없다", async () => {
    const { screen } = await collect({ query: { range: "1h", container: { server: "158", container: "front-app" } } });
    expectNoForbiddenText(screen);
  });
});

describe("기간 · 주소", () => {
  it("window · rangeOptions(네 기간, 고른 컨테이너 유지) · refreshHref", async () => {
    const query: ResourcesQuery = { range: "24h", container: { server: "164", container: "llm-ollama" } };
    const { screen } = await collect({ query });
    expect(screen.window).toEqual({
      range: "24h", label: "24시간", fromMilliseconds: NOW_MILLISECONDS - 24 * HOUR, toMilliseconds: NOW_MILLISECONDS,
      from: new Date(NOW_MILLISECONDS - 24 * HOUR).toISOString(), to: new Date(NOW_MILLISECONDS).toISOString(),
    });
    expect(screen.rangeOptions).toEqual([
      { range: "1h", label: "1시간", href: resourcesHref({ ...query, range: "1h" }), selected: false },
      { range: "24h", label: "24시간", href: resourcesHref(query), selected: true },
      { range: "7d", label: "7일", href: resourcesHref({ ...query, range: "7d" }), selected: false },
      { range: "30d", label: "30일", href: resourcesHref({ ...query, range: "30d" }), selected: false },
    ]);
    expect(screen.refreshHref).toBe(resourcesHref(query));
  });
});

describe("서버 목록 · 신선도", () => {
  it("이름순(글자 코드 순) — 관측 서버가 다른 순서로 줘도", async () => {
    fake.latest = () => observeLatestBody([observeSilentServer("9"), observeLatestServer("164"), observeLatestServer("158")]);
    const { screen } = await collect();
    expect(serversOf(screen).map((server) => server.server)).toEqual(["158", "164", "9"]);
    expect(screen.hiddenServerCount).toBe(0);
  });

  it("fresh — label 없음, ageMilliseconds 그대로", async () => {
    const { screen } = await collect();
    expect(serverNamed(screen, "158").freshness).toEqual({ kind: "fresh", ageMilliseconds: 19_250, label: null, firing: null });
    expect(serverNamed(screen, "158").measuredAt).toBe(javaInstantText(NOW_MILLISECONDS - 20 * SECOND));
  });

  it("stale — 'N분 전 값'(지금 값처럼 보이지 않게), 값은 그대로 보인다", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158", { stale: true, age_ms: 12 * MINUTE + 30 * SECOND })]);
    const server = serverNamed((await collect()).screen, "158");
    expect(server.freshness).toEqual({ kind: "stale", ageMilliseconds: 12 * MINUTE + 30 * SECOND, label: "12분 전 값", firing: null });
    expect(server.current.cpu).toMatchObject({ state: "value", text: "3.4%" });
  });

  it("stale 인데 age 를 모름 → '오래된 값'", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158", { stale: true, age_ms: null })]);
    expect(serverNamed((await collect()).screen, "158").freshness).toMatchObject({ kind: "stale", label: RESOURCE_TEXT.staleWithoutAge });
  });

  it("수신 없음 — 한 번도 안 보낸 서버, 값은 전부 '없음'(0 이 아니다)", async () => {
    const server = serverNamed((await collect()).screen, "9");
    expect(server.freshness).toEqual({ kind: "never", ageMilliseconds: null, label: "수신 없음", firing: null });
    for (const reading of Object.values(server.current)) expect(reading).toMatchObject({ state: "none", value: null, text: "없음" });
  });

  it("수신 없음이지만 마지막 수신 시각이 있다(§16) — never 에 age 를 담는다", async () => {
    fake.latest = () => observeLatestBody([observeSilentServer("9", { received_at: javaInstantText(NOW_MILLISECONDS - 2 * 24 * HOUR), age_ms: 2 * 24 * HOUR })]);
    expect(serverNamed((await collect()).screen, "9").freshness).toMatchObject({ kind: "never", ageMilliseconds: 2 * 24 * HOUR, label: "수신 없음" });
  });

  it("stale 칸이 없음 → unknown(확인하지 못함)", async () => {
    const row = observeLatestServer("158");
    delete row.stale;
    fake.latest = () => observeLatestBody([row]);
    expect(serverNamed((await collect()).screen, "158").freshness).toMatchObject({ kind: "unknown", label: "확인하지 못함" });
  });

  it("음수 age(두 자리의 시계 차)는 0", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158", { age_ms: -900 })]);
    expect(serverNamed((await collect()).screen, "158").freshness.ageMilliseconds).toBe(0);
  });

  it(`서버가 ${RESOURCE_SERVER_LIMIT}대를 넘으면 앞 ${RESOURCE_SERVER_LIMIT}대만(이름순) — 숨긴 수를 센다, 호출도 ${RESOURCE_SERVER_LIMIT}대만`, async () => {
    const names = Array.from({ length: 12 }, (_, index) => `s${String(index).padStart(2, "0")}`);
    fake.latest = () => observeLatestBody([...names].reverse().map((name) => observeLatestServer(name)));
    const { screen } = await collect();
    expect(serversOf(screen).map((server) => server.server)).toEqual(names.slice(0, 10));
    expect(screen.hiddenServerCount).toBe(2);
    expect(seriesCalls().filter((call) => call.parameters.scope === "host")).toHaveLength(10);
  });
});

describe("이름을 읽지 못한 서버 줄(§18) — 나머지 서버는 보이고, 그 수를 센다", () => {
  it("리뷰 재현 — 대문자 이름의 수신 없음 줄 하나 + 정상 줄 → 정상 서버의 값 · 그래프 호출 그대로, unreadableServerNameCount 1", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158"), observeSilentServer("CI-Agent-9")], []);
    const { screen } = await collect();
    expect(serversOf(screen).map((server) => server.server)).toEqual(["158"]);
    expect(serverNamed(screen, "158").current.cpu).toMatchObject({ state: "value", text: "3.4%" });
    expect(screen.unreadableServerNameCount).toBe(1);
    expect(seriesCalls().map((call) => call.parameters.server)).toEqual(["158"]);
    expect(screen.hiddenServerCount).toBe(0);
  });

  it("다 읽으면 0 · latest 가 실패하면 0", async () => {
    expect((await collect()).screen.unreadableServerNameCount).toBe(0);
    fake.latest = () => textResponse(leakyErrorBody(), 503);
    const { screen } = await collect();
    expectFailure(screen.servers, "unavailable", 503);
    expect(screen.unreadableServerNameCount).toBe(0);
  });
});

describe("현재 값 — 단위 글자, 없으면 '없음' · 읽지 못하면 '읽지 못함'", () => {
  it("158 의 일곱 값", async () => {
    const current = serverNamed((await collect()).screen, "158").current;
    expect(current.cpu).toEqual({ state: "value", value: 3.4, text: "3.4%", detail: null, firing: null });
    expect(current.memory).toMatchObject({ state: "value", text: "13.1%", detail: "2.0 GiB / 14.9 GiB", firing: null });
    expect(current.memory.value).toBeCloseTo(13.125, 10);
    expect(current.disk).toMatchObject({ state: "value", text: "16.1%", detail: "75.0 GiB / 465.9 GiB" });
    expect(current.networkReceive).toEqual({ state: "value", value: 1200, text: "1.2 KiB/s", detail: null, firing: null });
    expect(current.networkTransmit).toMatchObject({ value: 3400, text: "3.3 KiB/s" });
    expect(current.diskRead).toEqual({ state: "value", value: 0, text: "0 B/s", detail: null, firing: null });   // 0 은 실제 값
    expect(current.diskWrite).toMatchObject({ value: 52_000, text: "50.8 KiB/s" });
  });

  it("값이 null 이면 그 칸만 '없음'(첫 수집 · 누적 값이 줄어든 경우 — §10.2)", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158", { host: observeHost({ cpu_pct: null, net_tx_bps: null }) })]);
    const current = serverNamed((await collect()).screen, "158").current;
    expect(current.cpu).toEqual({ state: "none", value: null, text: "없음", detail: null, firing: null });
    expect(current.networkTransmit).toMatchObject({ state: "none", text: "없음" });
    expect(current.networkReceive).toMatchObject({ state: "value", text: "1.2 KiB/s" });
  });

  it("메모리 · 디스크 — 전체가 0 · null 이면 사용률은 '없음'(0 으로 나누지 않는다)", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158", { host: observeHost({ mem_total: 0, disk_total: null }) })]);
    const current = serverNamed((await collect()).screen, "158").current;
    expect(current.memory).toMatchObject({ state: "none", value: null, text: "없음" });
    expect(current.disk).toMatchObject({ state: "none", value: null, text: "없음" });
  });

  it("missing 에 host — 서버 전체 값은 '읽지 못함'", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158", { host: null, missing: ["host"] })]);
    const server = serverNamed((await collect()).screen, "158");
    for (const reading of Object.values(server.current)) expect(reading).toMatchObject({ state: "unread", value: null, text: "읽지 못함" });
    expect(server.missing).toEqual(["host"]);
  });

  it("host 칸이 없고 missing 에도 없음 → '없음'", async () => {
    const row = observeLatestServer("158");
    delete row.host;
    fake.latest = () => observeLatestBody([row]);
    expect(serverNamed((await collect()).screen, "158").current.cpu).toMatchObject({ state: "none", text: "없음" });
  });
});

describe("컨테이너 표", () => {
  it("계열 이름 다음 실제 이름 순 · 상태 · CPU(100 을 넘을 수 있다) · 메모리 · 재시작 · 주소", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158", { containers: [
      observeContainer({ name: "front-app-green", series_name: "front-app", cpu_pct: 250, restarts: 2 }),
      observeContainer({ name: "backend-api-blue", series_name: "backend-api", state: "exited", mem_used: null, restarts: null }),
      observeContainer({ name: "front-app-blue", series_name: "front-app", state: null }),
    ] })]);
    const containers = serverNamed((await collect()).screen, "158").containers;
    expect(containers.state).toBe("listed");
    expect(containers.truncated).toBe(false);
    expect(containers.rows.map((row) => row.name)).toEqual(["backend-api-blue", "front-app-blue", "front-app-green"]);
    const [backend, blue, green] = containers.rows;
    expect(backend).toMatchObject({ seriesName: "backend-api", stateText: "exited", restarts: null, restartsText: "없음", selected: false, firing: null });
    expect(backend.memory).toMatchObject({ state: "none", text: "없음" });
    expect(blue.stateText).toBe("없음");
    expect(green).toMatchObject({ seriesName: "front-app", stateText: "running", restarts: 2, restartsText: "2" });
    expect(green.cpu).toMatchObject({ state: "value", value: 250, text: "250.0%" });
    expect(green.memory).toMatchObject({ state: "value", text: "113.5 MiB" });
    expect(green.href).toBe(resourcesHref({ range: "1h", container: { server: "158", container: "front-app" } }));
  });

  it("고른 컨테이너의 줄은 selected(그 서버 · 그 계열 이름일 때만)", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158"), observeLatestServer("164")]);
    const { screen } = await collect({ query: { range: "7d", container: { server: "158", container: "front-app" } } });
    expect(serverNamed(screen, "158").containers.rows[0]).toMatchObject({ selected: true, href: resourcesHref({ range: "7d", container: { server: "158", container: "front-app" } }) });
    expect(serverNamed(screen, "164").containers.rows[0].selected).toBe(false);
  });

  it("missing 에 containers → unread · containers_truncated → truncated", async () => {
    fake.latest = () => observeLatestBody([
      observeLatestServer("158", { containers: [], missing: ["containers"] }),
      observeLatestServer("164", { missing: ["containers_truncated"] }),
    ]);
    const { screen } = await collect();
    expect(serverNamed(screen, "158").containers).toEqual({ state: "unread", rows: [], truncated: false });
    expect(serverNamed(screen, "164").containers).toMatchObject({ state: "listed", truncated: true });
  });

  it("containers 칸이 없음 → unknown · 빈 목록 → listed []", async () => {
    const row = observeLatestServer("158");
    delete row.containers;
    fake.latest = () => observeLatestBody([row, observeLatestServer("164", { containers: [] })]);
    const { screen } = await collect();
    expect(serverNamed(screen, "158").containers).toEqual({ state: "unknown", rows: [], truncated: false });
    expect(serverNamed(screen, "164").containers).toEqual({ state: "listed", rows: [], truncated: false });
  });
});

describe("GPU", () => {
  it("164 — 사용률 · 메모리(사용/전체) · 온도", async () => {
    const gpus = serverNamed((await collect()).screen, "164").gpus;
    expect(gpus.state).toBe("listed");
    expect(gpus.rows).toHaveLength(1);
    expect(gpus.rows[0]).toMatchObject({ index: 0, temperatureText: "28°C" });
    expect(gpus.rows[0].utilization).toMatchObject({ state: "value", value: 12, text: "12.0%" });
    expect(gpus.rows[0].memory).toMatchObject({ state: "value", text: "0.1%", detail: "9.0 MiB / 8.0 GiB" });
  });

  it("158 — missing 에 gpus → 'GPU 값 없음'(§2.5 · §10.1)", async () => {
    expect(serverNamed((await collect()).screen, "158").gpus).toEqual({ state: "unread", rows: [] });
    expect(RESOURCE_TEXT.gpuUnread).toBe("GPU 값 없음");
  });

  it("GPU 설정이 없는 서버(gpus [] · missing 에 없음) → absent · 칸 없음 → unknown", async () => {
    const row = observeLatestServer("164");
    delete row.gpus;
    fake.latest = () => observeLatestBody([observeLatestServer("158", { gpus: [], missing: [] }), row]);
    const { screen } = await collect();
    expect(serverNamed(screen, "158").gpus).toEqual({ state: "absent", rows: [] });
    expect(serverNamed(screen, "164").gpus).toEqual({ state: "unknown", rows: [] });
  });

  it("GPU 값이 null 이면 그 칸만 '없음'", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("164", { gpus: [observeGpu({ util_pct: null, temp_c: null, mem_total: null })] })]);
    const [row] = serverNamed((await collect()).screen, "164").gpus.rows;
    expect(row.utilization).toMatchObject({ state: "none", text: "없음" });
    expect(row.memory).toMatchObject({ state: "none", text: "없음" });
    expect(row.temperatureText).toBe("없음");
  });

  it(`GPU 그래프는 서버마다 앞 ${RESOURCE_GPU_GRAPH_LIMIT}개 — 나머지는 센다`, async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("164", { gpus: Array.from({ length: 6 }, (_, index) => observeGpu({ index })) })]);
    const server = serverNamed((await collect()).screen, "164");
    expect(server.gpus.rows).toHaveLength(6);
    expect(server.gpuGraphs.map((graph) => graph.index)).toEqual([0, 1, 2, 3]);
    expect(server.omittedGpuGraphCount).toBe(2);
    expect(seriesCalls().filter((call) => call.parameters.scope === "gpu").map((call) => call.parameters.name).sort()).toEqual(["0", "1", "2", "3"]);
  });
});

describe("지금 울리는 임계값 — 그 자리에 표시", () => {
  it("디스크 · 메모리 · CPU · 재시작(컨테이너 줄) · 끊김(신선도) · 모르는 규칙(서버 목록에만)", async () => {
    const firing = [
      observeFiring({ server: "158", rule: "cpu", severity: "warning", last_value: 93.5 }),
      observeFiring({ server: "158", rule: "disk_warning", severity: "warning" }),
      observeFiring({ server: "158", rule: "memory", severity: "warning", last_value: 91 }),
      observeFiring({ server: "158", rule: "restarts", target: "front-app-green", severity: "warning", last_value: 3 }),
      observeFiring({ server: "158", rule: "brand_new_rule", severity: "info", last_value: null }),
      observeFiring({ server: "9", rule: "silent", severity: "warning", last_value: null }),
    ];
    fake.latest = () => observeLatestBody(defaultServers(), firing);
    const { screen } = await collect();
    expect(screen.firingKnown).toBe(true);
    const server = serverNamed(screen, "158");
    expect(server.firing.map((view) => view.rule)).toEqual(["cpu", "disk_warning", "memory", "restarts", "brand_new_rule"]);
    expect(server.current.cpu.firing).toEqual({
      rule: "cpu", ruleLabel: "CPU", severity: "warning", severityLabel: "경고", target: null, since: javaInstantText(NOW_MILLISECONDS - 30 * MINUTE), lastValue: 93.5,
    });
    expect(server.current.disk.firing).toMatchObject({ rule: "disk_warning", ruleLabel: "디스크 경고" });
    expect(server.current.memory.firing).toMatchObject({ rule: "memory", ruleLabel: "메모리" });
    expect(server.current.networkReceive.firing).toBeNull();
    expect(server.containers.rows[0].firing).toMatchObject({ rule: "restarts", ruleLabel: "컨테이너 재시작 반복", target: "front-app-green", lastValue: 3 });
    expect(server.firing[4]).toMatchObject({ ruleLabel: "brand_new_rule", severityLabel: "info" });
    expect(serverNamed(screen, "9").freshness.firing).toMatchObject({ rule: "silent", ruleLabel: "지표 끊김" });
    expect(serverNamed(screen, "164").firing).toEqual([]);
    expect(screen.firingElsewhere).toEqual([]);
  });

  it("디스크 경고와 위험이 함께면 디스크 칸에는 위험", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), [
      observeFiring({ server: "158", rule: "disk_critical", severity: "critical" }), observeFiring({ server: "158", rule: "disk_warning" }),
    ]);
    const server = serverNamed((await collect()).screen, "158");
    expect(server.current.disk.firing).toMatchObject({ rule: "disk_critical", ruleLabel: "디스크 위험", severityLabel: "위험" });
    expect(server.firing).toHaveLength(2);
  });

  it("재시작 대상이 지금 컨테이너 줄에 없으면 서버 목록에만(버리지 않는다)", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), [observeFiring({ server: "158", rule: "restarts", target: "gone-app-blue" })]);
    const server = serverNamed((await collect()).screen, "158");
    expect(server.firing.map((view) => view.target)).toEqual(["gone-app-blue"]);
    expect(server.containers.rows.every((row) => row.firing === null)).toBe(true);
  });

  it("화면에 없는 서버의 firing → firingElsewhere(서버 이름과 함께)", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), [observeFiring({ server: "77", rule: "silent", last_value: null })]);
    const { screen } = await collect();
    expect(screen.firingElsewhere).toEqual([expect.objectContaining({ server: "77", rule: "silent", ruleLabel: "지표 끊김" })]);
  });

  it("firing 칸이 없음 → firingKnown false(어디에도 붙이지 않는다) — 빈 배열과 다르다", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), undefined);
    const { screen } = await collect();
    expect(screen.firingKnown).toBe(false);
    expect(serverNamed(screen, "158").firing).toEqual([]);
  });
});

/** 그래프 기대 — 모델은 buildChartGeometry 의 결과를 그대로 싣는다. */
function expectedChart(axis: ChartAxis, lines: ChartLineInput[], stepMilliseconds = 30_000, fromMilliseconds = FROM) {
  return buildChartGeometry({ fromMilliseconds, toMilliseconds: TO, stepMilliseconds, axis, width: RESOURCE_CHART_WIDTH, height: RESOURCE_CHART_HEIGHT, lines });
}

const P0 = FROM + 10 * SECOND;
const P1 = P0 + 30 * SECOND;
const P2 = P1 + 30 * SECOND;

function hostPoints(): Record<string, unknown>[] {
  return [
    observePoint("host", P0, {
      cpu_pct: [2, 5], mem_used: [2e9, 3e9], mem_total: [16e9, 16e9], disk_used: [100, 150], disk_total: [1000, 1000],
      net_rx_bps: [1000, 2048], net_tx_bps: [500, 600], io_read_bps: [0, 0], io_write_bps: [10, 20],
    }),
    observePoint("host", P1, {
      cpu_pct: [4, 9.9], mem_used: [4e9, 4e9], mem_total: [16e9, 16e9], disk_used: [200, 200], disk_total: [1000, 1000],
      net_rx_bps: [1200, 1500], net_tx_bps: [700, null], io_read_bps: [5, 6], io_write_bps: [null, null],
    }),
    observePoint("host", P2, { cpu_pct: [null, null], mem_used: [8e9, 8e9], mem_total: [null, null] }),
  ];
}

describe("그래프 — host", () => {
  beforeEach(() => {
    fake.series.set(seriesKey("158", "host", null), { points: hostPoints() });
  });

  function hostGraphsOf(screen: ResourcesScreen, server = "158") {
    return okValue(serverNamed(screen, server).hostGraphs);
  }

  it("CPU — 평균 · 최댓값 선, 퍼센트 축, 기간 · 간격 · 읽는 곳", async () => {
    const cpu = hostGraphsOf((await collect()).screen).cpu;
    expect(cpu).toMatchObject({ title: "CPU", unit: "percent", rangeLabel: "1시간", fromMilliseconds: FROM, toMilliseconds: TO, stepMilliseconds: 30_000, source: "raw", pointCount: 3 });
    expect(cpu.chart).toEqual(expectedChart({ kind: "percent" }, [
      { key: "cpu_pct", label: "평균", role: "average", points: [{ atMilliseconds: P0, value: 2 }, { atMilliseconds: P1, value: 4 }, { atMilliseconds: P2, value: null }] },
      { key: "cpu_pct_max", label: "최댓값", role: "maximum", points: [{ atMilliseconds: P0, value: 5 }, { atMilliseconds: P1, value: 9.9 }, { atMilliseconds: P2, value: null }] },
    ]));
  });

  it("CPU 글 요약 — 값이 있는 마지막 점의 평균 · 기간의 최댓값 · 기간 이름", async () => {
    const cpu = hostGraphsOf((await collect()).screen).cpu;
    expect(cpu.lineSummaries).toEqual([{ label: "평균", latest: 4, maximum: 9.9 }]);
    expect(cpu.summary).toBe("CPU 1시간: 평균 최근 4.0% · 최댓값 9.9%");
  });

  it("메모리 — used ÷ 그 점의 total × 100, 최댓값 선은 used_max ÷ total, total 이 없는 점은 값 없음", async () => {
    const memory = hostGraphsOf((await collect()).screen).memory;
    expect(memory).toMatchObject({ title: "메모리", unit: "percent" });
    expect(memory.chart).toEqual(expectedChart({ kind: "percent" }, [
      { key: "mem_used", label: "평균", role: "average", points: [{ atMilliseconds: P0, value: 12.5 }, { atMilliseconds: P1, value: 25 }, { atMilliseconds: P2, value: null }] },
      { key: "mem_used_max", label: "최댓값", role: "maximum", points: [{ atMilliseconds: P0, value: 18.75 }, { atMilliseconds: P1, value: 25 }, { atMilliseconds: P2, value: null }] },
    ]));
    expect(memory.summary).toBe("메모리 1시간: 평균 최근 25.0% · 최댓값 25.0%");
  });

  it("디스크 — 같은 계산", async () => {
    const disk = hostGraphsOf((await collect()).screen).disk;
    expect(disk.lineSummaries).toEqual([{ label: "평균", latest: 20, maximum: 20 }]);
    expect(disk.chart.lines.map((line) => line.key)).toEqual(["disk_used", "disk_used_max"]);
  });

  it("네트워크 — 수신 · 송신과 그 최댓값, auto 축, 초당 바이트 요약", async () => {
    const network = hostGraphsOf((await collect()).screen).network;
    expect(network).toMatchObject({ title: "네트워크", unit: "bytesPerSecond" });
    expect(network.chart).toEqual(expectedChart({ kind: "auto" }, [
      { key: "net_rx_bps", label: "수신", role: "average", points: [{ atMilliseconds: P0, value: 1000 }, { atMilliseconds: P1, value: 1200 }, { atMilliseconds: P2, value: null }] },
      { key: "net_tx_bps", label: "송신", role: "average", points: [{ atMilliseconds: P0, value: 500 }, { atMilliseconds: P1, value: 700 }, { atMilliseconds: P2, value: null }] },
      { key: "net_rx_bps_max", label: "수신 최댓값", role: "maximum", points: [{ atMilliseconds: P0, value: 2048 }, { atMilliseconds: P1, value: 1500 }, { atMilliseconds: P2, value: null }] },
      { key: "net_tx_bps_max", label: "송신 최댓값", role: "maximum", points: [{ atMilliseconds: P0, value: 600 }, { atMilliseconds: P1, value: null }, { atMilliseconds: P2, value: null }] },
    ]));
    // §18 — 송신 P1 은 최댓값이 없어 그 점의 평균(700)이 후보다(표시한 최댓값이 평균보다 작아지지 않는다)
    expect(network.lineSummaries).toEqual([{ label: "수신", latest: 1200, maximum: 2048 }, { label: "송신", latest: 700, maximum: 700 }]);
    expect(network.summary).toBe("네트워크 1시간: 수신 최근 1.2 KiB/s · 최댓값 2.0 KiB/s / 송신 최근 700 B/s · 최댓값 700 B/s");
  });

  it("디스크 입출력 — 최댓값 선이 비면 평균 선의 최대", async () => {
    const diskIo = hostGraphsOf((await collect()).screen).diskIo;
    expect(diskIo).toMatchObject({ title: "디스크 입출력", unit: "bytesPerSecond" });
    expect(diskIo.chart.lines.map((line) => [line.key, line.label, line.role])).toEqual([
      ["io_read_bps", "읽기", "average"], ["io_write_bps", "쓰기", "average"], ["io_read_bps_max", "읽기 최댓값", "maximum"], ["io_write_bps_max", "쓰기 최댓값", "maximum"],
    ]);
    expect(diskIo.lineSummaries).toEqual([{ label: "읽기", latest: 5, maximum: 6 }, { label: "쓰기", latest: 10, maximum: 20 }]);
  });

  it("점이 없는 서버 — '기록 없음', 값은 null, 차트는 빈 선", async () => {
    const graphs = hostGraphsOf((await collect()).screen, "164");
    expect(graphs.cpu).toMatchObject({ pointCount: 0, summary: "CPU 1시간: 기록 없음", lineSummaries: [{ label: "평균", latest: null, maximum: null }] });
    expect(graphs.cpu.chart.lines.every((line) => line.path === "" && line.drawnPointCount === 0)).toBe(true);
    expect(graphs.network.summary).toBe("네트워크 1시간: 기록 없음");
  });

  it("관측 서버가 고른 step_ms · source 를 그대로(5분 평균 · 경계를 걸친 요청)", async () => {
    fake.series.set(seriesKey("164", "host", null), {
      source: "mixed", stepMilliseconds: 5 * MINUTE,
      points: [observePoint("host", FROM - 4 * MINUTE, { cpu_pct: [10, 20] }), observePoint("host", FROM + MINUTE, { cpu_pct: [30, 40] })],
    });
    const cpu = hostGraphsOf((await collect()).screen, "164").cpu;
    expect(cpu).toMatchObject({ stepMilliseconds: 5 * MINUTE, source: "mixed", pointCount: 2 });
    // 첫 점이 from 보다 앞서도(§15.1) 버리지 않고 차트에 넘긴다 — 그림 영역 안으로 자르는 것은 차트의 몫
    expect(cpu.chart).toEqual(expectedChart({ kind: "percent" }, [
      { key: "cpu_pct", label: "평균", role: "average", points: [{ atMilliseconds: FROM - 4 * MINUTE, value: 10 }, { atMilliseconds: FROM + MINUTE, value: 30 }] },
      { key: "cpu_pct_max", label: "최댓값", role: "maximum", points: [{ atMilliseconds: FROM - 4 * MINUTE, value: 20 }, { atMilliseconds: FROM + MINUTE, value: 40 }] },
    ], 5 * MINUTE));
    expect(cpu.lineSummaries).toEqual([{ label: "평균", latest: 30, maximum: 40 }]);
  });
});

describe("그래프 — 최댓값은 점마다 최댓값, 없으면 그 점의 평균이 후보(§18)", () => {
  it("점 A 평균 90 · 최댓값 없음, 점 B 평균 10 · 최댓값 11 → 표시하는 최댓값 90(11 이 아니다)", async () => {
    fake.series.set(seriesKey("158", "host", null), { points: [
      observePoint("host", P0, { cpu_pct: [90, null], mem_used: [9e9, null], mem_total: [10e9, 10e9] }),
      observePoint("host", P1, { cpu_pct: [10, 11], mem_used: [1e9, 1.1e9], mem_total: [10e9, 10e9] }),
    ] });
    const graphs = okValue(serverNamed((await collect()).screen, "158").hostGraphs);
    expect(graphs.cpu.lineSummaries).toEqual([{ label: "평균", latest: 10, maximum: 90 }]);
    expect(graphs.cpu.summary).toBe("CPU 1시간: 평균 최근 10.0% · 최댓값 90.0%");
    expect(graphs.memory.lineSummaries[0].maximum).toBeCloseTo(90, 10);
    expect(graphs.memory.summary).toBe("메모리 1시간: 평균 최근 10.0% · 최댓값 90.0%");
  });

  it("최댓값이 평균보다 크면 최댓값 그대로(지금처럼)", async () => {
    fake.series.set(seriesKey("158", "host", null), { points: [
      observePoint("host", P0, { cpu_pct: [40, 70] }), observePoint("host", P1, { cpu_pct: [50, 60] }),
    ] });
    expect(okValue(serverNamed((await collect()).screen, "158").hostGraphs).cpu.lineSummaries).toEqual([{ label: "평균", latest: 50, maximum: 70 }]);
  });

  it("고른 컨테이너의 그래프도 같은 규칙", async () => {
    fake.series.set(seriesKey("158", "container", "front-app"), { points: [
      observePoint("container", P0, { cpu_pct: [190, null], mem_used: [119_000_000, 120_000_000] }),
      observePoint("container", P1, { cpu_pct: [90, 95], mem_used: [118_000_000, 119_000_000] }),
    ] });
    const { screen } = await collect({ query: { range: "1h", container: { server: "158", container: "front-app" } } });
    expect(okValue(screen.selectedContainer!.graphs).cpu.summary).toBe("front-app CPU 1시간: 평균 최근 90.0% · 최댓값 190.0%");
  });
});

describe("그래프 — GPU · 고른 컨테이너", () => {
  it("GPU 0 — 사용률(퍼센트) · 메모리(used ÷ total)", async () => {
    fake.series.set(seriesKey("164", "gpu", "0"), { points: [observePoint("gpu", P0, { util_pct: [40, 80], mem_used: [2 * 1024 ** 3, 4 * 1024 ** 3], mem_total: [8 * 1024 ** 3, 8 * 1024 ** 3] })] });
    const [gpu] = serverNamed((await collect()).screen, "164").gpuGraphs;
    expect(gpu.index).toBe(0);
    const graphs = okValue(gpu.graphs);
    expect(graphs.utilization).toMatchObject({ title: "GPU 0 사용률", unit: "percent", lineSummaries: [{ label: "평균", latest: 40, maximum: 80 }] });
    expect(graphs.memory).toMatchObject({ title: "GPU 0 메모리", unit: "percent", lineSummaries: [{ label: "평균", latest: 25, maximum: 50 }] });
    expect(graphs.memory.chart.lines.map((line) => line.key)).toEqual(["mem_used", "mem_used_max"]);
  });

  it("고른 컨테이너 — CPU 는 auto(minimumTop 100 — 코어 하나 = 100), 메모리는 바이트", async () => {
    fake.series.set(seriesKey("158", "container", "front-app"), { points: [
      observePoint("container", P0, { cpu_pct: [150, 230], mem_used: [119_000_000, 120_000_000] }),
      observePoint("container", P1, { cpu_pct: [90, 95], mem_used: [118_000_000, 119_000_000] }),
    ] });
    const query: ResourcesQuery = { range: "1h", container: { server: "158", container: "front-app" } };
    const { screen } = await collect({ query });
    const selected = screen.selectedContainer!;
    expect(selected).toMatchObject({ server: "158", container: "front-app", closeHref: resourcesHref({ range: "1h", container: null }) });
    const graphs = okValue(selected.graphs);
    expect(graphs.cpu).toMatchObject({ title: "front-app CPU", unit: "percent" });
    expect(graphs.cpu.chart).toEqual(expectedChart({ kind: "auto", minimumTop: 100 }, [
      { key: "cpu_pct", label: "평균", role: "average", points: [{ atMilliseconds: P0, value: 150 }, { atMilliseconds: P1, value: 90 }] },
      { key: "cpu_pct_max", label: "최댓값", role: "maximum", points: [{ atMilliseconds: P0, value: 230 }, { atMilliseconds: P1, value: 95 }] },
    ]));
    expect(graphs.cpu.summary).toBe("front-app CPU 1시간: 평균 최근 90.0% · 최댓값 230.0%");
    expect(graphs.memory).toMatchObject({ title: "front-app 메모리", unit: "bytes" });
    expect(graphs.memory.summary).toBe("front-app 메모리 1시간: 평균 최근 112.5 MiB · 최댓값 114.4 MiB");
  });

  it("고른 컨테이너가 없으면 null", async () => {
    expect((await collect()).screen.selectedContainer).toBeNull();
  });

  it("latest 에 없는 서버 · 이름이어도 그대로 조회한다(점이 없으면 기록 없음)", async () => {
    const { screen } = await collect({ query: { range: "1h", container: { server: "77", container: "ghost" } } });
    expect(okValue(screen.selectedContainer!.graphs).cpu.summary).toBe("ghost CPU 1시간: 기록 없음");
  });
});

describe("한 구역이 실패해도 나머지는 보인다", () => {
  it("한 서버의 host series 가 503 → 그 서버의 그래프만 unavailable, 현재 값 · 다른 서버는 그대로", async () => {
    fake.series.set(seriesKey("164", "host", null), { response: () => textResponse(leakyErrorBody(), 503) });
    const { screen } = await collect();
    expectFailure(serverNamed(screen, "164").hostGraphs, "unavailable", 503);
    expect(serverNamed(screen, "164").current.cpu.text).toBe("3.4%");
    okValue(serverNamed(screen, "158").hostGraphs);
    okValue(serverNamed(screen, "164").gpuGraphs[0].graphs);
    expectNoForbiddenText(screen);
  });

  it("GPU series 가 꼴이 틀림 → 그 GPU 그래프만 unparseable", async () => {
    fake.series.set(seriesKey("164", "gpu", "0"), { response: () => jsonBody({ success: true, data: { points: "x" } }) });
    const { screen } = await collect();
    expectFailure(serverNamed(screen, "164").gpuGraphs[0].graphs, "unparseable");
    okValue(serverNamed(screen, "164").hostGraphs);
  });

  it("latest 가 401 → servers 는 그 실패, 2단계 호출 없음, 고른 컨테이너는 그대로", async () => {
    fake.latest = () => textResponse(leakyErrorBody(), 401);
    const { screen } = await collect({ query: { range: "1h", container: { server: "158", container: "front-app" } } });
    expectFailure(screen.servers, "unauthorized", 401);
    expect(screen.hiddenServerCount).toBe(0);
    expect(screen.firingElsewhere).toEqual([]);
    expect(seriesCalls().map((call) => call.parameters.scope)).toEqual(["container"]);
    okValue(screen.selectedContainer!.graphs);
    expect(screen.rangeOptions).toHaveLength(4);
  });

  it("latest 꼴이 틀림 → unparseable, 화면은 뜬다", async () => {
    fake.latest = () => jsonBody({ success: true, data: { servers: "nope" } });
    const { screen } = await collect();
    expectFailure(screen.servers, "unparseable");
  });

  it("전부 닿지 않음 → 거부하지 않고 칸마다 unreachable", async () => {
    const fetch = createRoutedFetch(() => Promise.reject(leakyNetworkError()));
    const screen = await collectResourcesScreen(options(fetch, { query: { range: "1h", container: { server: "158", container: "front-app" } } }));
    expectFailure(screen.servers, "unreachable");
    expectFailure(screen.selectedContainer!.graphs, "unreachable");
    expectNoForbiddenText(screen);
  });

  it.each([["주소 빔", { observeUrl: "" }], ["주소가 http 아님", { observeUrl: "ftp://observe.example.test" }], ["비밀값 빔", { observeSecret: "" }]] as const)(
    "%s → 호출 없이 not_configured(고른 컨테이너 포함)", async (_label, overrides) => {
      const fetch = fakeFetch();
      const screen = await collectResourcesScreen(options(fetch, { ...overrides, query: { range: "1h", container: { server: "158", container: "front-app" } } }));
      expectFailure(screen.servers, "not_configured");
      expectFailure(screen.selectedContainer!.graphs, "not_configured");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("시간 — 1단계는 함께, 2단계는 latest 가 끝나는 대로(가짜 타이머)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("고른 컨테이너가 멈춰도 host series 는 latest 가 끝난 즉시 시작한다 · 전체는 5초 + α", async () => {
    const timeout = createTimerTimeoutSignal();
    const startedAt: Record<string, number> = {};
    const start = Date.now();
    const fetch = createRoutedFetch((url, init) => {
      const key = `${url.pathname}|${url.searchParams.get("scope") ?? ""}|${url.searchParams.get("server") ?? ""}`;
      startedAt[key] = Date.now() - start;
      if (url.pathname === "/metrics/latest") return respondAfter(1_000, () => observeLatestBody([observeLatestServer("158")]), init);
      if (url.searchParams.get("scope") === "container") return hangUntilAborted(init);
      return fake.handler(url, init);
    });
    const pending = track(collectResourcesScreen(options(fetch, { timeoutSignal: timeout.factory, query: { range: "1h", container: { server: "158", container: "front-app" } } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt["/metrics/latest||"]).toBe(0);
    expect(startedAt["/metrics/series|container|158"]).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(startedAt["/metrics/series|host|158"]).toBe(1_000);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pending.settled).toBe(true);
    const screen = pending.value!;
    okValue(serverNamed(screen, "158").hostGraphs);
    expectFailure(screen.selectedContainer!.graphs, "timeout");
  });

  it("latest 가 4.9초 · host series 가 멈춤 → 9.9초에 끝난다(각자 5초)", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((url, init) => {
      if (url.pathname === "/metrics/latest") return respondAfter(4_900, () => observeLatestBody([observeLatestServer("158")]), init);
      return hangUntilAborted(init);
    });
    const pending = track(collectResourcesScreen(options(fetch, { timeoutSignal: timeout.factory })));
    await vi.advanceTimersByTimeAsync(9_899);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expectFailure(serverNamed(pending.value!, "158").hostGraphs, "timeout");
  });

  it("latest 가 멈춤 → 5초에 끝난다(2단계 없음)", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((_url, init) => hangUntilAborted(init));
    const pending = track(collectResourcesScreen(options(fetch, { timeoutSignal: timeout.factory })));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pending.settled).toBe(true);
    expectFailure(pending.value!.servers, "timeout");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("실패 칸 목록(앱 로그용) — resourcesScreenFailures", () => {
  it("성공한 칸은 없고, 실패 칸은 이름 규칙대로 · 서버 이름순", async () => {
    fake.series.set(seriesKey("164", "host", null), { response: () => textResponse(leakyErrorBody(), 503) });
    fake.series.set(seriesKey("164", "gpu", "0"), { response: () => textResponse(leakyErrorBody(), 504) });
    fake.series.set(seriesKey("158", "host", null), { response: () => textResponse(leakyErrorBody(), 500) });
    const { screen } = await collect();
    expect(resourcesScreenFailures(screen).map(([name, result]) => [name, !result.ok && result.reason])).toEqual([
      ["host:158", "bad_status"], ["host:164", "unavailable"], ["gpu:164:0", "server_timeout"],
    ]);
  });

  it("latest · 고른 컨테이너의 실패", async () => {
    fake.latest = () => textResponse(leakyErrorBody(), 401);
    fake.series.set(seriesKey("158", "container", "front-app"), { response: () => textResponse(leakyErrorBody(), 422) });
    const { screen } = await collect({ query: { range: "1h", container: { server: "158", container: "front-app" } } });
    expect(resourcesScreenFailures(screen).map(([name, result]) => [name, !result.ok && result.reason])).toEqual([
      ["latest", "unauthorized"], ["container", "invalid_request"],
    ]);
  });

  it("전부 성공이면 빈 목록", async () => {
    expect(resourcesScreenFailures((await collect()).screen)).toEqual([]);
  });
});

describe("모델의 꼴", () => {
  it("UpstreamResult 칸은 성공이면 value, 실패면 고정 사유만", async () => {
    fake.series.set(seriesKey("158", "host", null), { response: () => textResponse(leakyErrorBody(), 500) });
    const { screen } = await collect();
    const graphs: UpstreamResult<unknown> = serverNamed(screen, "158").hostGraphs;
    expectFailure(graphs as never, "bad_status", 500);
    const okGraphs = okValue(serverNamed(screen, "164").hostGraphs);
    const views: GraphView[] = [okGraphs.cpu, okGraphs.memory, okGraphs.disk, okGraphs.network, okGraphs.diskIo];
    expect(views.map((view) => view.title)).toEqual(["CPU", "메모리", "디스크", "네트워크", "디스크 입출력"]);
  });
});
