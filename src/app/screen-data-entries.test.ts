/** 화면 넷의 서버 쪽 진입 함수(src/features/<기능>/server) — 명세 ② 인증 경계 + 세부 "인증 경계의 구현 형태":
 * "다른 서버를 부르는 모든 서버 쪽 함수와 Route Handler 가 같은 세션 검증 함수를 직접 호출한다(둘 중 하나가 빠져도 막힌다)".
 * middleware 없이 진입 함수를 직접 불러, 세션이 없으면 다른 서버를 **한 번도 부르지 않고** 화면용은 /login, 데이터 경로용은 401 인지 고정한다
 * (진입 함수에서 세션 검증 호출을 빼면 fetch 가 불려 빨강). 또 ② "비밀값은 서버 쪽에만" · "읽기 전용" · "한 곳이 죽어도 나머지는 보인다" ·
 * 설정이 빈 칸의 "설정 없음"을 진입 함수 수준(실제 설정 읽기 · 전역 fetch)에서 고정한다. */
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
import { deployHistoryResponse, loadDeployHistory } from "@/features/deploys/server/deploy-history";
import { loadLogSearch, logSearchResponse } from "@/features/logs/server/log-search";
import { loadLoginAttempts, loginAttemptsResponse } from "@/features/login-attempts/server/login-attempts";
import { loadStatusOverview, statusOverviewResponse } from "@/features/status/server/status-overview";
import { STATUS_CHECK_NAMES } from "@/features/status/lib/status-overview";
import type { SearchParamsInput, UpstreamResult } from "@/shared/lib/upstream-result";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  SECRET_HEADER_NAMES, createRoutedFetch, expectFailure, expectNoForbiddenText, expectReadOnlyRequest, headersOf, jsonBody,
  leakyErrorBody, leakyNetworkError, okValue, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";

