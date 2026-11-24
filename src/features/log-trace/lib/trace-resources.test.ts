/** 연관 로그 "그때 서버 상태"의 자원 칸 — 명세 §2.6 "그 로그를 남긴 서비스가 있는 서버의 앞뒤 5분 자원 수치(CPU · 메모리 · 그 서비스 컨테이너의 CPU · 메모리).
 * 값이 없으면(보관 기간 밖 · 수집 전) '기록 없음'" · §10.4 "service 이름으로 시작하는 컨테이너(front → front-app)가 보인 서버를 고른다" ·
 * §11.5 "containers?server=&at= — 로그 시각으로 물어 그때 그 서비스가 있던 서버를 고른다(지금의 위치로 짐작하지 않는다)" · §11.6 · §15.1 ·
 * §2.3 "한 구역이 실패해도 다른 구역은 보인다". 클라이언트의 실패 종류 · 상한은 resource-metrics-client.test 가 본다 — 여기서는 전하는 꼴만. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_CONTAINER_NAMES, TRACE_RESOURCE_MAXIMUM_CALLS, TRACE_RESOURCE_SERVER_LIMIT, TRACE_RESOURCE_TEXT, TRACE_RESOURCE_WINDOW_MILLISECONDS,
  collectTraceResources, containerBelongsToService, serviceContainerName, type TraceResourcesOptions, type TraceResourcesView,
} from "@/features/log-trace/lib/trace-resources";
import { createFakeTraceObserve, type FakeTraceObserve } from "@/features/log-trace/lib/trace-resources-test-fakes";
import {
  DAY, MINUTE, SECOND, observeLatestBody, observeLatestServer, observePoint, observeSilentServer, seriesKey,
} from "@/features/resources/lib/resource-metrics-test-fakes";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, createRoutedFetch, createTimerTimeoutSignal, expectFailure, expectNoForbiddenText, headersOf,
  leakyErrorBody, okValue, respondAfter, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";

/** 고른 로그의 시각(밀리초가 0 이 아니다). */
const T = Date.UTC(2026, 10, 24, 11, 0, 0, 123);
const FROM = T - 5 * MINUTE;
const TO = T + 5 * MINUTE;

let fake: FakeTraceObserve;

