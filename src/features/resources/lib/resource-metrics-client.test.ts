/** 관측 서버 자원 지표 조회 클라이언트 — 명세 §10.3 "관측 서버의 조회 API(어드민이 부른다 — 전부 GET, X-Observe-Secret)" · §2.3 "인증" ·
 * "조회는 상한을 둔다: 기간 최대 31일, 한 계열에 점 최대 500개" · §5 "admin: 데이터 계층(응답을 믿지 않는다 — 꼴이 다르면 해석 불가)" ·
 * §11.5 "조회의 name 은 자리 이름을 뗀 이름" · §11.6 "step_ms · source(raw · rollup · mixed)" · §15 "latest 의 age_ms · stale" ·
 * §15.1 "첫 점의 시각이 from 보다 최대 5분 앞설 수 있다" · §16 "보일 값이 없는 서버는 '수신 없음'(마지막 수신 시각은 낸다)".
 * 계약 = observe metric/MetricController.kt:19-39 · 83-203 · README "조회 API". 관측 서버 리뷰 중 — 모르는 칸이 더 와도 깨지지 않고, 빠진 칸은 null(확인하지 못함). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESOURCE_RESPONSE_MAXIMUM_BYTES, RESOURCE_SCOPE_VALUE_NAMES, RESOURCE_SERIES_MAXIMUM_POINTS, RESOURCE_SERIES_MAXIMUM_RANGE_MILLISECONDS,
  createResourceMetricsClient, seriesNameOf, type SeriesRequest,
} from "@/features/resources/lib/resource-metrics-client";
import {
  CONTAINER_VALUE_NAMES, DAY, GPU_VALUE_NAMES, HOST_VALUE_NAMES, HOUR, MINUTE, NOW_MILLISECONDS, javaInstantText, observeContainer, observeFiring,
  observeGpu, observeHost, observeLatestBody, observeLatestServer, observePoint, observeSilentServer,
} from "@/features/resources/lib/resource-metrics-test-fakes";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, SECRET_HEADER_NAMES, UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal, expectFailure,
  expectNoForbiddenText, expectReadOnlyRequest, hangUntilAborted, headersOf, headersThenStalledBody, jsonBody, leakyErrorBody, leakyNetworkError,
  okValue, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";

type RoutedFetch = ReturnType<typeof createRoutedFetch>;

function client(fetch: RoutedFetch, overrides: { baseUrl?: string; secret?: string; timeoutSignal?: (milliseconds: number) => AbortSignal } = {}) {
  return createResourceMetricsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch, ...overrides });
}

const FROM = NOW_MILLISECONDS - HOUR;
const TO = NOW_MILLISECONDS;

function hostRequest(overrides: Partial<SeriesRequest> = {}): SeriesRequest {
  return { server: "158", scope: "host", name: null, fromMilliseconds: FROM, toMilliseconds: TO, ...overrides };
}

/** series 응답 본문(실제 컨트롤러 꼴 — from · to 는 Instant 글자). */
function seriesData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: "158", scope: "host", name: null, from: javaInstantText(FROM), to: javaInstantText(TO), step_ms: 30_000, source: "raw",
    points: [], extra: UPSTREAM_RAW_MARKER, ...overrides,
  };
}

function seriesBody(overrides: Record<string, unknown> = {}): Response {
  return jsonBody({ success: true, data: seriesData(overrides) });
}

function withoutKeys(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}

describe("seriesNameOf — 자리 이름 떼기(observe ContainerName.seriesName 과 같은 규칙)", () => {
  it.each([
    ["front-app-green", "front-app"], ["front-app-blue", "front-app"], ["llm-ollama", "llm-ollama"], ["claude-bridge-relay", "claude-bridge-relay"],
    ["-blue", "-blue"], ["x-blue-green", "x-blue"], ["front-app-Green", "front-app-Green"], ["blue", "blue"], ["front-appblue", "front-appblue"],
  ])("%s → %s", (name, seriesName) => {
    expect(seriesNameOf(name)).toBe(seriesName);
  });
});

describe("상수 — 관측 서버와 같은 상한", () => {
  it("점 500 · 기간 31일 · 본문 1 MiB · 갈래마다의 값 이름", () => {
    expect(RESOURCE_SERIES_MAXIMUM_POINTS).toBe(500);
    expect(RESOURCE_SERIES_MAXIMUM_RANGE_MILLISECONDS).toBe(31 * DAY);
    expect(RESOURCE_RESPONSE_MAXIMUM_BYTES).toBe(1_048_576);
    expect(RESOURCE_SCOPE_VALUE_NAMES).toEqual({ host: [...HOST_VALUE_NAMES], container: [...CONTAINER_VALUE_NAMES], gpu: [...GPU_VALUE_NAMES] });
  });
});

