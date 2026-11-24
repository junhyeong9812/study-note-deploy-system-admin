/** 서버 자원 화면의 서버 쪽 진입 — 명세 §2.3 "어드민은 지금처럼 세션을 확인한 뒤에만 부르고, 한 구역이 실패해도 다른 구역은 보인다" ·
 * 기존 화면의 인증 경계("다른 서버를 부르는 모든 서버 쪽 함수와 Route Handler 가 같은 세션 검증 함수를 직접 호출한다") · "비밀값은 서버 쪽에만".
 * 세션이 없으면 관측 서버를 한 번도 부르지 않고 화면용은 /login, 데이터 경로용은 401. 전역 fetch 를 가짜로 바꾼다(실제 서버를 부르지 않는다).
 * 소스 검사 — 기존 screen-data-imports.test 의 SCREEN_FEATURES 에 resources 가 없으므로 같은 규칙을 이 기능에 직접 건다. */
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
import { loadResourcesScreen, resourcesScreenResponse } from "@/features/resources/server/resources-screen";
import type { ResourcesScreen } from "@/features/resources/lib/resources-screen";
import {
  DAY, HOUR, createFakeObserveMetrics, observeLatestBody, observeLatestServer, type FakeObserveMetrics,
} from "@/features/resources/lib/resource-metrics-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  SECRET_HEADER_NAMES, createRoutedFetch, expectFailure, expectNoForbiddenText, headersOf, leakyErrorBody, okValue, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const SOURCE_DIRECTORY = fileURLToPath(new URL("../../..", import.meta.url));
const FEATURE_DIRECTORY = join(SOURCE_DIRECTORY, "features", "resources");
const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";