/** 주소(origin + 경로) → 정상 응답(각 서버의 실제 계약 꼴). */
const UPSTREAM_ROUTES: Record<string, () => Response> = {
  [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: () => jsonBody({ success: true, data: { deployments: [{
    request_id: "r-1", service: "front", commit_sha: "abc123", state: "succeeded", accepted_at: "2026-11-22T01:00:00Z",
    finished_at: "2026-11-22T01:03:00Z", ci_ms: 60000, cd_ms: 30000,
  }] } }),
  [`${FAKE_DEPLOY_MASTER_URL}/health`]: () => jsonBody({ success: true, data: { mode: "master" } }),
  [`${FAKE_OBSERVE_URL}/logs`]: () => jsonBody({ success: true, data: {
    logs: [{ id: "1-0", at: "2026-11-22T10:00:00Z", level: "info", service: "admin", request_id: "req-1", message: "hello" }],
    next_before: "", from: "2026-11-22T09:00:00Z", to: "2026-11-22T10:00:00Z",
  } }),
  [`${FAKE_OBSERVE_URL}/auth/attempts`]: () => jsonBody({ success: true, data: {
    attempts: [{ id: "0f8fad5b-d9cb-469f-a165-70867728950e", at: "2026-11-22T10:00:00Z", outcome: "success", ip: "203.0.113.9", user_agent: "FakeBrowser/1.0", replayed: false }],
    next_before: "", from: "2026-08-24T12:00:00Z", to: "2026-11-22T12:00:00Z",
  } }),
  [`${FAKE_OBSERVE_URL}/auth/lock`]: () => jsonBody({ success: true, data: { locked: false, locked_until: null, failures: 0 } }),
  [`${FAKE_OBSERVE_URL}/health`]: () => jsonBody({ status: "ok" }),
  [`${FAKE_ALERT_URL}/monitors`]: () => jsonBody({ success: true, data: { monitors: [], last_round_at: "", undelivered: 0 } }),
  [`${FAKE_ALERT_URL}/health`]: () => jsonBody({ status: "ok", last_round_at: "", active: true }),
  [`${FAKE_BACKEND_URL}/api/health/dependencies`]: () => jsonBody({ status: "UP", components: { redis: { status: "UP" } } }),
};

/** 주소 → 실어야 하는 비밀 헤더(그 밖의 비밀 헤더는 없어야 한다). */
const EXPECTED_SECRET_HEADER: Record<string, [string, string] | null> = {
  [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: ["x-deploy-secret", FAKE_DEPLOY_SECRET],
  [`${FAKE_DEPLOY_MASTER_URL}/health`]: null,
  [`${FAKE_OBSERVE_URL}/logs`]: ["x-observe-secret", FAKE_OBSERVE_SECRET],
  [`${FAKE_OBSERVE_URL}/auth/attempts`]: ["x-observe-secret", FAKE_OBSERVE_SECRET],
  [`${FAKE_OBSERVE_URL}/auth/lock`]: ["x-observe-secret", FAKE_OBSERVE_SECRET],
  [`${FAKE_OBSERVE_URL}/health`]: null,
  [`${FAKE_ALERT_URL}/monitors`]: ["x-alert-secret", FAKE_ALERT_SECRET],
  [`${FAKE_ALERT_URL}/health`]: null,
  [`${FAKE_BACKEND_URL}/api/health/dependencies`]: null,
};

function routeKey(url: URL) {
  return `${url.origin}${url.pathname}`;
}

let upstreamOverride: ((url: URL, init: RequestInit) => Promise<Response> | Response) | null = null;
const upstreamFetch = createRoutedFetch((url, init) => {
  if (upstreamOverride) return upstreamOverride(url, init);
  const route = UPSTREAM_ROUTES[routeKey(url)];
  if (!route) throw new Error(`unexpected upstream ${url.pathname}`);
  return route();
});

interface EntryCase {
  name: string;
  page: (input: SearchParamsInput) => Promise<unknown>;
  api: (request: Request) => Promise<Response>;
  apiPath: string;
  validInput: SearchParamsInput;
  /** 입력 검증에서 걸리는 입력(없는 기능은 null) */
  invalidInput: SearchParamsInput | null;
  /** 이 기능이 부르는 주소(routeKey) */
  routes: string[];
}

const ENTRIES: EntryCase[] = [
  { name: "배포 이력", page: (input) => loadDeployHistory(input), api: (request) => deployHistoryResponse(request), apiPath: "/api/deploys",
    validInput: { service: "front", limit: "20" }, invalidInput: { service: "not-a-service" }, routes: [`${FAKE_DEPLOY_MASTER_URL}/deploys`] },
  { name: "로그 조회", page: (input) => loadLogSearch(input), api: (request) => logSearchResponse(request), apiPath: "/api/logs",
    validInput: { service: "admin", q: "hello" }, invalidInput: { q: "a" }, routes: [`${FAKE_OBSERVE_URL}/logs`] },
  { name: "상태 한눈에", page: () => loadStatusOverview(), api: (request) => statusOverviewResponse(request), apiPath: "/api/status",
    validInput: {}, invalidInput: null, routes: [
      `${FAKE_ALERT_URL}/monitors`, `${FAKE_ALERT_URL}/health`, `${FAKE_OBSERVE_URL}/health`,
      `${FAKE_BACKEND_URL}/api/health/dependencies`, `${FAKE_DEPLOY_MASTER_URL}/health`,
    ] },
  { name: "로그인 시도 기록", page: (input) => loadLoginAttempts(input), api: (request) => loginAttemptsResponse(request), apiPath: "/api/login-attempts",
    validInput: { limit: "20" }, invalidInput: { before: "2026-11-22T10:00:00Z_0f8fad5b-d9cb-469f-a165-70867728950e" },
    routes: [`${FAKE_OBSERVE_URL}/auth/attempts`, `${FAKE_OBSERVE_URL}/auth/lock`] },
];

const invalidSessions: [string, () => string | undefined][] = [
  ["쿠키 없음", () => undefined],
  ["잘못된 서명", () => issueSessionToken(OTHER_KEY, Date.now())],
  ["만료", () => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
];

function setSessionCookie(value: string | undefined) {
  navigation.cookieValues.clear();
  if (value !== undefined) navigation.cookieValues.set(SESSION_COOKIE_NAME, value);
}

function validSession() {
  setSessionCookie(issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
}

function apiRequest(path: string, input: SearchParamsInput): Request {
  const url = new URL(path, FAKE_ORIGIN);
  for (const [name, value] of Object.entries(input)) {
    for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) url.searchParams.append(name, each);
  }
  return new Request(url, { method: "GET", headers: { origin: FAKE_ORIGIN } });
}

async function captureThrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

function expectLoginLocation(location: string) {
  expect([`/login`, `${FAKE_ORIGIN}/login`]).toContain(location);
}

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

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
  upstreamOverride = null;
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

function everythingLogged(): string {
  const consoleText = consoleSpies.flatMap((spy) => spy.mock.calls.flat()).map((part) => String(part));
  const streamText = [process.stdout.write, process.stderr.write].flatMap((write) =>
    (vi.isMockFunction(write) ? write.mock.calls.map((call) => String(call[0])) : []));
  return [...consoleText, ...streamText].join("\n");
}

describe("세션이 없으면 다른 서버를 한 번도 부르지 않고 거절한다", () => {
  for (const entry of ENTRIES) {
    for (const [label, makeCookie] of invalidSessions) {
      it(`${entry.name} 화면용 · ${label} → /login, fetch 0회`, async () => {
        setSessionCookie(makeCookie());
        const thrown = await captureThrown(() => entry.page(entry.validInput));
        expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
        expectLoginLocation((thrown as InstanceType<typeof navigation.RedirectSignal>).location);
        expect(upstreamFetch).not.toHaveBeenCalled();
      });

      it(`${entry.name} 데이터 경로용 · ${label} → 401(데이터 없음 · no-store), fetch 0회`, async () => {
        setSessionCookie(makeCookie());
        const response = await entry.api(apiRequest(entry.apiPath, entry.validInput));
        expect(response.status).toBe(401);
        expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
        const body = await response.json();
        expect(body.success).toBe(false);
        expect(body).not.toHaveProperty("data");
        expect(upstreamFetch).not.toHaveBeenCalled();
      });
    }

    if (entry.invalidInput) {
      it(`${entry.name} · 세션 없음 + 틀린 입력 → 입력 거절이 아니라 세션 거절(검증보다 세션이 먼저)`, async () => {
        const thrown = await captureThrown(() => entry.page(entry.invalidInput!));
        expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
        const response = await entry.api(apiRequest(entry.apiPath, entry.invalidInput!));
        expect(response.status).toBe(401);
        expect(upstreamFetch).not.toHaveBeenCalled();
      });
    }
  }
});

describe("유효한 세션 — 부르고, GET 만, 비밀값은 그 서버의 헤더로만", () => {
  for (const entry of ENTRIES) {
    it(`${entry.name} 화면용 → 이 기능의 주소를 부른다 · 전부 GET · 본문 없음`, async () => {
      validSession();
      const view = await entry.page(entry.validInput);
      expect(view).toBeDefined();
      const calledRoutes = upstreamFetch.mock.calls.map(([input]) => routeKey(new URL(input)));
      expect([...new Set(calledRoutes)].sort()).toEqual([...entry.routes].sort());
      for (const [, init] of upstreamFetch.mock.calls) expectReadOnlyRequest(init);
      expectNoForbiddenText(view);
    });

    it(`${entry.name} · 각 호출의 비밀 헤더는 그 서버의 것 하나뿐(헬스 호출에는 없음)`, async () => {
      validSession();
      await entry.page(entry.validInput);
      expect(upstreamFetch).toHaveBeenCalled();
      for (const [input, init] of upstreamFetch.mock.calls) {
        const key = routeKey(new URL(input));
        const expected = EXPECTED_SECRET_HEADER[key];
        const headers = headersOf(init);
        for (const name of SECRET_HEADER_NAMES) {
          if (expected && expected[0] === name) expect(headers.get(name), `${key} ${name}`).toBe(expected[1]);
          else expect(headers.get(name), `${key} ${name}`).toBeNull();
        }
      }
    });

    it(`${entry.name} 데이터 경로용 → 200 · no-store · {success:true,data} · 비밀값 없음`, async () => {
      validSession();
      const response = await entry.api(apiRequest(entry.apiPath, entry.validInput));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
      const text = await response.text();
      const body = JSON.parse(text);
      expect(body.success).toBe(true);
      expect(body).toHaveProperty("data");
      expectNoForbiddenText(text);
      for (const [, init] of upstreamFetch.mock.calls) expectReadOnlyRequest(init);
    });

    if (entry.invalidInput) {
      it(`${entry.name} · 틀린 입력 → 데이터 경로 422 invalid_input, 목록 주소는 부르지 않는다`, async () => {
        validSession();
        const response = await entry.api(apiRequest(entry.apiPath, entry.invalidInput!));
        expect(response.status).toBe(422);
        const body = await response.json();
        expect(body).toMatchObject({ success: false, error: { code: "invalid_input" } });
        expect(typeof body.error.field).toBe("string");
        expect(upstreamFetch).not.toHaveBeenCalled();
      });

      it(`${entry.name} · 틀린 입력 → 화면용 결과는 invalid_input, 목록 주소는 부르지 않는다`, async () => {
        validSession();
        const view = await entry.page(entry.invalidInput!) as Record<string, unknown>;
        expect(view.query).toBeNull();
        const listRoute = entry.routes[0];
        expect(upstreamFetch.mock.calls.map(([input]) => routeKey(new URL(input)))).not.toContain(listRoute);
        const listResultKey = { "배포 이력": "deployments", "로그 조회": "logs", "로그인 시도 기록": "attempts" }[entry.name]!;
        expectFailure(view[listResultKey] as UpstreamResult<unknown>, "invalid_input");
      });
    }
  }
});

describe("다른 서버가 이상하게 답해도 비밀값 · 주소 · 원문이 결과 · 응답 · 로그에 들어가지 않는다", () => {
  const behaviors: [string, (url: URL, init: RequestInit) => Promise<Response> | Response][] = [
    ["전부 500 + 비밀값 · 주소를 담은 오류 본문", () => textResponse(leakyErrorBody(), 500)],
    ["전부 200 + 비밀값을 담은 깨진 본문", () => textResponse(`{${leakyErrorBody()}`)],
    ["전부 연결 실패(예외 문구에 주소 · 비밀값)", () => Promise.reject(leakyNetworkError())],
  ];

  for (const entry of ENTRIES) {
    for (const [label, behavior] of behaviors) {
      it(`${entry.name} · ${label}`, async () => {
        validSession();
        upstreamOverride = behavior;
        const view = await entry.page(entry.validInput);
        expectNoForbiddenText(view);
        const response = await entry.api(apiRequest(entry.apiPath, entry.validInput));
        expect(response.status).toBe(200);   // 실패는 칸의 결과로 — 다른 서버의 상태를 이 경로의 상태로 옮기지 않는다
        expectNoForbiddenText(await response.text());
        expectNoForbiddenText(everythingLogged());
      });
    }
  }
});

describe("설정이 빈 칸만 '설정 없음'(호출하지 않는다)", () => {
  it.each(["DEPLOY_MASTER_URL", "DEPLOY_SECRET"])("%s 없음 → 배포 이력 not_configured, master 를 부르지 않는다", async (key) => {
    validSession();
    vi.stubEnv(key, "");
    const view = await loadDeployHistory({});
    expectFailure(view.deployments, "not_configured");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("DEPLOY_MASTER_URL 이 주소가 아님 → not_configured", async () => {
    validSession();
    vi.stubEnv("DEPLOY_MASTER_URL", "deploy-master.example.test:15000");
    expectFailure((await loadDeployHistory({})).deployments, "not_configured");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each(["OBSERVE_URL", "OBSERVE_SECRET"])("%s 없음 → 로그 조회 · 로그인 시도 기록 not_configured, 호출 없음", async (key) => {
    validSession();
    vi.stubEnv(key, "");
    expectFailure((await loadLogSearch({})).logs, "not_configured");
    const attempts = await loadLoginAttempts({});
    expectFailure(attempts.attempts, "not_configured");
    expectFailure(attempts.lock, "not_configured");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("ALERT_URL 없음 → 상태의 alert 두 칸만 not_configured, 나머지 셋은 정상", async () => {
    validSession();
    vi.stubEnv("ALERT_URL", "");
    const overview = await loadStatusOverview();
    expectFailure(overview.alertMonitors, "not_configured");
    expectFailure(overview.alertHealth, "not_configured");
    for (const name of STATUS_CHECK_NAMES.filter((each) => !each.startsWith("alert"))) okValue(overview[name] as UpstreamResult<unknown>);
    expect(upstreamFetch.mock.calls.some(([input]) => new URL(input).origin === new URL(FAKE_ALERT_URL).origin)).toBe(false);
  });

  it("ALERT_SECRET 없음 → /monitors 만 not_configured(헬스는 부른다)", async () => {
    validSession();
    vi.stubEnv("ALERT_SECRET", "");
    const overview = await loadStatusOverview();
    expectFailure(overview.alertMonitors, "not_configured");
    okValue(overview.alertHealth);
  });

  it("BACKEND_URL · DEPLOY_MASTER_URL 없음 → 그 두 칸만 not_configured", async () => {
    validSession();
    vi.stubEnv("BACKEND_URL", "");
    vi.stubEnv("DEPLOY_MASTER_URL", "");
    const overview = await loadStatusOverview();
    expectFailure(overview.backendDependencies, "not_configured");
    expectFailure(overview.deployMasterHealth, "not_configured");
    okValue(overview.alertMonitors);
    okValue(overview.alertHealth);
    okValue(overview.observeHealth);
  });

  it("상태 칸 하나가 죽어도(backend 연결 실패) 나머지 넷은 보인다 — 진입 함수 수준", async () => {
    validSession();
    upstreamOverride = (url) => {
      if (url.origin === new URL(FAKE_BACKEND_URL).origin) return Promise.reject(leakyNetworkError());
      return UPSTREAM_ROUTES[routeKey(url)]();
    };
    const overview = await loadStatusOverview();
    expectFailure(overview.backendDependencies, "unreachable");
    for (const name of STATUS_CHECK_NAMES.filter((each) => each !== "backendDependencies")) okValue(overview[name] as UpstreamResult<unknown>);
  });

  it("로그인 시도 기록 — 잠금 상태가 실패해도 목록은 보인다(그 반대도)", async () => {
    validSession();
    upstreamOverride = (url) => (url.pathname === "/auth/lock" ? textResponse(leakyErrorBody(), 503) : UPSTREAM_ROUTES[routeKey(url)]());
    let view = await loadLoginAttempts({});
    expectFailure(view.lock, "unavailable", 503);
    okValue(view.attempts);
    upstreamOverride = (url) => (url.pathname === "/auth/attempts" ? textResponse(leakyErrorBody(), 503) : UPSTREAM_ROUTES[routeKey(url)]());
    view = await loadLoginAttempts({});
    expectFailure(view.attempts, "unavailable", 503);
    okValue(view.lock);
  });
});