describe("요청 — 전부 GET · X-Observe-Secret 만 · redirect manual · 5초", () => {
  it("latest — GET <base>/metrics/latest, 인자 없음(끝의 / 허용)", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([]));
    await client(fetch, { baseUrl: `${FAKE_OBSERVE_URL}/` }).latest();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(`${url.origin}${url.pathname}`).toBe(`${FAKE_OBSERVE_URL}/metrics/latest`);
    expect(url.search).toBe("");
    expectReadOnlyRequest(init);
    expect(init?.redirect).toBe("manual");
    for (const name of SECRET_HEADER_NAMES) {
      expect(headersOf(init).get(name)).toBe(name === "x-observe-secret" ? FAKE_OBSERVE_SECRET : null);
    }
  });

  it("series(host) — server · scope · from · to 순서, name 없음, 시각은 toISOString", async () => {
    const fetch = createRoutedFetch(() => seriesBody());
    await client(fetch).series(hostRequest());
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.pathname).toBe("/metrics/series");
    expect(url.search).toBe(`?server=158&scope=host&from=${encodeURIComponent(new Date(FROM).toISOString())}&to=${encodeURIComponent(new Date(TO).toISOString())}`);
    expect(url.searchParams.has("name")).toBe(false);
    expectReadOnlyRequest(init);
    expect(init?.redirect).toBe("manual");
    expect(headersOf(init).get("X-Observe-Secret")).toBe(FAKE_OBSERVE_SECRET);
  });

  it("series(container) — server · scope · name · from · to 순서", async () => {
    const fetch = createRoutedFetch(() => seriesBody({ scope: "container", name: "front-app" }));
    await client(fetch).series(hostRequest({ scope: "container", name: "front-app" }));
    const url = new URL(fetch.mock.calls[0][0]);
    expect([...url.searchParams.keys()]).toEqual(["server", "scope", "name", "from", "to"]);
    expect(url.searchParams.get("name")).toBe("front-app");
  });

  it("series(gpu) — name 은 번호 글자", async () => {
    const fetch = createRoutedFetch(() => seriesBody({ scope: "gpu", name: "0" }));
    await client(fetch).series(hostRequest({ scope: "gpu", name: "0" }));
    expect(Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams)).toMatchObject({ scope: "gpu", name: "0" });
  });

  it("containers — at 이 null 이면 server 만, 있으면 server · at(toISOString)", async () => {
    const fetch = createRoutedFetch(() => jsonBody({ success: true, data: { server: "158", from: javaInstantText(FROM), to: javaInstantText(TO), containers: [] } }));
    await client(fetch).containers("158", null);
    await client(fetch).containers("158", NOW_MILLISECONDS);
    expect(new URL(fetch.mock.calls[0][0]).search).toBe("?server=158");
    const second = new URL(fetch.mock.calls[1][0]);
    expect(second.pathname).toBe("/metrics/containers");
    expect(second.search).toBe(`?server=158&at=${encodeURIComponent(new Date(NOW_MILLISECONDS).toISOString())}`);
  });

  it("세 경로 모두 제한 시간 신호를 5000ms 로", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((url) => (url.pathname === "/metrics/latest" ? observeLatestBody([]) : seriesBody()));
    const metrics = client(fetch, { timeoutSignal: timeout.factory });
    await metrics.latest();
    await metrics.series(hostRequest());
    await metrics.containers("158", null);
    expect(timeout.requestedMilliseconds).toEqual([5_000, 5_000, 5_000]);
  });
});

