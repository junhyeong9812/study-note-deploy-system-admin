/** 세부 2 — 인증 경계의 배선: middleware 를 직접 불러 src/app 의 보호 경로 전수 + 임의의 새 경로를 고정한다. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY, PUBLIC_ROUTE_PATHS, routesFromAppDirectory } from "@/features/auth/lib/test-fakes";
import { config, middleware } from "@/middleware";

const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";
const NEW_PATHS = ["/brand-new-screen-7f3a", "/deploys", "/logs/2026", "/api/brand-new-data-7f3a", "/api/deploys", "/api/auth/logout", "/api/health/dependencies"];

const protectedPaths = (() => {
  const fromApp = routesFromAppDirectory().map((route) => route.path).filter((path) => !PUBLIC_ROUTE_PATHS.has(path));
  return [...new Set([...fromApp, ...NEW_PATHS])];
})();

/** 앱이 실제로 받는 요청은 nginx 뒤의 내부 주소다 — 기본 요청 주소를 설정값(ADMIN_ORIGIN)과 다르게 둔다. */
const INTERNAL_REQUEST_BASE = "http://localhost:18000";
const EXPECTED_LOGIN_LOCATION = `${FAKE_ORIGIN}/login`;   // 세부 3(정정): <ADMIN_ORIGIN>/login, 요청 Host 와 무관

function request(pathname: string, cookieValue?: string, requestBase: string = INTERNAL_REQUEST_BASE): NextRequest {
  const headers = new Headers({ host: new URL(requestBase).host });
  if (cookieValue !== undefined) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
  return new NextRequest(new URL(pathname, requestBase), { headers });
}

const invalidCookies: [string, () => string | undefined][] = [
  ["쿠키 없음", () => undefined],
  ["빈 쿠키", () => ""],
  ["잘못된 서명(다른 키)", () => issueSessionToken(OTHER_KEY, Date.now())],
  ["변조", () => { const token = issueSessionToken(FAKE_SIGNING_KEY, Date.now()); return `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`; }],
  ["만료(12시간 지남)", () => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
  ["형식 오류", () => "not-a-session"],
];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
});

describe("middleware — 경로 목록", () => {
  it("src/app 에서 보호 경로를 하나 이상 찾는다(빈 검사로 통과하지 않는다)", () => {
    expect(routesFromAppDirectory().some((route) => !PUBLIC_ROUTE_PATHS.has(route.path))).toBe(true);
  });

  it("config.matcher 가 없다 — 어떤 경로도 middleware 를 건너뛰지 않는다", () => {
    expect((config as Record<string, unknown>).matcher).toBeUndefined();
  });
});

describe("middleware — 세션이 없거나 무효면 막는다(보호 경로 전수 × 무효 쿠키)", () => {
  for (const pathname of protectedPaths) {
    for (const [label, makeCookie] of invalidCookies) {
      it(`${pathname} · ${label}`, async () => {
        const response = await middleware(request(pathname, makeCookie()));
        expect(response.headers.get("x-middleware-next")).toBeNull();
        expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
        const bodyText = await response.text();
        if (pathname.startsWith("/api/")) {
          expect(response.status).toBe(401);
          const body = JSON.parse(bodyText);
          expect(body.success).toBe(false);
          expect(body).not.toHaveProperty("data");
        } else {
          expect([302, 303, 307, 308]).toContain(response.status);
          // 세부 3(정정): 설정값 기준 <ADMIN_ORIGIN>/login 을 글자 그대로 — 요청 주소(localhost:18000)에서 만들지 않는다
          expect(response.headers.get("location")).toBe(EXPECTED_LOGIN_LOCATION);
          expect(bodyText).toBe("");
        }
      });
    }
  }
});

describe("middleware — 유효한 세션이면 통과", () => {
  it.each(protectedPaths)("%s · 유효한 쿠키 → 통과 + Cache-Control: no-store", async (pathname) => {
    const response = await middleware(request(pathname, issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000)));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
  });

  it("서명 키 설정이 비면 유효해 보이는 쿠키도 막힌다", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    const response = await middleware(request("/api/deploys", issueSessionToken(FAKE_SIGNING_KEY, Date.now())));
    expect(response.status).toBe(401);
  });
});

describe("middleware — 허용 목록은 세션 없이 통과", () => {
  it.each(["/login", "/api/auth/login", "/api/health", "/_next/static/chunks/main-abc123.js"])("%s", async (pathname) => {
    const response = await middleware(request(pathname));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("세부 3(정정) — 로그인 이동 주소는 요청 Host · nextUrl 과 무관하게 <ADMIN_ORIGIN>/login", () => {
  const pagePaths = protectedPaths.filter((pathname) => !pathname.startsWith("/api/"));
  const requestBases = ["https://evil.example.test", "http://localhost:18000", "http://admin-green:3000", FAKE_ORIGIN];

  it("화면 경로를 하나 이상 검사한다", () => {
    expect(pagePaths.length).toBeGreaterThan(0);
  });

  for (const pathname of pagePaths) {
    it.each(requestBases)(`${pathname} · 요청 주소 %s → Location 은 언제나 ${EXPECTED_LOGIN_LOCATION}`, async (requestBase) => {
      const response = await middleware(request(pathname, undefined, requestBase));
      expect(response.headers.get("location")).toBe(EXPECTED_LOGIN_LOCATION);
    });
  }

  it("Host 헤더만 다른 값으로 바꿔도 같다", async () => {
    const headers = new Headers({ host: "evil.example.test", "x-forwarded-host": "evil.example.test" });
    const response = await middleware(new NextRequest(new URL("/", INTERNAL_REQUEST_BASE), { headers }));
    expect(response.headers.get("location")).toBe(EXPECTED_LOGIN_LOCATION);
  });

  it("ADMIN_ORIGIN 이 바뀌면 그 값을 따른다(설정값 기준)", async () => {
    vi.stubEnv("ADMIN_ORIGIN", "https://admin-other.example.test");
    const response = await middleware(request("/", undefined, "https://evil.example.test"));
    expect(response.headers.get("location")).toBe("https://admin-other.example.test/login");
  });
});
