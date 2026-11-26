/** 방문 기록 화면의 서버 쪽 진입 — 명세 §2 "어드민 조회는 로그인 뒤에만, 관측 서버는 비밀값 머리글로" · "주소 원문은 … 애플리케이션 로그 · 어드민 화면의 목록 ·
 * 요약 응답에는 싣지 않는다". 기존 화면의 인증 경계("다른 서버를 부르는 모든 서버 쪽 함수와 Route Handler 가 같은 세션 검증 함수를 직접 호출한다").
 * 세션이 없으면 관측 서버를 한 번도 부르지 않고 화면용은 /login, 데이터 경로용은 401. 전역 fetch 를 가짜로 바꾼다(실제 서버를 부르지 않는다).
 * 사이트의 공개 주소는 새 선택 설정 SITE_ORIGIN(없으면 링크 · 자기 사이트 빼기 없음 — 뜨는 것은 막지 않는다). */
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
import { loadVisitsScreen, visitsScreenResponse } from "@/features/visits/server/visits-screen";
import type { VisitsScreen } from "@/features/visits/lib/visits-screen";
import {
  FAKE_SITE_HOST, FAKE_SITE_ORIGIN, LEAKED_VALUES, createFakeObserveVisits, observeEnvelope, observeLeakySummary, type FakeObserveVisits,
} from "@/features/visits/lib/visit-summary-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  SECRET_HEADER_NAMES, createRoutedFetch, expectFailure, expectNoForbiddenText, headersOf, jsonBody, leakyErrorBody, okValue, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const SOURCE_DIRECTORY = fileURLToPath(new URL("../../..", import.meta.url));
const FEATURE_DIRECTORY = join(SOURCE_DIRECTORY, "features", "visits");
const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";

let fake: FakeObserveVisits;
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
  return new Request(new URL(`/api/visits${search}`, FAKE_ORIGIN), { method: "GET", headers: { origin: FAKE_ORIGIN } });
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
const streamWrites: string[] = [];

function everythingLogged(): string {
  return [...consoleSpies.flatMap((spy) => spy.mock.calls.flat()).map((part) => String(part)), ...streamWrites].join("\n");
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
  vi.stubEnv("SITE_ORIGIN", FAKE_SITE_ORIGIN);
  fake = createFakeObserveVisits();
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  setSessionCookie(undefined);
  consoleSpies.length = 0;
  streamWrites.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { streamWrites.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { streamWrites.push(String(chunk)); return true; });
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
      const thrown = await captureThrown(() => loadVisitsScreen({ days: "30" }));
      expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
      expect([`/login`, `${FAKE_ORIGIN}/login`]).toContain((thrown as InstanceType<typeof navigation.RedirectSignal>).location);
      expect(upstreamFetch).not.toHaveBeenCalled();
    });

    it(`데이터 경로용 · ${label} → 401, fetch 0회`, async () => {
      setSessionCookie(makeCookie());
      const response = await visitsScreenResponse(apiRequest("?days=30"));
      expect(response.status).toBe(401);
      expect(upstreamFetch).not.toHaveBeenCalled();
      const text = await response.text();
      expectNoForbiddenText(text);
      expect(JSON.parse(text)).not.toHaveProperty("data");
    });
  }
});

