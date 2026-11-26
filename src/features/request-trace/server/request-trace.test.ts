/** 요청 추적의 서버 쪽 진입 — 기존 화면의 인증 경계("다른 서버를 부르는 모든 서버 쪽 함수와 Route Handler 가 같은 세션 검증 함수를 직접 호출한다") ·
 * 세션 확인이 입력 검증 · 관측 서버 호출보다 먼저 · 입력이 틀리면 부르지 않는다 · 비밀값은 서버 쪽에만 · 설정이 비면 "설정 없음" · 실패는 앱 로그 1줄.
 * 전역 fetch 를 가짜 관측 서버로 바꾼다(실제 서버를 부르지 않는다). 소스 검사 — server/ 의 세션 검증 · lib/ 의 순수함 · ui/ 와 src/app 의 임포트는
 * 공용 검사(src/app/screen-data-imports.test.ts 의 SCREEN_FEATURES · SCREEN_ENTRY_MODULES)가 본다. 여기에는 이 기능에만 있는 검사만 둔다. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
import { createFakeObserveLogs } from "@/features/log-trace/lib/log-trace-test-fakes";
import { TRACE_REQUEST_ID, chatScenarioLines } from "@/features/request-trace/lib/request-trace-test-fakes";
import { callsToPath, createFakeObserveTraffic, observeLogsAndTraffic } from "@/features/request-trace/lib/traffic-span-test-fakes";
import type { RequestTraceView } from "@/features/request-trace/lib/request-trace-view";
import { loadRequestTrace, requestTraceResponse } from "@/features/request-trace/server/request-trace";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  SECRET_HEADER_NAMES, createRoutedFetch, expectFailure, expectNoForbiddenText, expectReadOnlyRequest, headersOf, leakyErrorBody, leakyNetworkError,
  okValue, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const SOURCE_DIRECTORY = fileURLToPath(new URL("../../..", import.meta.url));
const FEATURE_DIRECTORY = join(SOURCE_DIRECTORY, "features", "request-trace");
const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";
const DAY = 24 * 60 * 60 * 1000;

/** 관측 서버 하나 — 로그(`/logs`)와 통신(`/traffic/*` — T7, 비어 있음). */
function defaultObserveHandler(): RoutedFetchHandler {
  return observeLogsAndTraffic(createFakeObserveLogs(chatScenarioLines()).handler, createFakeObserveTraffic().handler);
}

