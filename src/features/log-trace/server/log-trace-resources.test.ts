/** 연관 로그 + 그때 서버 자원의 서버 쪽 진입 — 명세 §2.6 연관 로그 · §10.4 · §11.5 · §2.3 "세션을 확인한 뒤에만 부르고, 한 구역이 실패해도 다른 구역은 보인다".
 * 기존 loadLogTrace · logTraceResponse 는 그대로다(log-trace.test 가 호출 수 · 칸 이름을 고정한다). 전역 fetch 를 가짜로 바꾼다. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { loadLogTraceWithResources, logTraceWithResourcesResponse } from "@/features/log-trace/server/log-trace-resources";
import { loadLogTrace } from "@/features/log-trace/server/log-trace";
import {
  SELECTED_LOG_ID, SELECTED_MILLISECONDS, alertHandlerFor, alertIncident, createFakeObserveLogs, createTraceFetch, fakeLogLine, masterDeployment,
  masterHandlerFor,
} from "@/features/log-trace/lib/log-trace-test-fakes";
import { createFakeTraceObserve, type FakeTraceObserve } from "@/features/log-trace/lib/trace-resources-test-fakes";
import { observeLatestBody, observeLatestServer, seriesKey } from "@/features/resources/lib/resource-metrics-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  expectFailure, expectNoForbiddenText, leakyErrorBody, okValue, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const T = SELECTED_MILLISECONDS;
const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";
/** 고른 줄의 서비스는 backend(fakeLogLine 기본). */
const LINES = [fakeLogLine({ milliseconds: T - 1_000, sequence: 0, level: "info", service: "front" }), fakeLogLine()];

let logsHandler: RoutedFetchHandler;
let metrics: FakeTraceObserve;
const networkFetch = createTraceFetch({
  observe: (url, init) => (url.pathname.startsWith("/metrics/") ? metrics.handler(url, init) : logsHandler(url, init)),
  master: masterHandlerFor([masterDeployment()]),
  alert: alertHandlerFor([alertIncident()]),
});

function setSessionCookie(value: string | undefined) {
  navigation.cookieValues.clear();
  if (value !== undefined) navigation.cookieValues.set(SESSION_COOKIE_NAME, value);
}

