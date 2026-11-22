/** 세부 2 — 보호 화면 · 보호 Route Handler 가 세션 검증을 직접 부른다(middleware 와 두 겹 — 하나가 빠져도 막힌다).
 * next/headers · next/navigation 을 대체하고 src/app 의 page · route 를 전수로 직접 호출한다. */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (location: string) => { throw new navigation.RedirectSignal(location); },
  permanentRedirect: (location: string) => { throw new navigation.RedirectSignal(location); },
  notFound: () => { throw new Error("notFound"); },
}));

import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY, PUBLIC_ROUTE_PATHS, routesFromAppDirectory } from "@/features/auth/lib/test-fakes";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";

const protectedRoutes = routesFromAppDirectory().filter((route) => !PUBLIC_ROUTE_PATHS.has(route.path));
const protectedPages = protectedRoutes.filter((route) => route.kind === "page");
const protectedHandlers = protectedRoutes.filter((route) => route.kind === "route");

const invalidSessions: [string, () => string | undefined][] = [
  ["쿠키 없음", () => undefined],
  ["잘못된 서명", () => issueSessionToken(OTHER_KEY, Date.now())],
  ["만료", () => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
];

function setSessionCookie(value: string | undefined) {
  navigation.cookieValues.clear();
  if (value !== undefined) navigation.cookieValues.set(SESSION_COOKIE_NAME, value);
}

const pageProps = { params: Promise.resolve({ "sample-segment": "sample-segment" }), searchParams: Promise.resolve({}) };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  setSessionCookie(undefined);
});

describe("보호 경로 목록", () => {
  it("보호 화면과 보호 Route Handler 를 하나 이상 찾는다", () => {
    expect(protectedPages.length).toBeGreaterThan(0);
    expect(protectedHandlers.length).toBeGreaterThan(0);
  });
});

describe("보호 화면(page) — 세션이 없으면 middleware 없이도 로그인으로 보낸다", () => {
  for (const page of protectedPages) {
    for (const [label, makeCookie] of invalidSessions) {
      it(`${page.path} · ${label} → redirect /login`, async () => {
        setSessionCookie(makeCookie());
        const module = await import(/* @vite-ignore */ page.file);
        let thrown: unknown = null;
        try {
          await module.default(pageProps);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
        expect((thrown as InstanceType<typeof navigation.RedirectSignal>).location).toBe("/login");
      });
    }

    it(`${page.path} · 유효한 세션 → 로그인으로 보내지 않는다`, async () => {
      setSessionCookie(issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
      const module = await import(/* @vite-ignore */ page.file);
      let thrown: unknown = null;
      try {
        await module.default(pageProps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeInstanceOf(navigation.RedirectSignal);
    });
  }
});

describe("보호 Route Handler — 세션이 없으면 middleware 없이도 401(같은 출처 요청이어도)", () => {
  for (const handler of protectedHandlers) {
    for (const method of HTTP_METHODS) {
      for (const [label, makeCookie] of invalidSessions) {
        it(`${method} ${handler.path} · ${label} → 401, 데이터·Set-Cookie 없음`, async () => {
          const module = await import(/* @vite-ignore */ handler.file);
          if (typeof module[method] !== "function") return;   // 이 메서드를 내보내지 않는 경로 — Next 가 405
          setSessionCookie(makeCookie());
          const request = new Request(new URL(handler.path, FAKE_ORIGIN), {
            method,
            headers: { origin: FAKE_ORIGIN, "content-type": "application/json" },
            body: method === "GET" ? undefined : "{}",
          });
          const response: Response = await module[method](request, { params: Promise.resolve({}) });
          expect(response.status).toBe(401);
          expect(response.headers.get("set-cookie")).toBeNull();
          const body = await response.json();
          expect(body.success).toBe(false);
          expect(body).not.toHaveProperty("data");
        });
      }
    }
  }

  it("보호 Route Handler 는 HTTP 메서드를 하나 이상 내보낸다(위 사례가 빈 검사가 아니다)", async () => {
    for (const handler of protectedHandlers) {
      const module = await import(/* @vite-ignore */ handler.file);
      expect(HTTP_METHODS.some((method) => typeof module[method] === "function"), handler.path).toBe(true);
    }
  });
});
