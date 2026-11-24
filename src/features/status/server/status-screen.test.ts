/** 상태 한눈에 + 서버 자원 요약의 서버 쪽 진입 — 명세 §2.3 "어드민은 세션을 확인한 뒤에만 부르고, 한 구역이 실패해도 다른 구역은 보인다" · §2.6 "상태 한눈에" ·
 * 기존 인증 경계("다른 서버를 부르는 모든 서버 쪽 함수가 같은 세션 검증 함수를 직접 호출"). 기존 loadStatusOverview 는 바뀌지 않는다(다섯 주소 — screen-data-entries.test).
 * 전역 fetch 를 가짜로 바꾼다. */
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
import { loadStatusScreen, statusScreenResponse } from "@/features/status/server/status-screen";
import { loadStatusOverview } from "@/features/status/server/status-overview";
import type { StatusScreenData } from "@/features/status/lib/status-resources";
import { observeLatestBody, observeLatestServer } from "@/features/resources/lib/resource-metrics-test-fakes";
import type { UpstreamResult } from "@/shared/lib/upstream-result";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  SECRET_HEADER_NAMES, createRoutedFetch, expectFailure, expectNoForbiddenText, headersOf, jsonBody, leakyErrorBody, okValue, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";

let latestResponse: () => Response = () => observeLatestBody([observeLatestServer("158")]);
const ROUTES: Record<string, () => Response> = {
  [`${FAKE_OBSERVE_URL}/metrics/latest`]: () => latestResponse(),
  [`${FAKE_ALERT_URL}/monitors`]: () => jsonBody({ success: true, data: { monitors: [], last_round_at: "", undelivered: 0 } }),
  [`${FAKE_ALERT_URL}/health`]: () => jsonBody({ status: "ok", last_round_at: "", active: true }),
  [`${FAKE_OBSERVE_URL}/health`]: () => jsonBody({ status: "ok" }),
  [`${FAKE_BACKEND_URL}/api/health/dependencies`]: () => jsonBody({ status: "UP", components: { redis: { status: "UP" } } }),
  [`${FAKE_DEPLOY_MASTER_URL}/health`]: () => jsonBody({ success: true, data: { mode: "master" } }),
};
const upstreamFetch = createRoutedFetch((url) => {
  const route = ROUTES[`${url.origin}${url.pathname}`];
  if (!route) throw new Error(`unexpected upstream ${url.pathname}`);
  return route();
});

function setSessionCookie(value: string | undefined) {
  navigation.cookieValues.clear();
  if (value !== undefined) navigation.cookieValues.set(SESSION_COOKIE_NAME, value);
}

function routesCalled(): string[] {
  return [...new Set(upstreamFetch.mock.calls.map(([input]) => `${new URL(input).origin}${new URL(input).pathname}`))].sort();
}

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
function everythingLogged(): string {
  return consoleSpies.flatMap((spy) => spy.mock.calls.flat()).map((part) => String(part)).join("\n");
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
  latestResponse = () => observeLatestBody([observeLatestServer("158")]);
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
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

describe("세션이 없으면 아무 서버도 부르지 않는다", () => {
  it.each([
    ["쿠키 없음", () => undefined],
    ["잘못된 서명", () => issueSessionToken(OTHER_KEY, Date.now())],
    ["만료", () => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
  ] as [string, () => string | undefined][])("%s → 화면용 /login · 데이터 경로용 401, fetch 0회", async (_label, makeCookie) => {
    setSessionCookie(makeCookie());
    const thrown = await loadStatusScreen().then(() => null, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
    const response = await statusScreenResponse(new Request(new URL("/api/status", FAKE_ORIGIN)));
    expect(response.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("세션이 있으면", () => {
  beforeEach(() => { setSessionCookie(issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000)); });

  it("여섯 주소(기존 다섯 + /metrics/latest) · overview 는 기존 진입과 같은 꼴 · resources 는 요약", async () => {
    const data = await loadStatusScreen();
    expect(routesCalled()).toEqual([...Object.keys(ROUTES)].sort());
    expect(Object.keys(data).sort()).toEqual(["overview", "resources"]);
    expect(okValue(data.resources).rows.map((row) => row.server)).toEqual(["158"]);
    upstreamFetch.mockClear();
    const overview = await loadStatusOverview();
    expect(data.overview).toStrictEqual(overview);
    expect(routesCalled()).not.toContain(`${FAKE_OBSERVE_URL}/metrics/latest`);   // 기존 진입은 그대로 다섯 주소
    expectNoForbiddenText(data);
  });

  it("비밀 헤더 — /metrics/latest 는 X-Observe-Secret 만, 헬스에는 없다", async () => {
    await loadStatusScreen();
    for (const [input, init] of upstreamFetch.mock.calls) {
      const key = `${new URL(input).origin}${new URL(input).pathname}`;
      for (const name of SECRET_HEADER_NAMES) {
        const expected = key === `${FAKE_OBSERVE_URL}/metrics/latest` && name === "x-observe-secret" ? FAKE_OBSERVE_SECRET
          : key === `${FAKE_ALERT_URL}/monitors` && name === "x-alert-secret" ? FAKE_ALERT_SECRET : null;
        expect(headersOf(init).get(name), `${key} ${name}`).toBe(expected);
      }
    }
  });

  it("데이터 경로용 — 200 {success:true,data:{overview,resources}} · no-store", async () => {
    const response = await statusScreenResponse(new Request(new URL("/api/status", FAKE_ORIGIN)));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const text = await response.text();
    expectNoForbiddenText(text);
    const body = JSON.parse(text) as { success: boolean; data: StatusScreenData };
    expect(body.success).toBe(true);
    expect(Object.keys(body.data).sort()).toEqual(["overview", "resources"]);
  });

  it("자원 조회 실패 → resources 만 실패 · 다섯 칸은 값 · 앱 로그 1줄(이유와 상태 코드만)", async () => {
    latestResponse = () => textResponse(leakyErrorBody(), 503);
    const data = await loadStatusScreen();
    expectFailure(data.resources, "unavailable", 503);
    for (const cell of Object.values(data.overview)) okValue(cell as UpstreamResult<unknown>);
    await vi.waitFor(() => expect(everythingLogged()).toContain("screen:status cell=resources upstream=unavailable status=503"));
    expectNoForbiddenText(everythingLogged());
  });

  it("OBSERVE_SECRET 이 비면 자원만 not_configured(호출 없음) · 관측 서버 헬스는 그대로", async () => {
    vi.stubEnv("OBSERVE_SECRET", "");
    const data = await loadStatusScreen();
    expectFailure(data.resources, "not_configured");
    okValue(data.overview.observeHealth);
    expect(routesCalled()).not.toContain(`${FAKE_OBSERVE_URL}/metrics/latest`);
  });
});

describe("소스 검사 — 새 진입은 server-only 이고 세션 검증을 직접 부른다", () => {
  it("status-screen.ts", () => {
    const source = readFileSync(fileURLToPath(new URL("./status-screen.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/^import "server-only";/m);
    expect(source).toMatch(/from "@\/features\/auth\/server\/require-session"/);
    expect(source).toMatch(/\brequireSession\s*\(/);
    expect(source).toMatch(/\brequireApiSession\s*\(/);
  });
});