function fakeFetch() {
  return createRoutedFetch((url, init) => {
    if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected host ${url.hostname}`);
    return fake.handler(url, init);
  });
}

function options(fetch: ReturnType<typeof createRoutedFetch>, overrides: Partial<TraceResourcesOptions> = {}): TraceResourcesOptions {
  return { observeUrl: FAKE_OBSERVE_URL, observeSecret: FAKE_OBSERVE_SECRET, fetch, atMilliseconds: T, service: Promise.resolve("front"), ...overrides };
}

async function collect(overrides: Partial<TraceResourcesOptions> = {}) {
  const fetch = fakeFetch();
  const view = await collectTraceResources(options(fetch, overrides));
  return { view, fetch };
}

function viewOf(view: TraceResourcesView | null): TraceResourcesView {
  expect(view).not.toBeNull();
  return view!;
}

function callsTo(path: string) {
  return fake.metrics.calls.filter((call) => call.path === path);
}

beforeEach(() => {
  fake = createFakeTraceObserve(() => observeLatestBody([observeLatestServer("158"), observeLatestServer("164"), observeSilentServer("9")]));
});

describe("서비스 ↔ 컨테이너", () => {
  it.each([
    ["front-app", "front", true], ["front-nginx", "front", true], ["front", "front", true], ["frontier-app", "front", false],
    ["backend-es", "backend", true], ["llm-ollama", "llm", true], ["observe-postgres", "observe", true], ["admin-app", "alert", false],
    ["app-front", "front", false], ["Front-app", "front", false],
  ] as const)("%s 는 %s 의 컨테이너인가 → %s", (seriesName, service, expected) => {
    expect(containerBelongsToService(seriesName, service)).toBe(expected);
  });

  it("값을 보일 컨테이너 — 표(각 저장소 compose 의 앱 컨테이너), 표에 없으면 <서비스>-app", () => {
    expect(SERVICE_CONTAINER_NAMES).toEqual({
      front: "front-app", backend: "backend-app", llm: "llm-wrapper", alert: "alert-app", observe: "observe-app", admin: "admin-app",
    });
    expect(serviceContainerName("llm")).toBe("llm-wrapper");
    expect(serviceContainerName("front")).toBe("front-app");
    expect(serviceContainerName("ci-cd")).toBe("ci-cd-app");
  });

  it("상수 — 창 앞뒤 5분 · 서버 10대 · 호출 상한 13", () => {
    expect(TRACE_RESOURCE_WINDOW_MILLISECONDS).toBe(5 * MINUTE);
    expect(TRACE_RESOURCE_SERVER_LIMIT).toBe(10);
    expect(TRACE_RESOURCE_MAXIMUM_CALLS).toBe(13);
    expect(TRACE_RESOURCE_TEXT).toEqual({ noRecord: "기록 없음", unknownServer: "어느 서버였는지 확인하지 못함" });
  });
});

describe("서버 찾기 — 로그 시각의 컨테이너로(§11.5)", () => {
  it("latest 1회 → 서버마다 containers(server, at=T) — 수신 없음 서버도 묻는다", async () => {
    await collect();
    expect(callsTo("/metrics/latest")).toHaveLength(1);
    expect(callsTo("/metrics/containers").map((call) => call.parameters).sort((left, right) => left.server.localeCompare(right.server)))
      .toEqual([{ server: "158", at: new Date(T).toISOString() }, { server: "164", at: new Date(T).toISOString() }, { server: "9", at: new Date(T).toISOString() }]);
  });

  it("그 서비스의 컨테이너가 보인 서버 — found, 그 서비스 컨테이너, 맞은 컨테이너들(이름순)", async () => {
    fake.containers.set("164", { seen: { "front-nginx": T, "front-app": T - MINUTE, "backend-app": T } });
    const view = viewOf((await collect()).view);
    expect(view).toMatchObject({ service: "front", atMilliseconds: T, fromMilliseconds: FROM, toMilliseconds: TO });
    expect(okValue(view.location)).toEqual({
      kind: "found", server: "164", serviceContainer: "front-app", containers: ["front-app", "front-nginx"], alsoSeenOn: [], uncheckedServers: [],
    });
  });

  it("지금의 위치가 아니라 그때의 위치 — latest 의 지금 컨테이너는 보지 않는다", async () => {
    fake.metrics.latest = () => observeLatestBody([observeLatestServer("158"), observeLatestServer("164")]);   // 둘 다 지금은 front-app-green 이 있다
    fake.containers.set("164", { seen: { "front-app": T } });
    expect(okValue(viewOf((await collect()).view).location)).toMatchObject({ kind: "found", server: "164" });
  });

  it("여러 서버 — ① 그 서비스 컨테이너가 보인 서버가 먼저", async () => {
    fake.containers.set("158", { seen: { "front-app": T - 4 * MINUTE } });
    fake.containers.set("164", { seen: { "front-nginx": T } });
    expect(okValue(viewOf((await collect()).view).location)).toMatchObject({ kind: "found", server: "158", serviceContainer: "front-app", alsoSeenOn: ["164"] });
  });

  it("여러 서버 — ② 그 다음 last_seen_at 이 늦은 서버, ③ 같으면 이름순", async () => {
    fake.containers.set("158", { seen: { "front-nginx": T - MINUTE } });
    fake.containers.set("164", { seen: { "front-nginx": T } });
    fake.containers.set("9", { seen: { "front-nginx": T } });
    const location = okValue(viewOf((await collect()).view).location);
    expect(location).toMatchObject({ kind: "found", server: "164", serviceContainer: null, alsoSeenOn: ["158", "9"] });
  });

  it("경계 — front 는 frontier-app 을 잡지 않는다 → none", async () => {
    fake.containers.set("158", { seen: { "frontier-app": T } });
    const view = viewOf((await collect()).view);
    expect(okValue(view.location)).toEqual({ kind: "none" });
  });

  it("모두 답했는데 없다 → none('기록 없음'), 계열을 부르지 않는다", async () => {
    fake.containers.set("158", { seen: { "backend-app": T } });
    const view = viewOf((await collect()).view);
    expect(okValue(view.location)).toEqual({ kind: "none" });
    expect(view.host).toBeNull();
    expect(view.container).toBeNull();
    expect(callsTo("/metrics/series")).toHaveLength(0);
  });

  it("서버가 0대 → none", async () => {
    fake.metrics.latest = () => observeLatestBody([]);
    const view = viewOf((await collect()).view);
    expect(okValue(view.location)).toEqual({ kind: "none" });
    expect(callsTo("/metrics/containers")).toHaveLength(0);
  });

  it("일부 서버의 containers 가 실패하고 나머지에서 못 찾음 → unknown('어느 서버였는지 확인하지 못함')", async () => {
    fake.containers.set("164", { response: () => textResponse(leakyErrorBody(), 503) });
    fake.containers.set("9", { response: () => textResponse(leakyErrorBody(), 504) });
    const view = viewOf((await collect()).view);
    expect(okValue(view.location)).toEqual({ kind: "unknown", failedServers: ["164", "9"] });
    expect(view.host).toBeNull();
    expect(callsTo("/metrics/series")).toHaveLength(0);
    expectNoForbiddenText(view);
  });

  it("실패한 서버가 있어도 다른 서버에서 찾으면 found(uncheckedServers 에 남긴다)", async () => {
    fake.containers.set("158", { seen: { "front-app": T } });
    fake.containers.set("164", { response: () => textResponse(leakyErrorBody(), 503) });
    expect(okValue(viewOf((await collect()).view).location)).toMatchObject({ kind: "found", server: "158", uncheckedServers: ["164"] });
  });

  it("latest 실패 → location 이 그 실패, containers · 계열을 부르지 않는다", async () => {
    fake.metrics.latest = () => textResponse(leakyErrorBody(), 401);
    const view = viewOf((await collect()).view);
    expectFailure(view.location, "unauthorized", 401);
    expect(view.host).toBeNull();
    expect(view.container).toBeNull();
    expect(callsTo("/metrics/containers")).toHaveLength(0);
    expect(callsTo("/metrics/series")).toHaveLength(0);
  });

  it(`서버가 많아도 containers 는 이름순 앞 ${TRACE_RESOURCE_SERVER_LIMIT}대 — 전체 호출 ≤ ${TRACE_RESOURCE_MAXIMUM_CALLS}`, async () => {
    const names = Array.from({ length: 14 }, (_, index) => `s${String(index).padStart(2, "0")}`);
    fake.metrics.latest = () => observeLatestBody([...names].reverse().map((name) => observeLatestServer(name)));
    fake.containers.set("s03", { seen: { "front-app": T } });
    const { fetch, view } = await collect();
    expect(callsTo("/metrics/containers").map((call) => call.parameters.server).sort()).toEqual(names.slice(0, 10));
    expect(okValue(viewOf(view).location)).toMatchObject({ kind: "found", server: "s03" });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(TRACE_RESOURCE_MAXIMUM_CALLS);
    expect(fetch.mock.calls.length).toBe(1 + 10 + 2);
  });

  it("모든 호출은 GET · X-Observe-Secret", async () => {
    fake.containers.set("158", { seen: { "front-app": T } });
    const { fetch } = await collect();
    for (const [, init] of fetch.mock.calls) {
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
      expect(headersOf(init).get("X-Observe-Secret")).toBe(FAKE_OBSERVE_SECRET);
    }
  });
});

describe("그때의 값 — 앞뒤 5분 계열", () => {
  const STEP = 30 * SECOND;

  beforeEach(() => {
    fake.containers.set("158", { seen: { "front-app": T, "front-nginx": T } });
    fake.metrics.series.set(seriesKey("158", "host", null), { stepMilliseconds: STEP, points: [
      observePoint("host", T - STEP, { cpu_pct: [10, 20], mem_used: [4e9, 5e9], mem_total: [16e9, 16e9], disk_used: [100, 100], disk_total: [1000, 1000] }),
      observePoint("host", T, { cpu_pct: [30, 90], mem_used: [8e9, 8e9], mem_total: [16e9, 16e9], disk_used: [200, 300], disk_total: [1000, 1000] }),
      observePoint("host", T + STEP, { cpu_pct: [null, null], mem_used: [9e9, 9e9] }),
    ] });
    fake.metrics.series.set(seriesKey("158", "container", "front-app"), { stepMilliseconds: STEP, points: [
      observePoint("container", T - STEP, { cpu_pct: [150, 230], mem_used: [119_000_000, 120_000_000] }),
    ] });
  });

  it("계열 호출 — host 와 그 서비스 컨테이너(자리 이름을 뗀 이름), 기간은 T ± 5분", async () => {
    await collect();
    const from = new Date(FROM).toISOString();
    const to = new Date(TO).toISOString();
    expect(callsTo("/metrics/series").map((call) => call.parameters)).toEqual(expect.arrayContaining([
      { server: "158", scope: "host", from, to }, { server: "158", scope: "container", name: "front-app", from, to },
    ]));
    expect(callsTo("/metrics/series")).toHaveLength(2);
  });

  it("host — CPU · 메모리 · 디스크: 로그 시각이 든 점의 평균과 창의 최댓값", async () => {
    const host = okValue(viewOf((await collect()).view).host!);
    expect(host).toMatchObject({ source: "raw", stepMilliseconds: STEP, pointCount: 3, noRecord: false });
    expect(host.values).toEqual([
      { label: "CPU", unit: "percent", atLogValue: 30, atLogText: "30.0%", maximumValue: 90, maximumText: "90.0%" },
      { label: "메모리", unit: "percent", atLogValue: 50, atLogText: "50.0%", maximumValue: 50, maximumText: "50.0%" },
      { label: "디스크", unit: "percent", atLogValue: 20, atLogText: "20.0%", maximumValue: 30, maximumText: "30.0%" },
    ]);
  });

  it("컨테이너 — CPU(100 을 넘을 수 있다) · 메모리(바이트), 로그 시각이 든 점이 없으면 '없음'", async () => {
    const container = okValue(viewOf((await collect()).view).container!);
    expect(container.values).toEqual([
      { label: "CPU", unit: "percent", atLogValue: null, atLogText: "없음", maximumValue: 230, maximumText: "230.0%" },
      { label: "메모리", unit: "bytes", atLogValue: null, atLogText: "없음", maximumValue: 120_000_000, maximumText: "114.4 MiB" },
    ]);
  });

  it("점이 없다(보관 기간 밖 · 수집 전) → noRecord('기록 없음'), 값은 '없음'", async () => {
    fake.metrics.series.set(seriesKey("158", "host", null), { stepMilliseconds: STEP, points: [] });
    const host = okValue(viewOf((await collect()).view).host!);
    expect(host).toMatchObject({ pointCount: 0, noRecord: true });
    for (const value of host.values) expect(value).toMatchObject({ atLogValue: null, atLogText: "없음", maximumValue: null, maximumText: "없음" });
  });

  it("_max 가 하나도 없으면 평균의 최대", async () => {
    fake.metrics.series.set(seriesKey("158", "host", null), { stepMilliseconds: STEP, points: [
      observePoint("host", T - STEP, { cpu_pct: [40, null] }), observePoint("host", T, { cpu_pct: [25, null] }),
    ] });
    expect(okValue(viewOf((await collect()).view).host!).values[0]).toMatchObject({ atLogValue: 25, maximumValue: 40 });
  });

  it("그 서비스 컨테이너가 그 서버에 안 보였으면 container 는 null(호출 없음), host 는 보인다", async () => {
    fake.containers.set("158", { seen: { "front-nginx": T } });
    const view = viewOf((await collect()).view);
    expect(okValue(view.location)).toMatchObject({ kind: "found", serviceContainer: null });
    expect(view.container).toBeNull();
    okValue(view.host!);
    expect(callsTo("/metrics/series").map((call) => call.parameters.scope)).toEqual(["host"]);
  });

  it("host 계열 실패 → host 만 그 실패, 컨테이너는 보인다", async () => {
    fake.metrics.series.set(seriesKey("158", "host", null), { response: () => textResponse(leakyErrorBody(), 503) });
    const view = viewOf((await collect()).view);
    expectFailure(view.host!, "unavailable", 503);
    okValue(view.container!);
    okValue(view.location);
    expectNoForbiddenText(view);
  });

  it("7일보다 오래된 로그 — 관측 서버가 고른 5분 평균(rollup)과 간격을 그대로, 구간 시작이 from 보다 앞선 점도 쓴다(§15.1)", async () => {
    const old = T - 10 * DAY;
    const bucket = Math.floor(old / (5 * MINUTE)) * 5 * MINUTE;
    fake.containers.set("158", { seen: { "front-app": old } });
    fake.metrics.series.set(seriesKey("158", "host", null), { source: "rollup", stepMilliseconds: 5 * MINUTE, points: [
      observePoint("host", bucket - 5 * MINUTE, { cpu_pct: [11, 12] }), observePoint("host", bucket, { cpu_pct: [21, 22] }),
    ] });
    const host = okValue(viewOf((await collect({ atMilliseconds: old })).view).host!);
    expect(host).toMatchObject({ source: "rollup", stepMilliseconds: 5 * MINUTE, pointCount: 2 });
    expect(host.values[0]).toMatchObject({ atLogValue: 21, maximumValue: 22 });
  });
});

describe("서비스를 모를 때 · 설정이 없을 때", () => {
  it("service 가 null(고른 로그를 확인하지 못함) → null, 계열을 부르지 않는다", async () => {
    fake.containers.set("158", { seen: { "front-app": T } });
    const { view } = await collect({ service: Promise.resolve(null) });
    expect(view).toBeNull();
    expect(callsTo("/metrics/series")).toHaveLength(0);
  });

  it.each([["주소 빔", { observeUrl: "" }], ["비밀값 빔", { observeSecret: "" }]] as const)("%s → 호출 없이 location not_configured", async (_label, overrides) => {
    const { view, fetch } = await collect(overrides);
    expectFailure(viewOf(view).location, "not_configured");
    expect(viewOf(view).host).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("설정이 없고 service 가 null → null", async () => {
    expect((await collect({ observeUrl: "", service: Promise.resolve(null) })).view).toBeNull();
  });
});

describe("시간 — 서버 찾기는 서비스를 기다리지 않는다(가짜 타이머)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((settle) => { resolve = settle; });
    return { promise, resolve };
  }

  it("latest 1초 · containers 2초 · 서비스 3초 → 계열은 3초에 시작, 그 전에 끝나지 않는다", async () => {
    const timeout = createTimerTimeoutSignal();
    const service = deferred<string | null>();
    const startedAt: Record<string, number> = {};
    const start = Date.now();
    fake.containers.set("158", { seen: { "front-app": T } });
    const fetch = createRoutedFetch((url, init) => {
      startedAt[`${url.pathname}|${url.searchParams.get("server") ?? ""}|${url.searchParams.get("scope") ?? ""}`] = Date.now() - start;
      if (url.pathname === "/metrics/latest") return respondAfter(1_000, () => observeLatestBody([observeLatestServer("158")]), init);
      if (url.pathname === "/metrics/containers") return respondAfter(1_000, () => fake.handler(url, init) as Response, init);
      return fake.handler(url, init);
    });
    setTimeout(() => service.resolve("front"), 3_000);
    const pending = track(collectTraceResources(options(fetch, { timeoutSignal: timeout.factory, service: service.promise })));
    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt["/metrics/latest||"]).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(startedAt["/metrics/containers|158|"]).toBe(1_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(startedAt["/metrics/series|158|host"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(startedAt["/metrics/series|158|host"]).toBe(3_000);
    expect(startedAt["/metrics/series|158|container"]).toBe(3_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.settled).toBe(true);
    okValue(pending.value!.host!);
  });

  it("서비스가 먼저 풀려도 서버 찾기가 끝난 뒤에 계열(containers 4초 → 계열 4초)", async () => {
    const timeout = createTimerTimeoutSignal();
    const startedAt: Record<string, number> = {};
    const start = Date.now();
    fake.containers.set("158", { seen: { "front-app": T } });
    const fetch = createRoutedFetch((url, init) => {
      startedAt[`${url.pathname}|${url.searchParams.get("scope") ?? ""}`] = Date.now() - start;
      if (url.pathname === "/metrics/latest") return observeLatestBody([observeLatestServer("158")]);
      if (url.pathname === "/metrics/containers") return respondAfter(4_000, () => fake.handler(url, init) as Response, init);
      return fake.handler(url, init);
    });
    const pending = track(collectTraceResources(options(fetch, { timeoutSignal: timeout.factory })));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(startedAt["/metrics/series|host"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(startedAt["/metrics/series|host"]).toBe(4_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.settled).toBe(true);
  });

  it("서비스가 null 로 풀리면 그때 끝난다(서버 찾기를 기다리지 않는다)", async () => {
    const timeout = createTimerTimeoutSignal();
    const service = deferred<string | null>();
    const fetch = createRoutedFetch((url, init) => respondAfter(4_000, () => fake.handler(url, init) as Response, init));
    setTimeout(() => service.resolve(null), 500);
    const pending = track(collectTraceResources(options(fetch, { timeoutSignal: timeout.factory, service: service.promise })));
    await vi.advanceTimersByTimeAsync(500);
    expect(pending.settled).toBe(true);
    expect(pending.value).toBeNull();
  });
});