describe("부르기 전 거절 — 호출하지 않는다", () => {
  it.each([
    ["주소 빔", { baseUrl: "" }], ["주소가 http(s) 아님", { baseUrl: "ftp://observe.example.test" }], ["주소가 아님", { baseUrl: "observe" }],
    ["비밀값 빔", { secret: "" }],
  ] as const)("%s → 세 경로 모두 not_configured", async (_label, overrides) => {
    const fetch = createRoutedFetch(() => observeLatestBody([]));
    const metrics = client(fetch, overrides);
    expectFailure(await metrics.latest(), "not_configured");
    expectFailure(await metrics.series(hostRequest()), "not_configured");
    expectFailure(await metrics.containers("158", null), "not_configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["server 대문자", { server: "Home" }, "server"],
    ["server 빔", { server: "" }, "server"],
    ["server 에 &", { server: "158&scope=gpu" }, "server"],
    ["scope 밖", { scope: "disk" as SeriesRequest["scope"] }, "scope"],
    ["host 에 name", { name: "front-app" }, "name"],
    ["container 에 name 없음", { scope: "container" as const, name: null }, "name"],
    ["container name 꼴", { scope: "container" as const, name: "front/app" }, "name"],
    ["gpu name 이 글자", { scope: "gpu" as const, name: "a" }, "name"],
    ["gpu name 네 자리", { scope: "gpu" as const, name: "1000" }, "name"],
    ["from 이 NaN", { fromMilliseconds: Number.NaN }, "from"],
    ["from 이 소수", { fromMilliseconds: FROM + 0.5 }, "from"],
    ["to 가 Infinity", { toMilliseconds: Number.POSITIVE_INFINITY }, "to"],
    ["거꾸로", { fromMilliseconds: TO, toMilliseconds: FROM }, "range"],
    ["31일 + 1ms", { fromMilliseconds: TO - 31 * DAY - 1 }, "range"],
  ] as const)("series — %s → invalid_input(%s)", async (_label, overrides, field) => {
    const fetch = createRoutedFetch(() => seriesBody());
    const result = await client(fetch).series(hostRequest(overrides as Partial<SeriesRequest>));
    expectFailure(result, "invalid_input");
    expect(!result.ok && result.field).toBe(field);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("series — 정확히 31일은 부른다(관측 서버도 받는다)", async () => {
    const fetch = createRoutedFetch(() => seriesBody({ from: javaInstantText(TO - 31 * DAY) }));
    await client(fetch).series(hostRequest({ fromMilliseconds: TO - 31 * DAY }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["server 꼴", "UPPER", null, "server"],
    ["at 이 NaN", "158", Number.NaN, "at"],
  ] as const)("containers — %s → invalid_input(%s)", async (_label, server, at, field) => {
    const fetch = createRoutedFetch(() => jsonBody({}));
    const result = await client(fetch).containers(server, at);
    expectFailure(result, "invalid_input");
    expect(!result.ok && result.field).toBe(field);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("latest — 칸 고르기", () => {
  it("값이 있는 서버 · GPU 서버 · 수신 없음 — 필요한 칸만(id · project · 계약 밖 칸 없음), 받은 순서 그대로", async () => {
    const servers = [
      observeLatestServer("164", { gpus: [observeGpu()], containers: [observeContainer({ name: "llm-ollama", series_name: "llm-ollama", cpu_pct: 250, restarts: 4, state: "restarting" })] }),
      observeLatestServer("158", { missing: ["gpus"] }),
      observeSilentServer("9"),
    ];
    const fetch = createRoutedFetch(() => observeLatestBody(servers, [observeFiring({ extra: UPSTREAM_RAW_MARKER })]));
    const latest = okValue(await client(fetch).latest());
    const host = {
      cpuPct: 3.4, load1: 0.11, memTotal: 16_000_000_000, memUsed: 2_100_000_000, diskTotal: 500_235_124_736, diskUsed: 80_570_650_624,
      netRxBps: 1200, netTxBps: 3400, ioReadBps: 0, ioWriteBps: 52_000,
    };
    expect(latest).toStrictEqual({
      servers: [
        {
          server: "164", measuredAt: javaInstantText(NOW_MILLISECONDS - 20_000), receivedAt: javaInstantText(NOW_MILLISECONDS - 19_000),
          ageMilliseconds: 19_250, stale: false, host,
          containers: [{ name: "llm-ollama", seriesName: "llm-ollama", state: "restarting", cpuPct: 250, memUsed: 119_000_000, restarts: 4 }],
          gpus: [{ index: 0, utilPct: 12, memUsed: 9_437_184, memTotal: 8_589_934_592, tempC: 28 }], missing: [],
        },
        {
          server: "158", measuredAt: javaInstantText(NOW_MILLISECONDS - 20_000), receivedAt: javaInstantText(NOW_MILLISECONDS - 19_000),
          ageMilliseconds: 19_250, stale: false, host,
          containers: [{ name: "front-app-green", seriesName: "front-app", state: "running", cpuPct: 0.7, memUsed: 119_000_000, restarts: 0 }],
          gpus: [], missing: ["gpus"],
        },
        { server: "9", measuredAt: null, receivedAt: null, ageMilliseconds: null, stale: true, host: null, containers: [], gpus: [], missing: [] },
      ],
      unreadableServerNameCount: 0,
      firing: [{ server: "158", rule: "disk_warning", target: null, severity: "warning", since: javaInstantText(NOW_MILLISECONDS - 30 * MINUTE), lastValue: 86.2 }],
    });
    expectNoForbiddenText(latest);
    expect(JSON.stringify(latest)).not.toContain("0123456789ab");
  });

  it("수신 없음이지만 마지막 수신 시각이 있는 서버(§16) — 받은 그대로", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([
      observeSilentServer("9", { received_at: javaInstantText(NOW_MILLISECONDS - 3 * DAY), age_ms: 3 * DAY }),
    ]));
    expect(okValue(await client(fetch).latest()).servers[0]).toMatchObject({ measuredAt: null, receivedAt: javaInstantText(NOW_MILLISECONDS - 3 * DAY), ageMilliseconds: 3 * DAY, stale: true, host: null });
  });

  it("빈 목록 · firing 빈 배열", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([], []));
    expect(okValue(await client(fetch).latest())).toStrictEqual({ servers: [], unreadableServerNameCount: 0, firing: [] });
  });

  it("빠진 칸은 null(확인하지 못함) — 서버 줄의 at · received_at · age_ms · stale · host · containers · gpus · missing, firing", async () => {
    const row = withoutKeys(observeLatestServer("158"), ["at", "received_at", "age_ms", "stale", "host", "containers", "gpus", "missing"]);
    const fetch = createRoutedFetch(() => observeLatestBody([row], undefined));
    expect(okValue(await client(fetch).latest())).toStrictEqual({
      servers: [{ server: "158", measuredAt: null, receivedAt: null, ageMilliseconds: null, stale: null, host: null, containers: null, gpus: null, missing: null }],
      unreadableServerNameCount: 0,
      firing: null,
    });
  });

  it("null 인 칸도 null — host 의 값 하나 · 컨테이너 상태 · GPU 온도 · firing 의 target · last_value", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("164", {
      host: observeHost({ cpu_pct: null, net_rx_bps: null }), containers: [observeContainer({ state: null, cpu_pct: null, restarts: null })],
      gpus: [observeGpu({ temp_c: null, util_pct: null })], firing: undefined,
    })], [observeFiring({ server: "164", rule: "silent", target: null, last_value: null })]));
    const latest = okValue(await client(fetch).latest());
    expect(latest.servers[0].host).toMatchObject({ cpuPct: null, netRxBps: null, memUsed: 2_100_000_000 });
    expect(latest.servers[0].containers?.[0]).toMatchObject({ state: null, cpuPct: null, restarts: null });
    expect(latest.servers[0].gpus?.[0]).toMatchObject({ tempC: null, utilPct: null });
    expect(latest.firing?.[0]).toMatchObject({ target: null, lastValue: null });
  });

  it("host 의 값 이름이 빠지면 그 값만 null(나머지는 그대로)", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("158", { host: withoutKeys(observeHost(), ["io_read_bps", "load1"]) })]));
    expect(okValue(await client(fetch).latest()).servers[0].host).toMatchObject({ ioReadBps: null, load1: null, cpuPct: 3.4 });
  });

  it("series_name 이 없으면 자리 이름을 떼어 만든다", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("158", { containers: [withoutKeys(observeContainer({ name: "backend-api-blue" }), ["series_name"])] })]));
    expect(okValue(await client(fetch).latest()).servers[0].containers?.[0]).toMatchObject({ name: "backend-api-blue", seriesName: "backend-api" });
  });

  it("모르는 낱말(상태 · 규칙 · 심각도)도 그대로 — 열거로 거절하지 않는다", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody(
      [observeLatestServer("158", { containers: [observeContainer({ state: "brand-new-state" })] })],
      [observeFiring({ rule: "brand_new_rule", severity: "info" })],
    ));
    const latest = okValue(await client(fetch).latest());
    expect(latest.servers[0].containers?.[0].state).toBe("brand-new-state");
    expect(latest.firing?.[0]).toMatchObject({ rule: "brand_new_rule", severity: "info" });
  });

  it("모르는 칸이 더 와도 깨지지 않는다(서버 줄 · host · 컨테이너 · GPU · firing · data)", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody(
      [observeLatestServer("158", { host: observeHost({ swap_used: 1 }), containers: [observeContainer({ health: "ok" })], gpus: [observeGpu({ power_w: 50 })], clock_behind: true })],
      [observeFiring({ title: UPSTREAM_RAW_MARKER })],
    ));
    const latest = okValue(await client(fetch).latest());
    expect(Object.keys(latest.servers[0].host ?? {}).sort()).toEqual(["cpuPct", "diskTotal", "diskUsed", "ioReadBps", "ioWriteBps", "load1", "memTotal", "memUsed", "netRxBps", "netTxBps"]);
    expectNoForbiddenText(latest);
  });

  it("음수 age_ms(두 자리의 시계 차)는 받는다", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("158", { age_ms: -1200 })]));
    expect(okValue(await client(fetch).latest()).servers[0].ageMilliseconds).toBe(-1200);
  });

  it("GPU 온도는 음수도 받는다", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("164", { gpus: [observeGpu({ temp_c: -3 })] })]));
    expect(okValue(await client(fetch).latest()).servers[0].gpus?.[0].tempC).toBe(-3);
  });

  // 이름(server)이 틀린 줄은 전체 실패가 아니라 그 줄만 버린다(§18) — 아래 "이름을 읽지 못한 서버 줄" 묶음이 본다
  const malformedServers: [string, Record<string, unknown>][] = [
    ["at 이 시각이 아님", { at: "yesterday" }],
    ["at 이 숫자", { at: 1763985600000 }],
    ["received_at 이 시각이 아님", { received_at: "2026-11-31T00:00:00Z" }],
    ["age_ms 가 글자", { age_ms: "19250" }],
    ["age_ms 가 소수", { age_ms: 1.5 }],
    ["stale 이 글자", { stale: "false" }],
    ["host 가 배열", { host: [] }],
    ["host 값이 글자", { host: observeHost({ cpu_pct: "3.4" }) }],
    ["host 값이 참거짓", { host: observeHost({ mem_used: true }) }],
    ["host 값이 음수", { host: observeHost({ disk_used: -1 }) }],
    ["containers 가 객체", { containers: {} }],
    ["컨테이너가 객체 아님", { containers: ["front-app"] }],
    ["컨테이너 name 빠짐", { containers: [withoutKeys(observeContainer(), ["name"])] }],
    ["컨테이너 name 꼴", { containers: [observeContainer({ name: "front app" })] }],
    ["컨테이너 series_name 이 숫자", { containers: [observeContainer({ series_name: 1 })] }],
    ["컨테이너 state 가 숫자", { containers: [observeContainer({ state: 1 })] }],
    ["컨테이너 restarts 소수", { containers: [observeContainer({ restarts: 1.5 })] }],
    ["컨테이너 cpu 음수", { containers: [observeContainer({ cpu_pct: -0.1 })] }],
    ["gpus 가 글자", { gpus: "none" }],
    ["GPU index 빠짐", { gpus: [withoutKeys(observeGpu(), ["index"])] }],
    ["GPU index 1000", { gpus: [observeGpu({ index: 1000 })] }],
    ["GPU index 소수", { gpus: [observeGpu({ index: 0.5 })] }],
    ["GPU util 글자", { gpus: [observeGpu({ util_pct: "12" })] }],
    ["missing 이 글자", { missing: "gpus" }],
    ["missing 안에 숫자", { missing: [1] }],
  ];

  it.each(malformedServers)("서버 줄의 %s → 전체 unparseable", async (_label, overrides) => {
    const row = observeLatestServer("158", overrides);
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete row[key];
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("164"), row]));
    expectFailure(await client(fetch).latest(), "unparseable");
  });

  const malformedFiring: [string, Record<string, unknown>][] = [
    ["server 빠짐", { server: undefined }],
    ["rule 이 숫자", { rule: 1 }],
    ["severity 빠짐", { severity: undefined }],
    ["since 가 시각이 아님", { since: "now" }],
    ["since 빠짐", { since: undefined }],
    ["target 이 숫자", { target: 3 }],
    ["last_value 가 글자", { last_value: "86.2" }],
  ];

  it.each(malformedFiring)("firing 줄의 %s → 전체 unparseable", async (_label, overrides) => {
    const row = observeFiring(overrides);
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete row[key];
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("158")], [observeFiring(), row]));
    expectFailure(await client(fetch).latest(), "unparseable");
  });

  it.each([
    ["봉투 아님", () => jsonBody({ servers: [] })],
    ["success false", () => jsonBody({ success: false, data: { servers: [] } })],
    ["servers 빠짐", () => jsonBody({ success: true, data: { firing: [] } })],
    ["servers 가 객체", () => jsonBody({ success: true, data: { servers: {} } })],
    ["firing 이 객체", () => jsonBody({ success: true, data: { servers: [], firing: {} } })],
    ["같은 서버 두 번", () => observeLatestBody([observeLatestServer("158"), observeLatestServer("158")])],
    ["JSON 아님", () => textResponse(`<html>${UPSTREAM_RAW_MARKER}</html>`, 200, "text/html")],
  ] as const)("%s → unparseable", async (_label, makeResponse) => {
    const fetch = createRoutedFetch(() => makeResponse());
    expectFailure(await client(fetch).latest(), "unparseable");
  });
});

