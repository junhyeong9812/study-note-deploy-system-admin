/** 요청 추적의 서버 쪽 진입 — 구간(T7): 로그 조회와 구간 조회가 **칸마다 따로** 실패한다 · 요청 ID 의 꼴이 틀리면 관측 서버를 한 번도 부르지 않는다 ·
 * 부르는 차례(로그 → 구간 → 수신 상태) · 비밀값은 X-Observe-Secret 하나 · 설정이 비면 둘 다 "설정 없음" · 실패는 칸마다 앱 로그 1줄 ·
 * 데이터 경로의 JSON 에 관측 서버의 주소 · 비밀값 · 원문 · 서버 이름 속의 주소 · 경로의 쿼리가 없다.
 * 전역 fetch 를 가짜 관측 서버(로그 + 통신 — 실제 규칙 흉내)로 바꾼다. 세션 경계는 request-trace.test 가 본다(세션이 없으면 fetch 0회 — 구간 조회 포함). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public location: string) { super(`redirect:${location}`); }
  }
  return { RedirectSignal, cookieValues: new Map<string, string>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (navigation.cookieValues.has(name) ? { name, value: navigation.cookieValues.get(name)! } : undefined),
    has: (name: string) => navigation.cookieValues.has(name),
    getAll: () => [...navigation.cookieValues].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers({ host: "evil.example.test" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (location: string) => { throw new navigation.RedirectSignal(location); },
  permanentRedirect: (location: string) => { throw new navigation.RedirectSignal(location); },
  notFound: () => { throw new Error("notFound"); },
}));

import { SESSION_COOKIE_NAME, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { createFakeObserveLogs, fakeLogLine, type FakeLogLine } from "@/features/log-trace/lib/log-trace-test-fakes";
import { TRACE_REQUEST_ID, TRACE_START_MILLISECONDS } from "@/features/request-trace/lib/request-trace-test-fakes";
import type { RequestTraceView } from "@/features/request-trace/lib/request-trace-view";
import {
  OVERLAY_LOG_SCENARIO, callsToPath, createFakeObserveTraffic, fakeServerReceipt, fakeSpan, observeLogsAndTraffic, overlaySpanScenario, type FakeSpan,
} from "@/features/request-trace/lib/traffic-span-test-fakes";
import { loadRequestTrace, requestTraceResponse } from "@/features/request-trace/server/request-trace";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  SECRET_HEADER_NAMES, createRoutedFetch, expectFailure, expectNoForbiddenText, expectReadOnlyRequest, headersOf, leakyErrorBody, leakyNetworkError,
  okValue, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const T = TRACE_START_MILLISECONDS;
const DAY = 24 * 60 * 60 * 1000;

function scenarioLogLines(): FakeLogLine[] {
  return OVERLAY_LOG_SCENARIO.map(([offset, service, level, message]) =>
    fakeLogLine({ milliseconds: T + offset, sequence: 0, service, level, requestId: TRACE_REQUEST_ID, message }));
}

let logsHandler: RoutedFetchHandler;
let trafficHandler: RoutedFetchHandler;
let traffic: ReturnType<typeof createFakeObserveTraffic>;

function useTraffic(spans: FakeSpan[]) {
  traffic = createFakeObserveTraffic({ spans, servers: [fakeServerReceipt({ readProgressMilliseconds: T + 3700 + 60_000 })] });
  trafficHandler = traffic.handler;
}

const upstreamFetch = createRoutedFetch((url, init) => {
  if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected upstream ${url.hostname}`);
  return observeLogsAndTraffic(logsHandler, trafficHandler)(url, init);
});

function pathsCalled(): string[] {
  return upstreamFetch.mock.calls.map(([input]) => new URL(input).pathname);
}

function validSession() {
  navigation.cookieValues.clear();
  navigation.cookieValues.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
}

function apiRequest(search: string): Request {
  return new Request(new URL(`/api/trace${search}`, FAKE_ORIGIN), { method: "GET", headers: { origin: FAKE_ORIGIN } });
}

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

function everythingLogged(): string {
  const consoleText = consoleSpies.flatMap((spy) => spy.mock.calls.flat()).map((part) => String(part));
  const streamText = [process.stdout.write, process.stderr.write].flatMap((write) =>
    (vi.isMockFunction(write) ? write.mock.calls.map((call) => String(call[0])) : []));
  return [...consoleText, ...streamText].join("\n");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("ALERT_URL", FAKE_ALERT_URL);
  vi.stubEnv("ALERT_SECRET", FAKE_ALERT_SECRET);
  vi.stubEnv("BACKEND_URL", FAKE_BACKEND_URL);
  vi.stubEnv("LOG_REDIS_URL", "");
  logsHandler = createFakeObserveLogs(scenarioLogLines()).handler;
  useTraffic(overlaySpanScenario(TRACE_REQUEST_ID, T));
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  validSession();
  consoleSpies.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("입력 — 꼴이 틀리면 관측 서버를 한 번도 부르지 않는다(로그 · 구간 · 수신 상태 모두)", () => {
  it("입력 없음 → spans 도 null", async () => {
    expect(await loadRequestTrace({})).toEqual({ requestId: null, trace: null, spans: null });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["빈 값", { request_id: "" }],
    ["배열", { request_id: [TRACE_REQUEST_ID, "req-0123456789ac"] }],
    ["콜론", { request_id: "req:1" }],
    ["81자", { request_id: "r".repeat(81) }],
    ["태그", { request_id: "<script>" }],
    ["앞뒤 공백", { request_id: ` ${TRACE_REQUEST_ID}` }],
    ["물음표", { request_id: "req-1?x=1" }],
  ])("틀린 입력(%s) → trace = invalid_input · spans = null, fetch 0회", async (_label, input) => {
    const view = await loadRequestTrace(input);
    expectFailure(view.trace!, "invalid_input");
    expect(view.spans).toBeNull();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("데이터 경로 · 꼴 밖 → 422, fetch 0회", async () => {
    const response = await requestTraceResponse(apiRequest("?request_id=req%3A1"));
    expect(response.status).toBe(422);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("부르는 차례와 관례", () => {
  it("로그 → 구간 → 수신 상태, 셋 다 GET · 본문 없음 · no-store · 비밀값 머리글은 X-Observe-Secret 하나 · 구간은 넣은 요청 ID 로", async () => {
    const view = await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    // 로그와 구간은 나란히(어느 쪽이 먼저 시작하든) · 수신 상태는 둘이 끝난 뒤
    expect(pathsCalled().slice(0, 2).sort()).toEqual(["/logs", "/traffic/requests"]);
    expect(pathsCalled().slice(2)).toEqual(["/traffic/map"]);
    for (const [, init] of upstreamFetch.mock.calls) {
      expectReadOnlyRequest(init);
      expect(init?.cache).toBe("no-store");
      expect(init?.redirect).toBe("manual");
      for (const name of SECRET_HEADER_NAMES) expect(headersOf(init).get(name)).toBe(name === "x-observe-secret" ? FAKE_OBSERVE_SECRET : null);
    }
    expect(traffic.calls[0].parameters).toEqual({ request_id: TRACE_REQUEST_ID });
    // 수신 상태의 창: 가장 이른 시각(front 구간의 시작 T)부터 지금까지 — 단 24시간(T 는 지금보다 24시간 넘게 앞이라 T + 24시간)
    expect(traffic.calls[1].parameters).toEqual({ from: new Date(T).toISOString(), to: new Date(T + DAY).toISOString() });
    expect(okValue(view.trace!).timeline?.lineCount).toBe(7);
    const spans = okValue(view.spans!);
    expect(spans.spans).toHaveLength(3);
    expect(okValue(spans.receipt)).toHaveLength(1);
    expectNoForbiddenText(view);
  });

  it("설정이 비면 로그 · 구간 둘 다 not_configured, 부르지 않는다", async () => {
    vi.stubEnv("OBSERVE_SECRET", "");
    const view = await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    expectFailure(view.trace!, "not_configured");
    expectFailure(view.spans!, "not_configured");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("로그와 구간의 조회는 나란히(T7 리뷰 6) — 관측 서버가 느리면 5초 + 5초가 아니라 5초", () => {
  function deferred() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it("구간 조회는 로그 조회의 끝을 기다리지 않고 시작한다 · 수신 상태는 둘 다 끝난 뒤에만", async () => {
    const logsAnswer = deferred();
    const realLogs = logsHandler;
    logsHandler = (url, init) => logsAnswer.promise.then(() => realLogs(url, init));
    const pending = loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    try {
      await vi.waitFor(() => expect(pathsCalled()).toContain("/traffic/requests"), { timeout: 1000, interval: 5 });
      expect(pathsCalled()).toContain("/logs");
      // 구간은 이미 답했지만 로그가 아직이면 수신 상태를 부르지 않는다(창이 로그의 시각에 기댄다)
      await new Promise((done) => setTimeout(done, 20));
      expect(pathsCalled()).not.toContain("/traffic/map");
    } finally {
      logsAnswer.resolve(new Response(null));
    }
    const view = await pending;
    expect(pathsCalled().at(-1)).toBe("/traffic/map");
    expect(okValue(view.trace!).timeline?.lineCount).toBe(7);
    expect(okValue(view.spans!).spans).toHaveLength(3);
  });

  it("로그 조회가 시작되기 전에 구간이 먼저 닿아도 · 로그가 먼저 끝나도 결과는 같다(구간이 늦게 답함)", async () => {
    const spansAnswer = deferred();
    const realTraffic = trafficHandler;
    trafficHandler = (url, init) => (url.pathname === "/traffic/requests" ? spansAnswer.promise.then(() => realTraffic(url, init)) : realTraffic(url, init));
    const pending = loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    await vi.waitFor(() => expect(pathsCalled()).toContain("/traffic/requests"), { timeout: 1000, interval: 5 });
    await vi.waitFor(() => expect(pathsCalled()).toContain("/logs"), { timeout: 1000, interval: 5 });
    expect(pathsCalled()).not.toContain("/traffic/map");
    spansAnswer.resolve(new Response(null));
    const view = await pending;
    expect(pathsCalled().at(-1)).toBe("/traffic/map");
    expect(okValue(view.spans!).spans).toHaveLength(3);
  });
});

describe("칸마다 따로 실패한다", () => {
  it("구간 조회가 실패해도(503) 로그의 시간 줄은 그대로 — spans 는 그 실패(빈 목록이 아니다), 수신 상태는 부르지 않는다", async () => {
    trafficHandler = (url, init) => (url.pathname === "/traffic/requests" ? textResponse(leakyErrorBody(), 503) : traffic.handler(url, init));
    const view = await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    expect(okValue(view.trace!).timeline?.lineCount).toBe(7);
    expectFailure(view.spans!, "unavailable", 503);
    expect(callsToPath(upstreamFetch.mock.calls, "/traffic/map")).toHaveLength(0);
  });

  it("구간 조회가 닿지 않아도(예외 문구에 주소 · 비밀값) 로그는 그대로 — 결과에 원문 없음", async () => {
    trafficHandler = () => Promise.reject(leakyNetworkError());
    const view = await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    expect(view.trace!.ok).toBe(true);
    expectFailure(view.spans!, "unreachable");
    expectNoForbiddenText(view);
  });

  it("로그 조회가 실패해도(504) 구간은 그대로 — 수신 상태의 창은 구간만으로", async () => {
    logsHandler = () => textResponse(leakyErrorBody(), 504);
    const view = await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    expectFailure(view.trace!, "server_timeout", 504);
    expect(okValue(view.spans!).spans.map((span) => span.service).sort()).toEqual(["backend", "front", "llm-wrapper"]);
    expect(traffic.calls[1].parameters).toEqual({ from: new Date(T).toISOString(), to: new Date(T + DAY).toISOString() });
  });

  it("수신 상태 조회가 실패해도 구간은 그대로 — receipt 만 그 실패", async () => {
    trafficHandler = (url, init) => (url.pathname === "/traffic/map" ? textResponse(leakyErrorBody(), 503) : traffic.handler(url, init));
    const spans = okValue((await loadRequestTrace({ request_id: TRACE_REQUEST_ID })).spans!);
    expect(spans.spans).toHaveLength(3);
    expectFailure(spans.receipt, "unavailable", 503);
  });

  it("구간의 꼴이 틀리면 unparseable — 로그는 그대로", async () => {
    trafficHandler = (url, init) => (url.pathname === "/traffic/requests"
      ? textResponse(JSON.stringify({ success: true, data: { request_id: TRACE_REQUEST_ID, spans: [{ service: "backend" }], truncated: false } }))
      : traffic.handler(url, init));
    const view = await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    expect(view.trace!.ok).toBe(true);
    expectFailure(view.spans!, "unparseable");
  });

  it("구간이 없으면 성공 · 빈 목록(실패와 다르다)", async () => {
    useTraffic([]);
    const spans = okValue((await loadRequestTrace({ request_id: TRACE_REQUEST_ID })).spans!);
    expect(spans.spans).toEqual([]);
    expect(spans.truncated).toBe(false);
  });
});

describe("시각이 하나도 없으면(T7 리뷰 5)", () => {
  it("로그도 구간도 없는 요청 ID — 수신 상태를 부르지 않는다(관측 서버는 둘만)", async () => {
    logsHandler = createFakeObserveLogs([]).handler;
    useTraffic([]);
    const view = await loadRequestTrace({ request_id: "req-typo-000" });
    expect(pathsCalled().sort()).toEqual(["/logs", "/traffic/requests"]);
    expect(okValue(okValue(view.spans!).receipt)).toEqual([]);
  });
});

describe("앱 로그 — 칸마다 1줄, 이유와 상태 코드만", () => {
  it("구간 실패 → cell=spans · 수신 상태 실패 → cell=receipt(비밀값 · 주소 · 원문 없음)", async () => {
    trafficHandler = (url) => textResponse(leakyErrorBody(), url.pathname === "/traffic/requests" ? 503 : 504);
    await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    await vi.waitFor(() => expect(everythingLogged()).toContain("screen:request-trace cell=spans upstream=unavailable status=503"));
    expect(everythingLogged()).not.toContain("cell=trace");
    expectNoForbiddenText(everythingLogged());

    upstreamFetch.mockClear();
    trafficHandler = (url, init) => (url.pathname === "/traffic/map" ? textResponse(leakyErrorBody(), 504) : traffic.handler(url, init));
    await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    await vi.waitFor(() => expect(everythingLogged()).toContain("screen:request-trace cell=receipt upstream=server_timeout status=504"));
    expectNoForbiddenText(everythingLogged());
  });

  it("성공 · 구간 없음은 앱 로그에 남기지 않는다", async () => {
    await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    useTraffic([]);
    await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    expect(everythingLogged()).not.toContain("screen:request-trace");
  });
});

describe("데이터 경로 — JSON 에 구간이 실리고, 없어야 할 글자는 없다", () => {
  it("200 {success:true, data:{requestId, trace, spans}} · no-store", async () => {
    const response = await requestTraceResponse(apiRequest(`?request_id=${TRACE_REQUEST_ID}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const text = await response.text();
    expectNoForbiddenText(text);
    const body = JSON.parse(text) as { success: boolean; data: RequestTraceView };
    expect(Object.keys(body.data).sort()).toEqual(["requestId", "spans", "trace"]);
    const spans = okValue(body.data.spans!);
    expect(spans.spans.find((span) => span.service === "front")).toMatchObject({
      server: "ci-agent-158", caller: "outside", method: "POST", path: "/api/chat", status: 500, durationMilliseconds: 3700, upstreamMilliseconds: 3600,
    });
  });

  it("서버 이름 속의 주소 · 경로의 쿼리 · 제어 문자는 데이터에 없다(화면만이 아니라)", async () => {
    useTraffic([fakeSpan({ requestId: TRACE_REQUEST_ID, server: "edge-203.0.113.9", path: "/search?q=secret-word\u0007", endMilliseconds: T + 100 })]);
    const text = await (await requestTraceResponse(apiRequest(`?request_id=${TRACE_REQUEST_ID}`))).text();
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("secret-word");
    expect(text).not.toContain("\\u0007");
    expectNoForbiddenText(text);
  });

  it("관측 서버가 구간 조회에 500 + 비밀값 · 주소를 담은 본문 → 200(실패는 칸의 결과로), 응답에 원문 없음", async () => {
    trafficHandler = () => textResponse(leakyErrorBody(), 500);
    const response = await requestTraceResponse(apiRequest(`?request_id=${TRACE_REQUEST_ID}`));
    expect(response.status).toBe(200);
    const text = await response.text();
    expectNoForbiddenText(text);
    const body = JSON.parse(text) as { data: RequestTraceView };
    expectFailure(body.data.spans!, "bad_status", 500);
    expect(body.data.trace!.ok).toBe(true);
  });
});
