/** 문제 화면의 서버 쪽 진입 — 차례: 세션 → 입력 → 설정 → 호출. 로그인하지 않은 요청에 다른 서버 호출 0. 읽기 전용 · 비밀값 비노출.
 * middleware 없이 진입 함수를 직접 부른다(진입 함수에서 세션 검증을 빼면 fetch 가 불려 빨강). */
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
import { incidentsScreenResponse, loadIncidentsScreen } from "@/features/incidents/server/incidents-screen";
import { monitorIncidentId } from "@/features/incidents/lib/incident-id";
import {
  NOW, alertRecordsBody, deploymentRow, deploymentsBody, emptySeriesBody, iso, latestBody, latestServerRow, logsBody, monitorsBody, seenContainersBody,
} from "@/features/incidents/lib/incidents-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  createRoutedFetch, expectNoForbiddenText, expectReadOnlyRequest, jsonBody, leakyErrorBody, leakyNetworkError, textResponse,
} from "@/shared/lib/upstream-test-fakes";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";

const ROUTES: Record<string, (url: URL) => Response> = {
  [`${FAKE_ALERT_URL}/monitors`]: () => jsonBody(monitorsBody([{ name: "front", status: "DOWN", down_since: iso(NOW - 600_000), reason: "status 502" }])),
  [`${FAKE_ALERT_URL}/incidents`]: () => jsonBody(alertRecordsBody([])),
  [`${FAKE_OBSERVE_URL}/metrics/latest`]: () => jsonBody(latestBody([latestServerRow("s158")], [])),
  [`${FAKE_OBSERVE_URL}/metrics/containers`]: (url) => jsonBody(seenContainersBody(url.searchParams.get("server")!, Date.parse(url.searchParams.get("at")!), ["front-app"])),
  [`${FAKE_OBSERVE_URL}/metrics/series`]: (url) => jsonBody(emptySeriesBody(url.searchParams)),
  [`${FAKE_OBSERVE_URL}/logs`]: (url) => jsonBody(logsBody([], url.searchParams.get("from")!, url.searchParams.get("to")!)),
  [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: () => jsonBody(deploymentsBody([deploymentRow()])),
};

let upstreamOverride: ((url: URL) => Promise<Response> | Response) | null = null;
const upstreamFetch = createRoutedFetch((url) => {
  if (upstreamOverride) return upstreamOverride(url);
  const route = ROUTES[`${url.origin}${url.pathname}`];
  if (!route) throw new Error(`unexpected upstream ${url.pathname}`);
  return route(url);
});

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

function apiRequest(input: Record<string, string | string[]>): Request {
  const url = new URL("/api/incidents", FAKE_ORIGIN);
  for (const [name, value] of Object.entries(input)) for (const each of Array.isArray(value) ? value : [value]) url.searchParams.append(name, each);
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
  upstreamOverride = null;
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  setSessionCookie(undefined);
  consoleSpies.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("세션이 없으면 다른 서버를 한 번도 부르지 않고 거절한다", () => {
  for (const [label, makeCookie] of invalidSessions) {
    it(`화면용 · ${label} → /login, fetch 0회`, async () => {
      setSessionCookie(makeCookie());
      const thrown = await captureThrown(() => loadIncidentsScreen({ incident: monitorIncidentId("front") }));
      expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
      expect(["/login", `${FAKE_ORIGIN}/login`]).toContain((thrown as InstanceType<typeof navigation.RedirectSignal>).location);
      expect(upstreamFetch).not.toHaveBeenCalled();
    });

    it(`데이터 경로용 · ${label} → 401(데이터 없음 · no-store), fetch 0회`, async () => {
      setSessionCookie(makeCookie());
      const response = await incidentsScreenResponse(apiRequest({ incident: monitorIncidentId("front") }));
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body).not.toHaveProperty("data");
      expect(upstreamFetch).not.toHaveBeenCalled();
    });
  }

  it("세션 없음 + 틀린 입력 → 입력 거절이 아니라 세션 거절(세션이 먼저)", async () => {
    expect(await captureThrown(() => loadIncidentsScreen({ incident: "monitor:<script>" }))).toBeInstanceOf(navigation.RedirectSignal);
    expect((await incidentsScreenResponse(apiRequest({ incident: "monitor:<script>" }))).status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("입력 검증은 설정 · 호출보다 먼저", () => {
  it.each([["형식 밖", { incident: "monitor:<script>" }], ["여러 번", { incident: ["monitor:front", "monitor:backend"] }]] as [string, SearchParamsInput][])(
    "%s → 화면용 invalid_input(field incident), 데이터 경로 422, fetch 0회", async (_label, input) => {
      validSession();
      expect(await loadIncidentsScreen(input)).toEqual({ kind: "invalid_input", field: "incident" });
      const response = await incidentsScreenResponse(apiRequest(input as Record<string, string | string[]>));
      expect(response.status).toBe(422);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
      expect(await response.json()).toEqual({ success: false, error: { code: "invalid_input", field: "incident" } });
      expect(upstreamFetch).not.toHaveBeenCalled();
    });

  it("틀린 입력이면 설정이 비어 있어도 '설정 없음'이 아니라 입력 거절", async () => {
    validSession();
    vi.stubEnv("ALERT_URL", "");
    expect(await loadIncidentsScreen({ incident: "x" })).toEqual({ kind: "invalid_input", field: "incident" });
  });
});

describe("유효한 세션 — 부르고, GET 만, 결과에 비밀값 · 주소가 없다", () => {
  it("화면용 → 목록(네 호출) · 데이터 경로 → 200 {success:true,data} no-store", async () => {
    validSession();
    const outcome = await loadIncidentsScreen({});
    expect(outcome.kind).toBe("screen");
    if (outcome.kind !== "screen") throw new Error("screen");
    expect(outcome.data.list.incidents.map((incident) => incident.id)).toEqual([monitorIncidentId("front")]);
    expect(upstreamFetch).toHaveBeenCalledTimes(4);
    for (const [, init] of upstreamFetch.mock.calls) expectReadOnlyRequest(init);
    expectNoForbiddenText(outcome);

    upstreamFetch.mockClear();
    const response = await incidentsScreenResponse(apiRequest({ incident: monitorIncidentId("front") }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.success).toBe(true);
    expect(body.data.selected.kind).toBe("evidence");
    expect(typeof body.data.selected.text).toBe("string");
    expectNoForbiddenText(text);
    for (const [, init] of upstreamFetch.mock.calls) expectReadOnlyRequest(init);
  });

  it("설정이 빈 출처만 '설정 없음' — 실제 설정 읽기", async () => {
    validSession();
    vi.stubEnv("DEPLOY_SECRET", "");
    const outcome = await loadIncidentsScreen({});
    if (outcome.kind !== "screen") throw new Error("screen");
    expect(outcome.data.list.unchecked.map((failure) => failure.text)).toEqual(["배포 서버(배포 이력): 확인하지 못함 — 설정 없음"]);
    expect(upstreamFetch.mock.calls.some(([input]) => new URL(input).origin === new URL(FAKE_DEPLOY_MASTER_URL).origin)).toBe(false);
  });
});

describe("다른 서버가 이상하게 답해도 비밀값 · 주소 · 원문이 결과 · 응답 · 로그에 들어가지 않는다", () => {
  const behaviors: [string, (url: URL) => Promise<Response> | Response][] = [
    ["전부 500 + 비밀값 · 주소를 담은 오류 본문", () => textResponse(leakyErrorBody(), 500)],
    ["전부 200 + 깨진 본문", () => textResponse(`{${leakyErrorBody()}`)],
    ["전부 연결 실패(예외 문구에 주소 · 비밀값)", () => Promise.reject(leakyNetworkError())],
    ["목록은 정상, 근거 칸들만 실패", (url) => (["/incidents", "/metrics/containers", "/metrics/series"].includes(url.pathname) || (url.pathname === "/logs" && url.searchParams.has("service"))
      ? textResponse(leakyErrorBody(), 503) : ROUTES[`${url.origin}${url.pathname}`](url))],
  ];

  for (const [label, behavior] of behaviors) {
    it(label, async () => {
      validSession();
      upstreamOverride = behavior;
      const outcome = await loadIncidentsScreen({ incident: monitorIncidentId("front") });
      expectNoForbiddenText(outcome);
      const response = await incidentsScreenResponse(apiRequest({ incident: monitorIncidentId("front") }));
      expect(response.status).toBe(200);   // 실패는 칸의 결과로 — 다른 서버의 상태를 이 경로의 상태로 옮기지 않는다
      expectNoForbiddenText(await response.text());
      expectNoForbiddenText(everythingLogged());
    });
  }

  it("실패한 칸은 앱 로그에 한 줄씩 — 이유 낱말만(screen:incidents)", async () => {
    validSession();
    upstreamOverride = (url) => (url.pathname === "/incidents" ? textResponse(leakyErrorBody(), 503) : ROUTES[`${url.origin}${url.pathname}`](url));
    await loadIncidentsScreen({ incident: monitorIncidentId("front") });
    expect(everythingLogged()).toMatch(/screen:incidents cell=\S+ upstream=unavailable status=503/);
  });
});