describe("latest — 이름을 읽지 못한 서버 줄(§18 — 그 줄만 버리고 센다, 응답 전체를 '읽을 수 없음'으로 만들지 않는다)", () => {
  /** 이름 칸만 바꾼 줄(undefined 면 칸을 뺀다). */
  function rowNamed(base: Record<string, unknown>, server: unknown): Record<string, unknown> {
    const row = { ...base, server };
    if (server === undefined) delete row.server;
    return row;
  }

  it("리뷰 재현 — 기대 서버 설정의 대문자 이름(수신 없음 줄) 하나와 정상 줄 → 정상 서버의 값은 그대로, 읽지 못한 수 1", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("158"), observeSilentServer("CI-Agent-9")], [observeFiring()]));
    const latest = okValue(await client(fetch).latest());
    expect(latest.servers.map((server) => server.server)).toEqual(["158"]);
    expect(latest.servers[0]).toMatchObject({ measuredAt: javaInstantText(NOW_MILLISECONDS - 20_000), stale: false, host: { cpuPct: 3.4, memUsed: 2_100_000_000 } });
    expect(latest.unreadableServerNameCount).toBe(1);
    expect(latest.firing).toHaveLength(1);
  });

  it.each([
    ["이름 칸 빠짐", undefined], ["대문자", "Home"], ["숫자", 158], ["빈 글자", ""], ["null", null], ["64자(꼴은 63자까지)", `a${"b".repeat(63)}`],
    ["공백 포함", "ci agent"],
  ] as const)("%s → 그 줄만 버리고 센다(받은 순서 그대로)", async (_label, server) => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("164"), rowNamed(observeLatestServer("x"), server), observeLatestServer("158")]));
    const latest = okValue(await client(fetch).latest());
    expect(latest.servers.map((each) => each.server)).toEqual(["164", "158"]);
    expect(latest.unreadableServerNameCount).toBe(1);
  });

  it("63자 이름은 읽는다(경계 안쪽)", async () => {
    const name = `a${"b".repeat(62)}`;
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer(name)]));
    const latest = okValue(await client(fetch).latest());
    expect(latest.servers.map((each) => each.server)).toEqual([name]);
    expect(latest.unreadableServerNameCount).toBe(0);
  });

  it("여럿이면 다 센다 — 같은 틀린 이름이 두 번이어도 '같은 서버 두 번'이 아니다", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([
      observeSilentServer("CI-Agent-9"), observeSilentServer("CI-Agent-9"), rowNamed(observeLatestServer("x"), undefined), observeLatestServer("158"),
    ]));
    const latest = okValue(await client(fetch).latest());
    expect(latest.servers.map((each) => each.server)).toEqual(["158"]);
    expect(latest.unreadableServerNameCount).toBe(3);
  });

  it("전부 이름이 틀리면 빈 목록과 그 수", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeSilentServer("A"), observeSilentServer("B")]));
    expect(okValue(await client(fetch).latest())).toStrictEqual({ servers: [], unreadableServerNameCount: 2, firing: [] });
  });

  it("이름을 읽지 못한 줄의 다른 칸은 보지 않는다(값의 형이 틀려도 그 줄을 버릴 뿐)", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeLatestServer("Bad", { host: observeHost({ cpu_pct: "3.4" }), at: "yesterday" }), observeLatestServer("158")]));
    const latest = okValue(await client(fetch).latest());
    expect(latest.servers.map((each) => each.server)).toEqual(["158"]);
    expect(latest.unreadableServerNameCount).toBe(1);
  });

  it("이름은 맞고 다른 칸의 형이 틀린 줄은 지금처럼 전체 unparseable — 이름이 틀린 줄이 함께 있어도", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeSilentServer("CI-Agent-9"), observeLatestServer("158", { host: observeHost({ cpu_pct: "3.4" }) })]));
    expectFailure(await client(fetch).latest(), "unparseable");
  });

  it("서버 줄이 객체가 아니면 지금처럼 전체 unparseable(이름을 셀 줄이 아니다)", async () => {
    const fetch = createRoutedFetch(() => jsonBody({ success: true, data: { servers: [observeLatestServer("158"), "158"], firing: [] } }));
    expectFailure(await client(fetch).latest(), "unparseable");
  });

  it("읽을 수 있는 이름이 두 번이면 지금처럼 unparseable", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeSilentServer("CI-Agent-9"), observeLatestServer("158"), observeLatestServer("158")]));
    expectFailure(await client(fetch).latest(), "unparseable");
  });

  it("결과에 버린 줄의 원문(이름 · 계약 밖 칸)이 없다", async () => {
    const fetch = createRoutedFetch(() => observeLatestBody([observeSilentServer(`Bad ${UPSTREAM_RAW_MARKER}`), observeLatestServer("158")]));
    const latest = okValue(await client(fetch).latest());
    expect(JSON.stringify(latest)).not.toContain("Bad");
    expectNoForbiddenText(latest);
  });
});