let fake: FakeObserveMetrics;
const upstreamFetch = createRoutedFetch((url, init) => {
  if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected upstream ${url.hostname}`);
  return fake.handler(url, init);
});

function setSessionCookie(value: string | undefined) {
  navigation.cookieValues.clear();
  if (value !== undefined) navigation.cookieValues.set(SESSION_COOKIE_NAME, value);
}

function validSession() {
  setSessionCookie(issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
}

function apiRequest(search: string): Request {
  return new Request(new URL(`/api/resources${search}`, FAKE_ORIGIN), { method: "GET", headers: { origin: FAKE_ORIGIN } });
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
  fake = createFakeObserveMetrics(() => observeLatestBody([observeLatestServer("158")]));
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

describe("세션이 없으면 관측 서버를 한 번도 부르지 않는다", () => {
  for (const [label, makeCookie] of invalidSessions) {
    it(`화면용 · ${label} → /login, fetch 0회`, async () => {
      setSessionCookie(makeCookie());
      const thrown = await captureThrown(() => loadResourcesScreen({ range: "24h" }));
      expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
      expect([`/login`, `${FAKE_ORIGIN}/login`]).toContain((thrown as InstanceType<typeof navigation.RedirectSignal>).location);
      expect(upstreamFetch).not.toHaveBeenCalled();
    });

    it(`데이터 경로용 · ${label} → 401, fetch 0회`, async () => {
      setSessionCookie(makeCookie());
      const response = await resourcesScreenResponse(apiRequest("?range=24h"));
      expect(response.status).toBe(401);
      expect(upstreamFetch).not.toHaveBeenCalled();
      expectNoForbiddenText(await response.text());
    });
  }
});

describe("세션이 있으면", () => {
  beforeEach(() => { validSession(); });

  it("화면용 — 주소 입력으로 기간을 정하고 관측 서버를 X-Observe-Secret 으로만 부른다", async () => {
    const screen = await loadResourcesScreen({ range: "7d" });
    expect(screen.window.range).toBe("7d");
    expect(screen.window.toMilliseconds - screen.window.fromMilliseconds).toBe(7 * DAY);
    expect(okValue(screen.servers).map((server) => server.server)).toEqual(["158"]);
    expect(upstreamFetch).toHaveBeenCalled();
    for (const [, init] of upstreamFetch.mock.calls) {
      for (const name of SECRET_HEADER_NAMES) expect(headersOf(init).get(name)).toBe(name === "x-observe-secret" ? FAKE_OBSERVE_SECRET : null);
    }
    expectNoForbiddenText(screen);
  });

  it("화면용 — 틀린 기간은 기본값(1시간)으로, 거절하지 않는다", async () => {
    const screen = await loadResourcesScreen({ range: "forever", server: "158" });
    expect(screen.window.range).toBe("1h");
    expect(screen.window.toMilliseconds - screen.window.fromMilliseconds).toBe(HOUR);
    expect(screen.selectedContainer).toBeNull();
  });

  it("화면용 — 고른 컨테이너를 주소에서 읽는다", async () => {
    const screen = await loadResourcesScreen({ range: "24h", server: "158", container: "front-app" });
    expect(screen.selectedContainer).toMatchObject({ server: "158", container: "front-app" });
    expect(fake.calls.some((call) => call.parameters.scope === "container" && call.parameters.name === "front-app")).toBe(true);
  });

  it("데이터 경로용 — 200 {success:true, data} · no-store · 요청 주소의 인자를 읽는다", async () => {
    const response = await resourcesScreenResponse(apiRequest("?range=30d&server=158&container=front-app"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const text = await response.text();
    expectNoForbiddenText(text);
    const body = JSON.parse(text) as { success: boolean; data: ResourcesScreen };
    expect(body.success).toBe(true);
    expect(body.data.window.range).toBe("30d");
    expect(body.data.selectedContainer).toMatchObject({ server: "158", container: "front-app" });
  });

  it("데이터 경로용 — 틀린 입력도 200(기본값으로)", async () => {
    const response = await resourcesScreenResponse(apiRequest("?range=1h&range=7d"));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: ResourcesScreen };
    expect(body.data.window.range).toBe("1h");
  });

  it("관측 서버 설정이 비면 호출 없이 not_configured", async () => {
    vi.stubEnv("OBSERVE_URL", "");
    const screen = await loadResourcesScreen({});
    expectFailure(screen.servers, "not_configured");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("칸의 실패는 앱 로그 1줄 — 이유와 상태 코드만(비밀값 · 주소 · 원문 없음)", async () => {
    fake.latest = () => textResponse(leakyErrorBody(), 503);
    const screen = await loadResourcesScreen({});
    expectFailure(screen.servers, "unavailable", 503);
    await vi.waitFor(() => expect(everythingLogged()).toContain("screen:resources cell=latest upstream=unavailable status=503"));
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

describe("소스 검사 — resources 의 server/ 는 server-only 이고 세션 검증을 직접 부른다", () => {
  const files = sourceFiles(join(FEATURE_DIRECTORY, "server"));

  it("server/ 에 진입 모듈이 있다", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${relative(SOURCE_DIRECTORY, file)} — "server-only" · requireSession · requireApiSession`, () => {
      const source = readFileSync(file, "utf8");
      expect(allImports(source)).toContain("server-only");
      expect(allImports(source)).toContain("@/features/auth/server/require-session");
      expect(source).toMatch(/\brequireSession\s*\(/);
      expect(source).toMatch(/\brequireApiSession\s*\(/);
    });
  }
});

describe("소스 검사 — resources 의 lib/ 는 순수(설정 · 환경 변수 · Next · server-only 를 읽지 않는다)", () => {
  const files = sourceFiles(join(FEATURE_DIRECTORY, "lib"));

  it("lib/ 파일을 찾는다(빈 검사로 통과하지 않는다)", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    it(relative(SOURCE_DIRECTORY, file), () => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/process\.env/);
      for (const module of allImports(source)) {
        expect(module).not.toBe("server-only");
        expect(module).not.toMatch(/^next(\/|$)/);
        expect(module).not.toBe("@/shared/config/server-config");
        expect(module).not.toMatch(/\/server\//);
      }
    });
  }

  it("새 의존성 없음 — 그래프 라이브러리를 임포트하지 않는다(상대 경로 · @/ · 기존 패키지만)", () => {
    const packageJson = JSON.parse(readFileSync(join(SOURCE_DIRECTORY, "..", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const known = new Set(Object.keys(packageJson.dependencies ?? {}));
    for (const file of [...files, ...sourceFiles(join(FEATURE_DIRECTORY, "server"))]) {
      for (const module of allImports(readFileSync(file, "utf8"))) {
        if (module.startsWith("@/") || module.startsWith(".") || module.startsWith("node:") || module === "server-only") continue;
        expect(known.has(module), `${file} → ${module}`).toBe(true);
      }
    }
  });
});