function metricPaths(): string[] {
  return networkFetch.mock.calls.map(([input]) => new URL(input).pathname).filter((path) => path.startsWith("/metrics/"));
}

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
function everythingLogged(): string {
  return consoleSpies.flatMap((spy) => spy.mock.calls.flat()).map((part) => String(part)).join("\n");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("ALERT_URL", FAKE_ALERT_URL);
  vi.stubEnv("ALERT_SECRET", FAKE_ALERT_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  logsHandler = createFakeObserveLogs(LINES).handler;
  metrics = createFakeTraceObserve(() => observeLatestBody([observeLatestServer("158"), observeLatestServer("164")]));
  metrics.containers.set("164", { seen: { "backend-app": T, "backend-es": T } });
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  setSessionCookie(undefined);
  consoleSpies.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("세션 · 입력 경계", () => {
  it.each([
    ["쿠키 없음", () => undefined],
    ["잘못된 서명", () => issueSessionToken(OTHER_KEY, Date.now())],
    ["만료", () => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
  ] as [string, () => string | undefined][])("%s → 화면용 /login · 데이터 경로용 401, fetch 0회", async (_label, makeCookie) => {
    setSessionCookie(makeCookie());
    const thrown = await loadLogTraceWithResources({ selected: SELECTED_LOG_ID }).then(() => null, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
    const response = await logTraceWithResourcesResponse(new Request(new URL(`/api/logs/trace?selected=${SELECTED_LOG_ID}`, FAKE_ORIGIN)));
    expect(response.status).toBe(401);
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("입력 거절 → 화면용 invalid_input · resources null · 데이터 경로용 422, 어떤 서버도 부르지 않는다", async () => {
    setSessionCookie(issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
    expect(await loadLogTraceWithResources({ selected: "abc" })).toEqual({ outcome: { kind: "invalid_input", field: "selected" }, resources: null });
    const response = await logTraceWithResourcesResponse(new Request(new URL("/api/logs/trace?selected=abc", FAKE_ORIGIN)));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ success: false, error: { code: "invalid_input", field: "selected" } });
    expect(networkFetch).not.toHaveBeenCalled();
  });
});

describe("세션이 있으면", () => {
  beforeEach(() => { setSessionCookie(issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000)); });

  it("outcome 은 기존 loadLogTrace 와 같은 값 · resources 는 고른 로그의 서비스(backend)가 그때 있던 서버(164)", async () => {
    const result = await loadLogTraceWithResources({ selected: SELECTED_LOG_ID });
    expect(Object.keys(result).sort()).toEqual(["outcome", "resources"]);
    const resources = result.resources!;
    expect(resources).toMatchObject({ service: "backend", atMilliseconds: T });
    expect(okValue(resources.location)).toMatchObject({ kind: "found", server: "164", serviceContainer: "backend-app", containers: ["backend-app", "backend-es"] });
    okValue(resources.host!);
    okValue(resources.container!);
    networkFetch.mockClear();
    const alone = await loadLogTrace({ selected: SELECTED_LOG_ID });
    expect(result.outcome).toStrictEqual(alone);
    expect(metricPaths()).toEqual([]);   // 기존 진입은 지표를 부르지 않는다
    expectNoForbiddenText(result);
  });

  it("지표 호출 — latest 1 · containers 서버마다 1(at = 고른 로그의 시각) · series 2", async () => {
    await loadLogTraceWithResources({ selected: SELECTED_LOG_ID });
    expect(metricPaths().sort()).toEqual(["/metrics/containers", "/metrics/containers", "/metrics/latest", "/metrics/series", "/metrics/series"]);
    const containerCalls = networkFetch.mock.calls.map(([input]) => new URL(input)).filter((url) => url.pathname === "/metrics/containers");
    for (const url of containerCalls) expect(url.searchParams.get("at")).toBe(new Date(T).toISOString());
  });

  it("데이터 경로용 — 200 {success:true,data:{trace,resources}} · 기존 칸 이름 그대로 · no-store", async () => {
    const response = await logTraceWithResourcesResponse(new Request(new URL(`/api/logs/trace?selected=${SELECTED_LOG_ID}`, FAKE_ORIGIN)));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expectNoForbiddenText(text);
    const body = JSON.parse(text);
    expect(Object.keys(body.data).sort()).toEqual(["resources", "trace"]);
    expect(Object.keys(body.data.trace).sort()).toEqual(["query", "relatedLogs", "requestSummary", "selected", "serverState"]);
    expect(Object.keys(body.data.trace.serverState).sort()).toEqual(["deployments", "incidents", "levelCounts"]);
    expect(body.data.resources.location).toMatchObject({ ok: true, value: { kind: "found", server: "164" } });
  });

  it("고른 로그가 없음 → 화면용 not_found · resources null, 데이터 경로용 404, 계열은 부르지 않는다", async () => {
    logsHandler = createFakeObserveLogs([LINES[0]]).handler;
    expect(await loadLogTraceWithResources({ selected: SELECTED_LOG_ID })).toEqual({ outcome: { kind: "not_found" }, resources: null });
    expect(metricPaths()).not.toContain("/metrics/series");
    const response = await logTraceWithResourcesResponse(new Request(new URL(`/api/logs/trace?selected=${SELECTED_LOG_ID}`, FAKE_ORIGIN)));
    expect(response.status).toBe(404);
  });

  it("지표 조회가 실패해도 기존 네 구역은 그대로 — 자원 칸만 실패 · 앱 로그 1줄", async () => {
    metrics.metrics.latest = () => textResponse(leakyErrorBody(), 503);
    const result = await loadLogTraceWithResources({ selected: SELECTED_LOG_ID });
    expect(result.outcome.kind).toBe("view");
    if (result.outcome.kind !== "view") return;
    okValue(result.outcome.view.selected);
    okValue(result.outcome.view.relatedLogs);
    okValue(result.outcome.view.serverState.levelCounts);
    expectFailure(result.resources!.location, "unavailable", 503);
    expect(result.resources!.host).toBeNull();
    await vi.waitFor(() => expect(everythingLogged()).toContain("screen:log-trace cell=resources:location upstream=unavailable status=503"));
    expectNoForbiddenText(everythingLogged());
  });

  it("서비스가 있던 서버를 못 찾음 → '기록 없음'(none) · 다른 구역은 그대로", async () => {
    metrics.containers.clear();
    const result = await loadLogTraceWithResources({ selected: SELECTED_LOG_ID });
    expect(okValue(result.resources!.location)).toEqual({ kind: "none" });
    expect(result.outcome.kind).toBe("view");
  });

  it("계열 하나가 실패 → 그 칸만", async () => {
    metrics.metrics.series.set(seriesKey("164", "container", "backend-app"), { response: () => textResponse(leakyErrorBody(), 504) });
    const result = await loadLogTraceWithResources({ selected: SELECTED_LOG_ID });
    expectFailure(result.resources!.container!, "server_timeout", 504);
    okValue(result.resources!.host!);
  });
});

describe("소스 검사 — 새 진입은 server-only 이고 세션 검증을 직접 부른다", () => {
  it("log-trace-resources.ts", () => {
    const source = readFileSync(fileURLToPath(new URL("./log-trace-resources.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/^import "server-only";/m);
    expect(source).toMatch(/from "@\/features\/auth\/server\/require-session"/);
    expect(source).toMatch(/\brequireSession\s*\(/);
    expect(source).toMatch(/\brequireApiSession\s*\(/);
  });
});