describe("series — 칸 고르기", () => {
  it("host — 점마다 그 갈래의 값 이름 전부(평균 · 최댓값), 계약 밖 칸은 버린다", async () => {
    const points = [
      { ...observePoint("host", FROM, { cpu_pct: [3.4, 9.9], mem_used: [2e9, 2.1e9], mem_total: [16e9, 16e9] }), extra: UPSTREAM_RAW_MARKER },
      observePoint("host", FROM + 30_000, { cpu_pct: [4, 5] }),
    ];
    const fetch = createRoutedFetch(() => seriesBody({ points }));
    const series = okValue(await client(fetch).series(hostRequest()));
    expect(series).toMatchObject({ server: "158", scope: "host", name: null, fromMilliseconds: FROM, toMilliseconds: TO, stepMilliseconds: 30_000, source: "raw" });
    expect(series.points).toHaveLength(2);
    expect(series.points[0].at).toBe(javaInstantText(FROM));
    expect(series.points[0].atMilliseconds).toBe(FROM);
    expect(Object.keys(series.points[0].values).sort()).toEqual([...HOST_VALUE_NAMES].sort());
    expect(series.points[0].values.cpu_pct).toEqual({ average: 3.4, maximum: 9.9 });
    expect(series.points[0].values.mem_total).toEqual({ average: 16e9, maximum: 16e9 });
    expect(series.points[0].values.net_rx_bps).toEqual({ average: null, maximum: null });
    expect(series.points[1].values.mem_used).toEqual({ average: null, maximum: null });
    expectNoForbiddenText(series);
  });

  it("container · gpu — 그 갈래의 값 이름만", async () => {
    const containerFetch = createRoutedFetch(() => seriesBody({ scope: "container", name: "front-app", points: [observePoint("container", FROM, { cpu_pct: [120, 180] })] }));
    const container = okValue(await client(containerFetch).series(hostRequest({ scope: "container", name: "front-app" })));
    expect(Object.keys(container.points[0].values).sort()).toEqual(["cpu_pct", "mem_used"]);
    expect(container.points[0].values.cpu_pct).toEqual({ average: 120, maximum: 180 });   // 코어 하나 = 100 — 100 을 넘어도 받는다
    const gpuFetch = createRoutedFetch(() => seriesBody({ scope: "gpu", name: "0", points: [observePoint("gpu", FROM, { temp_c: [-2, 30] })] }));
    const gpu = okValue(await client(gpuFetch).series(hostRequest({ scope: "gpu", name: "0" })));
    expect(Object.keys(gpu.points[0].values).sort()).toEqual([...GPU_VALUE_NAMES].sort());
    expect(gpu.points[0].values.temp_c).toEqual({ average: -2, maximum: 30 });
  });

  it("값 칸이 빠지면 null(확인하지 못함) — 점은 남긴다", async () => {
    const point = withoutKeys(observePoint("host", FROM, { cpu_pct: [1, 2] }), ["cpu_pct_max", "load1", "load1_max"]);
    const fetch = createRoutedFetch(() => seriesBody({ points: [point] }));
    const [first] = okValue(await client(fetch).series(hostRequest())).points;
    expect(first.values.cpu_pct).toEqual({ average: 1, maximum: null });
    expect(first.values.load1).toEqual({ average: null, maximum: null });
  });

  it.each([["rollup"], ["mixed"], ["raw"]] as const)("source %s 와 관측 서버가 고른 step_ms 를 그대로", async (source) => {
    const fetch = createRoutedFetch(() => seriesBody({ source, step_ms: 5 * MINUTE }));
    expect(okValue(await client(fetch).series(hostRequest()))).toMatchObject({ source, stepMilliseconds: 5 * MINUTE });
  });

  it.each([["칸 없음", undefined], ["모르는 글자", "cache"], ["null", null]] as const)("source %s → null(확인하지 못함)", async (_label, source) => {
    const data = seriesData({ source });
    if (source === undefined) delete data.source;
    const fetch = createRoutedFetch(() => jsonBody({ success: true, data }));
    expect(okValue(await client(fetch).series(hostRequest())).source).toBeNull();
  });

  it("5분 평균의 첫 점은 from 보다 최대 5분 앞설 수 있다 — 버리지 않는다(§15.1)", async () => {
    const first = FROM - 4 * MINUTE;
    const fetch = createRoutedFetch(() => seriesBody({ source: "rollup", step_ms: 5 * MINUTE, points: [observePoint("host", first, { cpu_pct: [1, 1] }), observePoint("host", first + 5 * MINUTE, { cpu_pct: [2, 2] })] }));
    const series = okValue(await client(fetch).series(hostRequest()));
    expect(series.points.map((point) => point.atMilliseconds)).toEqual([first, first + 5 * MINUTE]);
  });

  it("from · to 는 밀리초로 같으면 된다(Instant 글자는 .000 을 떼고 소수 자리가 다를 수 있다)", async () => {
    const fromAt = Date.UTC(2026, 10, 24, 11, 0, 0, 0);
    const fetch = createRoutedFetch(() => seriesBody({ from: "2026-11-24T11:00:00Z", to: "2026-11-24T12:00:00.000000Z" }));
    const series = okValue(await client(fetch).series(hostRequest({ fromMilliseconds: fromAt, toMilliseconds: fromAt + HOUR })));
    expect(series).toMatchObject({ fromMilliseconds: fromAt, toMilliseconds: fromAt + HOUR });
  });

  it("점 500개는 받는다", async () => {
    const points = Array.from({ length: 500 }, (_, index) => observePoint("host", FROM + index * 30_000 - 30 * DAY, { cpu_pct: [1, 1] }));
    const fetch = createRoutedFetch(() => seriesBody({ points }));
    expect(okValue(await client(fetch).series(hostRequest())).points).toHaveLength(500);
  });

  const malformedSeries: [string, Record<string, unknown>][] = [
    ["점 501개", { points: Array.from({ length: 501 }, (_, index) => observePoint("host", FROM + index, {})) }],
    ["points 빠짐", { points: undefined }],
    ["points 가 객체", { points: {} }],
    ["점이 객체 아님", { points: [1] }],
    ["점 at 빠짐", { points: [withoutKeys(observePoint("host", FROM), ["at"])] }],
    ["점 at 이 시각 아님", { points: [{ ...observePoint("host", FROM), at: "soon" }] }],
    ["점 시각이 거꾸로", { points: [observePoint("host", FROM + 30_000), observePoint("host", FROM)] }],
    ["점 시각이 같음", { points: [observePoint("host", FROM), observePoint("host", FROM)] }],
    ["점 값이 글자", { points: [observePoint("host", FROM, { cpu_pct: ["3" as unknown as number, null] })] }],
    ["점 최댓값이 음수", { points: [observePoint("host", FROM, { net_rx_bps: [1, -1] })] }],
    ["server 가 다름", { server: "164" }],
    ["scope 가 다름", { scope: "gpu" }],
    ["name 이 다름(host 에 이름)", { name: "front-app" }],
    ["from 이 다름", { from: javaInstantText(FROM - 1) }],
    ["to 가 다름", { to: javaInstantText(TO + 1000) }],
    ["to 가 시각 아님", { to: "later" }],
    ["step_ms 빠짐", { step_ms: undefined }],
    ["step_ms 0", { step_ms: 0 }],
    ["step_ms 소수", { step_ms: 1.5 }],
    ["step_ms 글자", { step_ms: "30000" }],
    ["source 가 숫자", { source: 1 }],
  ];

  it.each(malformedSeries)("%s → unparseable", async (_label, overrides) => {
    const data = seriesData(overrides);
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete data[key];
    const fetch = createRoutedFetch(() => jsonBody({ success: true, data }));
    expectFailure(await client(fetch).series(hostRequest()), "unparseable");
  });

  it("container 응답의 name 이 요청과 다르면 unparseable", async () => {
    const fetch = createRoutedFetch(() => seriesBody({ scope: "container", name: "backend-api" }));
    expectFailure(await client(fetch).series(hostRequest({ scope: "container", name: "front-app" })), "unparseable");
  });
});