describe("세션이 있으면", () => {
  beforeEach(() => { validSession(); });

  it("화면용 — 주소의 days 로 관측 서버를 X-Observe-Secret 으로만 한 번 부른다", async () => {
    const screen = await loadVisitsScreen({ days: "30" });
    expect(screen.days).toBe(30);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(fake.calls.map((call) => [call.url.pathname, call.days])).toEqual([["/visits/summary", "30"]]);
    const [, init] = upstreamFetch.mock.calls[0];
    for (const name of SECRET_HEADER_NAMES) expect(headersOf(init).get(name)).toBe(name === "x-observe-secret" ? FAKE_OBSERVE_SECRET : null);
    expect(init?.redirect).toBe("manual");
    expect(okValue(screen.summary).daily).toHaveLength(30);
    expectNoForbiddenText(screen);
  });

  it.each<[string, Record<string, string | string[]>]>([["없음", {}], ["목록 밖", { days: "14" }], ["배열", { days: ["30", "90"] }], ["공백", { days: " 30" }]])(
    "화면용 — days %s → 7 로(관측 서버에 틀린 값을 보내지 않는다)", async (_label, input) => {
      const screen = await loadVisitsScreen(input);
      expect(screen.days).toBe(7);
      expect(fake.calls.map((call) => call.days)).toEqual(["7"]);
    });

  it("SITE_ORIGIN 으로 링크와 자기 사이트 빼기", async () => {
    const summary = okValue((await loadVisitsScreen({})).summary);
    expect(summary.topPaths.items[0].href).toBe(`${FAKE_SITE_ORIGIN}/wiki/01-N으로%20표현`);
    expect(summary.topReferrers.items.map((item) => item.host)).not.toContain(FAKE_SITE_HOST);
    expect(summary.siteInternal).toEqual({ state: "excluded", views: 300 });
  });

  it("SITE_ORIGIN 이 없거나 틀리면 링크 없음 · 빼지 않음(not_configured) — 요약은 그대로 보인다", async () => {
    for (const value of ["", "www.example.com", "https://www.example.com/wiki"]) {
      vi.stubEnv("SITE_ORIGIN", value);
      const summary = okValue((await loadVisitsScreen({})).summary);
      expect(summary.topPaths.items.every((item) => item.href === null)).toBe(true);
      expect(summary.topReferrers.items.map((item) => item.host)).toContain(FAKE_SITE_HOST);
      expect(summary.siteInternal).toEqual({ state: "not_configured" });
    }
  });

  it("데이터 경로용 — 200 {success:true, data} · no-store · 요청 주소의 인자를 읽는다", async () => {
    const response = await visitsScreenResponse(apiRequest("?days=90"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const text = await response.text();
    expectNoForbiddenText(text);
    const body = JSON.parse(text) as { success: boolean; data: VisitsScreen };
    expect(body.success).toBe(true);
    expect(body.data.days).toBe(90);
    expect(fake.calls.map((call) => call.days)).toEqual(["90"]);
  });

  it("데이터 경로용 — 틀린 입력도 200(기본값으로)", async () => {
    const response = await visitsScreenResponse(apiRequest("?days=30&days=90"));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: VisitsScreen };
    expect(body.data.days).toBe(7);
  });

  it("데이터 경로용 — 관측 서버가 ip · visitor 를 실어도 응답 본문에 없다(허용 목록)", async () => {
    fake.summary = () => jsonBody(observeEnvelope(observeLeakySummary()));
    const text = await (await visitsScreenResponse(apiRequest("?days=7"))).text();
    expectNoForbiddenText(text, LEAKED_VALUES);
    expect(text).not.toMatch(/"(ip|visitor|visitors_list|extra)"/);
  });

  it("관측 서버 설정이 비면 호출 없이 not_configured", async () => {
    vi.stubEnv("OBSERVE_URL", "");
    const screen = await loadVisitsScreen({});
    expectFailure(screen.summary, "not_configured");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("칸의 실패는 앱 로그 1줄 — 이유와 상태 코드만(비밀값 · 주소 · 원문 없음)", async () => {
    fake.summary = () => textResponse(leakyErrorBody(), 503);
    const screen = await loadVisitsScreen({});
    expectFailure(screen.summary, "unavailable", 503);
    await vi.waitFor(() => expect(everythingLogged()).toContain("screen:visits cell=summary upstream=unavailable status=503"));
    expectNoForbiddenText(everythingLogged());
  });

  it("성공한 조회는 방문 값을 로그에 남기지 않는다(경로 · 호스트 · 주소)", async () => {
    fake.summary = () => jsonBody(observeEnvelope(observeLeakySummary()));
    await loadVisitsScreen({});
    await visitsScreenResponse(apiRequest(""));
    const logged = everythingLogged();
    expectNoForbiddenText(logged, LEAKED_VALUES);
    expect(logged).not.toContain("N으로");
    expect(logged).not.toContain("www.google.com");
    expect(logged).not.toContain(FAKE_SITE_ORIGIN);
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

describe("소스 검사 — visits", () => {
  it("server/ · lib/ · ui/ 에 파일이 있다(빈 검사로 통과하지 않는다)", () => {
    expect(sourceFiles(join(FEATURE_DIRECTORY, "server")).length).toBeGreaterThan(0);
    expect(sourceFiles(join(FEATURE_DIRECTORY, "lib")).length).toBeGreaterThanOrEqual(4);
    expect(sourceFiles(join(FEATURE_DIRECTORY, "ui")).length).toBeGreaterThan(0);
  });

  it("새 의존성 없음 — 기존 패키지 · @/ · node: 만", () => {
    const packageJson = JSON.parse(readFileSync(join(SOURCE_DIRECTORY, "..", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const known = new Set(Object.keys(packageJson.dependencies ?? {}));
    for (const file of sourceFiles(FEATURE_DIRECTORY)) {
      for (const module of allImports(readFileSync(file, "utf8"))) {
        if (module.startsWith("@/") || module.startsWith(".") || module.startsWith("node:") || module === "server-only") continue;
        expect(known.has(module), `${relative(SOURCE_DIRECTORY, file)} → ${module}`).toBe(true);
      }
    }
  });

  it("ui/ 는 dangerouslySetInnerHTML 을 쓰지 않는다(방문자가 보낸 글자는 글자로만)", () => {
    for (const file of sourceFiles(join(FEATURE_DIRECTORY, "ui"))) {
      expect(readFileSync(file, "utf8"), relative(SOURCE_DIRECTORY, file)).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});