let observeHandler: RoutedFetchHandler = defaultObserveHandler();
const upstreamFetch = createRoutedFetch((url, init) => {
  if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected upstream ${url.hostname}`);
  return observeHandler(url, init);
});

function setSessionCookie(value: string | undefined) {
  navigation.cookieValues.clear();
  if (value !== undefined) navigation.cookieValues.set(SESSION_COOKIE_NAME, value);
}

function validSession() {
  setSessionCookie(issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
}

function apiRequest(search: string): Request {
  return new Request(new URL(`/api/trace${search}`, FAKE_ORIGIN), { method: "GET", headers: { origin: FAKE_ORIGIN } });
}

async function captureThrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
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
  observeHandler = defaultObserveHandler();
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  setSessionCookie(undefined);
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

const invalidSessions: [string, () => string | undefined][] = [
  ["쿠키 없음", () => undefined],
  ["잘못된 서명", () => issueSessionToken(OTHER_KEY, Date.now())],
  ["만료", () => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
];

describe("세션이 없으면 관측 서버를 한 번도 부르지 않는다(입력 검증보다 먼저)", () => {
  for (const [label, makeCookie] of invalidSessions) {
    it(`화면용 · ${label} → /login, fetch 0회`, async () => {
      setSessionCookie(makeCookie());
      const thrown = await captureThrown(() => loadRequestTrace({ request_id: TRACE_REQUEST_ID }));
      expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
      expect([`/login`, `${FAKE_ORIGIN}/login`]).toContain((thrown as InstanceType<typeof navigation.RedirectSignal>).location);
      expect(upstreamFetch).not.toHaveBeenCalled();
    });

    it(`데이터 경로용 · ${label} → 401 · no-store · 데이터 없음, fetch 0회`, async () => {
      setSessionCookie(makeCookie());
      const response = await requestTraceResponse(apiRequest(`?request_id=${TRACE_REQUEST_ID}`));
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control") ?? "").toContain("no-store");
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body).not.toHaveProperty("data");
      expect(upstreamFetch).not.toHaveBeenCalled();
    });
  }

  it("세션 없음 + 틀린 입력 · 입력 없음 → 입력 거절이 아니라 세션 거절", async () => {
    for (const input of [{ request_id: "req:1" }, {}]) {
      expect(await captureThrown(() => loadRequestTrace(input))).toBeInstanceOf(navigation.RedirectSignal);
    }
    for (const search of ["?request_id=req:1", ""]) {
      expect((await requestTraceResponse(apiRequest(search))).status).toBe(401);
    }
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("화면용 — 세션이 있으면", () => {
  beforeEach(() => { validSession(); });

  it("입력 없음 → 빈 화면(requestId · trace 둘 다 null), 부르지 않는다", async () => {
    expect(await loadRequestTrace({})).toEqual({ requestId: null, trace: null, spans: null });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["빈 값", { request_id: "" }],
    ["배열", { request_id: [TRACE_REQUEST_ID, "req-0123456789ac"] }],
    ["콜론", { request_id: "req:1" }],
    ["81자", { request_id: "r".repeat(81) }],
    ["태그", { request_id: "<script>" }],
  ])("틀린 입력(%s) → trace = invalid_input(request_id), 부르지 않는다", async (_label, input) => {
    const view = await loadRequestTrace(input);
    expect(view.requestId).toBeNull();
    expect(view.trace).not.toBeNull();
    expectFailure(view.trace!, "invalid_input");
    expect(view.trace).toMatchObject({ field: "request_id" });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("관측 서버의 로그 조회를 한 번 — GET · 본문 없음 · no-store · X-Observe-Secret 만 · 창은 지금부터 거꾸로 30일(구간 조회는 T7 — request-trace-spans.test)", async () => {
    const before = Date.now();
    const view = await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    const after = Date.now();
    expect(view.requestId).toBe(TRACE_REQUEST_ID);
    const trace = okValue(view.trace!);
    expect(trace.timeline?.visits).toEqual(["front", "backend", "llm", "backend", "front"]);
    const logCalls = callsToPath(upstreamFetch.mock.calls, "/logs");
    expect(logCalls).toHaveLength(1);
    const [input, init] = logCalls[0];
    const url = new URL(input);
    expect(url.pathname).toBe("/logs");
    expect(url.searchParams.get("request_id")).toBe(TRACE_REQUEST_ID);
    expect(url.searchParams.get("limit")).toBe("500");
    const from = Date.parse(url.searchParams.get("from")!);
    const to = Date.parse(url.searchParams.get("to")!);
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(after);
    expect(to - from).toBe(30 * DAY);
    expectReadOnlyRequest(init);
    expect(init?.cache).toBe("no-store");
    for (const name of SECRET_HEADER_NAMES) expect(headersOf(init).get(name)).toBe(name === "x-observe-secret" ? FAKE_OBSERVE_SECRET : null);
    expectNoForbiddenText(view);
  });

  it.each(["OBSERVE_URL", "OBSERVE_SECRET"])("%s 없음 → not_configured, 부르지 않는다", async (key) => {
    vi.stubEnv(key, "");
    const view = await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    expectFailure(view.trace!, "not_configured");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("OBSERVE_URL 이 주소가 아님 → not_configured", async () => {
    vi.stubEnv("OBSERVE_URL", "observe.example.test:17000");
    expectFailure((await loadRequestTrace({ request_id: TRACE_REQUEST_ID })).trace!, "not_configured");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("실패는 앱 로그 1줄 — 이유와 상태 코드만(비밀값 · 주소 · 원문 없음)", async () => {
    observeHandler = () => textResponse(leakyErrorBody(), 503);
    const view = await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    expectFailure(view.trace!, "unavailable", 503);
    await vi.waitFor(() => expect(everythingLogged()).toContain("screen:request-trace cell=trace upstream=unavailable status=503"));
    expectNoForbiddenText(everythingLogged());
  });

  it("닿지 않음(예외 문구에 주소 · 비밀값) → unreachable, 결과 · 로그에 원문 없음", async () => {
    observeHandler = () => Promise.reject(leakyNetworkError());
    const view = await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    expectFailure(view.trace!, "unreachable");
    expectNoForbiddenText(view);
    expectNoForbiddenText(everythingLogged());
  });

  it("입력 거절 · 성공은 앱 로그에 남기지 않는다", async () => {
    await loadRequestTrace({ request_id: "req:1" });
    await loadRequestTrace({ request_id: TRACE_REQUEST_ID });
    expect(everythingLogged()).not.toContain("screen:request-trace");
  });
});

describe("데이터 경로용 — 세션이 있으면", () => {
  beforeEach(() => { validSession(); });

  it("200 {success:true, data:RequestTraceView} · no-store · 비밀값 없음", async () => {
    const response = await requestTraceResponse(apiRequest(`?request_id=${TRACE_REQUEST_ID}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const text = await response.text();
    expectNoForbiddenText(text);
    const body = JSON.parse(text) as { success: boolean; data: RequestTraceView };
    expect(body.success).toBe(true);
    expect(body.data.requestId).toBe(TRACE_REQUEST_ID);
    expect(okValue(body.data.trace!).timeline?.lineCount).toBe(8);
  });

  it.each([
    ["없음", ""],
    ["빈 값", "?request_id="],
    ["두 번", `?request_id=${TRACE_REQUEST_ID}&request_id=req-0123456789ac`],
    ["콜론", "?request_id=req%3A1"],
    ["81자", `?request_id=${"r".repeat(81)}`],
  ])("입력 %s → 422 invalid_input(field request_id) · no-store, 부르지 않는다", async (_label, search) => {
    const response = await requestTraceResponse(apiRequest(search));
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    expect(await response.json()).toEqual({ success: false, error: { code: "invalid_input", field: "request_id" } });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("관측 서버가 500 + 비밀값 · 주소를 담은 본문 → 200(실패는 칸의 결과로), 응답 · 로그에 원문 없음", async () => {
    observeHandler = () => textResponse(leakyErrorBody(), 500);
    const response = await requestTraceResponse(apiRequest(`?request_id=${TRACE_REQUEST_ID}`));
    expect(response.status).toBe(200);
    const text = await response.text();
    expectNoForbiddenText(text);
    expectFailure((JSON.parse(text) as { data: RequestTraceView }).data.trace!, "bad_status", 500);
    expectNoForbiddenText(everythingLogged());
  });
});

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) files.push(...sourceFiles(fullPath));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) && !/test-fakes\.ts$/.test(entry)) files.push(fullPath);
  }
  return files;
}