describe("containers — 칸 고르기", () => {
  it("server · from · to · containers[name, lastSeenAt]", async () => {
    const fetch = createRoutedFetch(() => jsonBody({ success: true, data: {
      server: "158", from: javaInstantText(NOW_MILLISECONDS - 5 * MINUTE), to: javaInstantText(NOW_MILLISECONDS + 5 * MINUTE),
      containers: [{ name: "front-app", last_seen_at: javaInstantText(NOW_MILLISECONDS), extra: UPSTREAM_RAW_MARKER }],
    } }));
    expect(okValue(await client(fetch).containers("158", NOW_MILLISECONDS))).toStrictEqual({
      server: "158", fromMilliseconds: NOW_MILLISECONDS - 5 * MINUTE, toMilliseconds: NOW_MILLISECONDS + 5 * MINUTE,
      containers: [{ name: "front-app", lastSeenAt: javaInstantText(NOW_MILLISECONDS) }],
    });
  });

  it.each([
    ["server 다름", { server: "164" }],
    ["containers 빠짐", { containers: undefined }],
    ["name 꼴", { containers: [{ name: "a b", last_seen_at: javaInstantText(NOW_MILLISECONDS) }] }],
    ["last_seen_at 시각 아님", { containers: [{ name: "front-app", last_seen_at: "x" }] }],
    ["from 빠짐", { from: undefined }],
  ] as const)("%s → unparseable", async (_label, overrides) => {
    const data: Record<string, unknown> = { server: "158", from: javaInstantText(FROM), to: javaInstantText(TO), containers: [], ...overrides };
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete data[key];
    const fetch = createRoutedFetch(() => jsonBody({ success: true, data }));
    expectFailure(await client(fetch).containers("158", null), "unparseable");
  });
});

