import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOGIN_PATH, classifyPath, unauthenticatedAction } from "@/features/auth/lib/auth-boundary";

const APP_DIRECTORY = fileURLToPath(new URL("../../../app", import.meta.url));

/** src/app 의 page.tsx · route.ts 에서 경로를 뽑는다. (그룹)은 지우고 [동적]은 견본 값으로 바꾼다. */
function routesFromAppDirectory(): { path: string; kind: "page" | "route" }[] {
  if (!existsSync(APP_DIRECTORY)) return [];
  const routes: { path: string; kind: "page" | "route" }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) { walk(fullPath); continue; }
      const match = /^(page|route)\.(tsx|ts|jsx|js)$/.exec(entry);
      if (!match) continue;
      const segments = relative(APP_DIRECTORY, directory).split(sep).filter(Boolean)
        .filter((segment) => !/^\(.*\)$/.test(segment))
        .map((segment) => (/^\[.*\]$/.test(segment) ? "sample-segment" : segment));
      routes.push({ path: `/${segments.join("/")}`, kind: match[1] as "page" | "route" });
    }
  };
  walk(APP_DIRECTORY);
  return routes;
}

describe("classifyPath — 허용 목록", () => {
  it.each(["/login", "/api/auth/login", "/api/health", "/favicon.ico", "/_next/static/chunks/main-abc123.js", "/_next/static/css/app.css"])(
    "%s → public", (pathname) => {
      expect(classifyPath(pathname)).toBe("public");
    });
});

describe("classifyPath — 기본 거절(허용 목록에 없는 모든 경로)", () => {
  it.each([
    "/", "/deploys", "/logs", "/status", "/login-attempts",
    "/api/auth/logout", "/api/deploys", "/api/logs", "/api/status", "/api/login-attempts",
    // 허용 경로와 비슷한 이름
    "/loginx", "/login/", "/login/extra", "/Login", "/api/auth/login/extra", "/api/auth/loginx",
    "/api/health/dependencies", "/api/healthz", "/api/HEALTH", "/favicon.ico.map",
    "/_next/data/build-id/page.json", "/_next/image", "/_next/static", "/_next/staticx/a.js",
    // 접두 장난
    "/api/health/../deploys", "//api/deploys", "/%2e%2e/api/deploys",
    // 임의의 새 경로
    "/brand-new-screen-7f3a", "/api/brand-new-data-7f3a", "/zzz/yyy/xxx", "",
  ])("%j → session_required", (pathname) => {
    expect(classifyPath(pathname)).toBe("session_required");
  });
});

describe("unauthenticatedAction", () => {
  it.each(["/", "/deploys", "/brand-new-screen-7f3a", "/apiish"])("화면 %s → 로그인으로 이동", (pathname) => {
    expect(unauthenticatedAction(pathname)).toEqual({ kind: "redirect", location: LOGIN_PATH });
  });

  it.each(["/api/deploys", "/api/auth/logout", "/api/brand-new-data-7f3a", "/api/"])("데이터 %s → 401", (pathname) => {
    expect(unauthenticatedAction(pathname)).toEqual({ kind: "unauthorized", status: 401 });
  });
});

describe("src/app 의 실제 경로 전수", () => {
  const routes = routesFromAppDirectory();
  const publicPaths = new Set(["/login", "/api/auth/login", "/api/health"]);

  it("허용 목록 밖의 모든 page · route 는 session_required", () => {
    expect(routes.length).toBeGreaterThan(0);   // 경로를 하나도 못 찾으면 빈 검사로 통과하지 않는다
    for (const route of routes) {
      if (publicPaths.has(route.path)) continue;
      expect(classifyPath(route.path), route.path).toBe("session_required");
    }
  });

  it("허용 목록에 있는 경로는 실제로 있고, 그 밖의 public 판정 경로는 없다", () => {
    const paths = new Set(routes.map((route) => route.path));
    expect(paths.has("/login")).toBe(true);
    expect(paths.has("/api/auth/login")).toBe(true);
    expect(paths.has("/api/health")).toBe(true);
    expect(paths.has("/api/auth/logout")).toBe(true);
    const unexpectedPublic = routes.filter((route) => !publicPaths.has(route.path) && classifyPath(route.path) === "public");
    expect(unexpectedPublic).toEqual([]);
  });

  it("데이터 경로(route.ts)는 /api/ 아래에만 있다(세션 없음 → 401 규칙이 닿게)", () => {
    expect(routes.some((entry) => entry.kind === "route")).toBe(true);
    for (const route of routes.filter((entry) => entry.kind === "route")) {
      expect(route.path.startsWith("/api/"), route.path).toBe(true);
    }
  });
});
