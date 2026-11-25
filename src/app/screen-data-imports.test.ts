/** 소스 검사 — 기존 전수 검사(middleware.test · protected-routes.test · auth-boundary.test)가 덮지 못하는 길을 막는다.
 * protected-routes.test 는 화면이 세션 없을 때 /login 으로 보내는지만 본다 — 화면이 requireSession 을 부른 뒤 lib 클라이언트를 직접 만들어
 * 다른 서버를 부르면(진입 함수를 거치지 않으면) 통과해 버린다. 명세 ② 세부 "다른 서버를 부르는 모든 서버 쪽 함수 … 가 같은 세션 검증 함수를 직접 호출"
 * 을 지키려면 src/app 은 화면 넷의 다른 서버 호출을 **server/ 진입 함수로만** 해야 한다. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_DIRECTORY, routesFromAppDirectory } from "@/features/auth/lib/test-fakes";

const SOURCE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const SCREEN_FEATURES = ["deploys", "logs", "status", "login-attempts", "resources", "deploy-versions", "deploy-redeploy"] as const;

/** 화면 경로 → 그 화면이 써야 하는 진입 모듈(경로가 생기면 검사가 켜진다). */
const SCREEN_ENTRY_MODULES: Record<string, string> = {
  "/deploys": "@/features/deploys/server/",
  "/logs": "@/features/logs/server/",
  "/status": "@/features/status/server/",
  "/login-attempts": "@/features/login-attempts/server/",
  "/resources": "@/features/resources/server/",
  "/deploys/versions": "@/features/deploy-versions/server/",
  "/deploys/redeploy": "@/features/deploy-redeploy/server/",
};

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

/** 값 임포트(타입만 가져오는 `import type` 은 뺀다)와 동적 임포트의 모듈 이름. */
function valueImports(source: string): string[] {
  const modules: string[] = [];
  for (const match of source.matchAll(/^\s*import\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/gm)) modules.push(match[2]);
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) modules.push(match[1]);
  for (const match of source.matchAll(/^\s*export\s+(?!type\b)[^;]*?\s+from\s+["']([^"']+)["']/gm)) modules.push(match[1]);
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) modules.push(match[1]);
  return modules;
}

function allImports(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("검사 도구 자체", () => {
  it("값 임포트와 타입 임포트를 가른다", () => {
    const source = [
      `import { a } from "@/features/logs/lib/log-client";`,
      `import type { b } from "@/features/logs/lib/log-query";`,
      `import "server-only";`,
      `const c = await import("@/features/status/lib/status-overview");`,
    ].join("\n");
    expect(valueImports(source)).toEqual(["@/features/logs/lib/log-client", "server-only", "@/features/status/lib/status-overview"]);
  });

  it("src/app 에서 검사할 파일을 찾는다(빈 검사로 통과하지 않는다)", () => {
    expect(sourceFiles(APP_DIRECTORY).length).toBeGreaterThan(0);
  });
});

describe("src/app 은 화면 넷의 lib 를 값으로 임포트하지 않는다(server/ 진입 함수 · ui/ 만)", () => {
  const appFiles = sourceFiles(APP_DIRECTORY);
  for (const file of appFiles) {
    it(relative(SOURCE_DIRECTORY, file), () => {
      const source = readFileSync(file, "utf8");
      for (const module of valueImports(source)) {
        for (const feature of SCREEN_FEATURES) {
          if (!module.startsWith(`@/features/${feature}/`)) continue;
          expect(module, `${file} → ${module}`).toMatch(new RegExp(`^@/features/${feature}/(server|ui)/`));
        }
      }
      // 화면 넷의 클라이언트 · 수집 함수 이름을 src/app 에서 부르지 않는다
      expect(source).not.toMatch(/\bcreate(DeployHistory|Log|LoginAttempts)Client\b|\bcollectStatusOverview\b/);
      // 다른 서버 호출은 src/app 이 아니라 기능의 server/ 를 거친다
      expect(source).not.toMatch(/\bfetch\s*\(/);
    });
  }
});

describe("화면 넷의 server/ 진입 모듈 — server-only 이고 세션 검증을 부른다", () => {
  for (const feature of SCREEN_FEATURES) {
    const files = sourceFiles(join(SOURCE_DIRECTORY, "features", feature, "server"));

    it(`${feature}/server 에 진입 모듈이 있다`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
      it(`${relative(SOURCE_DIRECTORY, file)} — "server-only" · requireSession · requireApiSession`, () => {
        const source = readFileSync(file, "utf8");
        expect(valueImports(source)).toContain("server-only");
        expect(source).toMatch(/\brequireSession\s*\(/);
        expect(source).toMatch(/\brequireApiSession\s*\(/);
        expect(valueImports(source)).toContain("@/features/auth/server/require-session");
      });
    }
  }
});

describe("화면 넷의 lib/ — 순수(설정 · 환경 변수 · Next · server-only 를 읽지 않는다)", () => {
  for (const feature of SCREEN_FEATURES) {
    for (const file of sourceFiles(join(SOURCE_DIRECTORY, "features", feature, "lib"))) {
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
  }
});

describe("화면 넷의 ui/ — 브라우저로 가는 코드는 진입 함수 · 클라이언트 · 설정을 임포트하지 않는다", () => {
  it("ui/ 파일 목록을 읽는다(지금은 0개여도 된다 — 화면 task 에서 생기면 아래 사례가 켜진다)", () => {
    const count = SCREEN_FEATURES.flatMap((feature) => sourceFiles(join(SOURCE_DIRECTORY, "features", feature, "ui"))).length;
    expect(count).toBeGreaterThanOrEqual(0);
  });
  for (const feature of SCREEN_FEATURES) {
    for (const file of sourceFiles(join(SOURCE_DIRECTORY, "features", feature, "ui"))) {
      it(relative(SOURCE_DIRECTORY, file), () => {
        const source = readFileSync(file, "utf8");
        for (const module of valueImports(source)) {
          expect(module).not.toMatch(/\/server\//);
          expect(module).not.toMatch(/-client$/);
          expect(module).not.toBe("@/shared/config/server-config");
        }
        expect(source).not.toMatch(/process\.env/);
      });
    }
  }
});

describe("화면 경로가 생기면 그 기능의 server/ 진입 모듈을 쓴다", () => {
  const routes = routesFromAppDirectory();
  for (const [path, entryModule] of Object.entries(SCREEN_ENTRY_MODULES)) {
    const pages = routes.filter((route) => route.kind === "page" && route.path === path);
    const handlers = routes.filter((route) => route.kind === "route" && route.path === `/api${path}`);
    for (const route of [...pages, ...handlers]) {
      it(`${route.kind} ${route.path} → ${entryModule}`, () => {
        const imports = valueImports(readFileSync(route.file, "utf8"));
        expect(imports.some((module) => module.startsWith(entryModule)), `${route.file}`).toBe(true);
      });
    }
  }

  it("검사 대상 경로 이름은 middleware.test 의 새 경로 목록 · auth-boundary.test 의 기본 거절 목록과 같은 낱말이다", () => {
    const middlewareTest = readFileSync(join(SOURCE_DIRECTORY, "middleware.test.ts"), "utf8");
    const boundaryTest = readFileSync(join(SOURCE_DIRECTORY, "features", "auth", "lib", "auth-boundary.test.ts"), "utf8");
    for (const path of Object.keys(SCREEN_ENTRY_MODULES)) expect(boundaryTest).toContain(`"${path}"`);
    expect(middlewareTest).toContain(`"/deploys"`);
  });
});