describe("관측 서버의 오류를 화면용 짧은 사유로 — 원문 · 비밀값 · 주소 없음", () => {
  const calls = [
    ["latest", (fetch: RoutedFetch) => client(fetch).latest()],
    ["series", (fetch: RoutedFetch) => client(fetch).series(hostRequest())],
    ["containers", (fetch: RoutedFetch) => client(fetch).containers("158", null)],
  ] as const;

  for (const [name, call] of calls) {
    it.each([
      [401, "unauthorized"], [422, "invalid_request"], [503, "unavailable"], [504, "server_timeout"], [500, "bad_status"], [404, "bad_status"], [302, "bad_status"],
    ] as const)(`${name} — HTTP %i → %s`, async (status, reason) => {
      const fetch = createRoutedFetch(() => textResponse(leakyErrorBody(), status));
      expectFailure(await call(fetch), reason, status);
    });

    it(`${name} — 관측 서버의 실제 422 꼴(detail 포함)도 detail 을 넘기지 않는다`, async () => {
      const fetch = createRoutedFetch(() => jsonBody({ success: false, error: { code: "invalid_request", detail: `기간은 최대 31일 ${UPSTREAM_RAW_MARKER}` } }, 422));
      const result = await call(fetch);
      expectFailure(result, "invalid_request", 422);
      expect(JSON.stringify(result)).not.toContain("31일");
    });

    it(`${name} — 연결 실패 → unreachable`, async () => {
      const fetch = createRoutedFetch(() => Promise.reject(leakyNetworkError()));
      expectFailure(await call(fetch), "unreachable");
    });

    it(`${name} — fetch 가 동기로 던져도 거부하지 않고 unreachable`, async () => {
      const fetch = createRoutedFetch(() => { throw leakyNetworkError(); });
      expectFailure(await call(fetch), "unreachable");
    });
  }
});