function allImports(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("소스 검사 — 화면 · 데이터 경로 파일이 있다 · 브라우저 스크립트 없음 · 새 의존성 없음", () => {
  const featureFiles = sourceFiles(FEATURE_DIRECTORY);
  const appFiles = [...sourceFiles(join(SOURCE_DIRECTORY, "app", "trace")), ...sourceFiles(join(SOURCE_DIRECTORY, "app", "api", "trace"))];

  it("화면 · 데이터 경로 파일이 있다", () => {
    expect(appFiles.map((file) => relative(SOURCE_DIRECTORY, file)).sort()).toEqual(expect.arrayContaining(["app/api/trace/route.ts", "app/trace/page.tsx"]));
  });

  it('"use client" 가 없다(이 화면은 서버에서만 그린다)', () => {
    for (const file of [...featureFiles, ...appFiles]) expect(readFileSync(file, "utf8"), file).not.toMatch(/["']use client["']/);
  });

  it("새 의존성 없음 — package.json 의 것 · @/ · 상대 경로 · node: 만", () => {
    const packageJson = JSON.parse(readFileSync(join(SOURCE_DIRECTORY, "..", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const known = new Set(Object.keys(packageJson.dependencies ?? {}));
    for (const file of [...featureFiles, ...appFiles]) {
      for (const module of allImports(readFileSync(file, "utf8"))) {
        if (module.startsWith("@/") || module.startsWith(".") || module.startsWith("node:") || module === "server-only") continue;
        expect(known.has(module) || module === "react" || module.startsWith("react/"), `${file} → ${module}`).toBe(true);
      }
    }
  });
});