describe("본문 상한 1 MiB(바이트)", () => {
  /** 정상 latest 본문을 끝의 공백으로 정확히 bytes 바이트까지 채운다(UTF-8 — 한글 칸을 넣어 글자 수 ≠ 바이트 수). */
  function paddedLatestBody(bytes: number): string {
    const body = JSON.stringify({ success: true, data: { servers: [observeLatestServer("158")], firing: [], note: "가".repeat(1000) } });
    const length = new TextEncoder().encode(body).length;
    return body + " ".repeat(bytes - length);
  }

  it("정확히 1 MiB 는 받는다", async () => {
    const body = paddedLatestBody(RESOURCE_RESPONSE_MAXIMUM_BYTES);
    const fetch = createRoutedFetch(() => textResponse(body));
    expect(okValue(await client(fetch).latest()).servers).toHaveLength(1);
  });

  it("1 바이트 넘으면 unparseable — 글자 수가 아니라 바이트로 센다", async () => {
    const body = paddedLatestBody(RESOURCE_RESPONSE_MAXIMUM_BYTES + 1);
    expect(body.length).toBeLessThan(RESOURCE_RESPONSE_MAXIMUM_BYTES);   // 글자 수로는 상한 아래
    const fetch = createRoutedFetch(() => textResponse(body));
    expectFailure(await client(fetch).latest(), "unparseable");
  });

  it("끝없이 큰 본문 — 상한을 넘은 뒤로 더 읽지 않는다(읽은 조각 수가 묶인다)", async () => {
    const chunkBytes = 64 * 1024;
    const pulled = { count: 0, cancelled: false };
    const fetch = createRoutedFetch(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled.count += 1;
        if (pulled.count > 200) { controller.close(); return; }   // 12.5 MiB 에서 끝(테스트가 멈추지 않게)
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      },
      cancel() { pulled.cancelled = true; },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    expectFailure(await client(fetch).series(hostRequest()), "unparseable");
    expect(pulled.count).toBeLessThanOrEqual(RESOURCE_RESPONSE_MAXIMUM_BYTES / chunkBytes + 3);
  });
});

describe("5초 기한(가짜 타이머) · 재시도 없음", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ["응답하지 않음", (init: RequestInit) => hangUntilAborted(init)],
    ["본문이 끝나지 않음", (init: RequestInit) => Promise.resolve(headersThenStalledBody(init))],
  ] as const)("%s → 5초에 timeout, 호출 1회", async (_label, behave) => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((_url, init) => behave(init));
    const pending = track(client(fetch, { timeoutSignal: timeout.factory }).series(hostRequest()));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expectFailure(pending.value!, "timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
