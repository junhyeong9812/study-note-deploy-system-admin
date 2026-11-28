/** 소스 검사(T8) — 이 어드민에서 브라우저 스크립트는 지도의 한 조각(ui/TrafficMapLive.tsx)뿐이다(명세 2절 — 묶음 검사를 이 화면에 한해 넓힌다).
 * 그 조각은 서버 모듈 · 다른 서버의 클라이언트 · 설정 · 환경 변수 · 비밀값 머리글 이름을 가져오지 않는다(브라우저로 가는 코드에 주소 · 비밀값이 들지 않게).
 * 브라우저는 관측 서버를 직접 부르지 않는다 — 조각은 같은 출처의 중계 경로(/api/traffic/stream)만 연다. 새 의존성 없음. 화면 · 중계 경로 파일이 있다. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_DIRECTORY = fileURLToPath(new URL("../..", import.meta.url));
const FEATURE_DIRECTORY = join(SOURCE_DIRECTORY, "features", "traffic-map");
const LIVE_FILE = join(FEATURE_DIRECTORY, "ui", "TrafficMapLive.tsx");

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

/** 값 임포트(타입만 가져오는 `import type` 은 뺀다 — 번들에 들지 않는다)와 동적 임포트의 모듈 이름. */
function valueImports(source: string): string[] {
  const modules: string[] = [];
  for (const match of source.matchAll(/^\s*import\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/gm)) modules.push(match[2]);
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) modules.push(match[1]);
  for (const match of source.matchAll(/^\s*export\s+(?!type\b)[^;]*?\s+from\s+["']([^"']+)["']/gm)) modules.push(match[1]);
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) modules.push(match[1]);
  return modules;
}

/** 모듈이 값으로 가져오는 것을 따라가며(같은 저장소의 @/ 만) 닿는 파일 전부 — 브라우저 번들에 드는 것. */
function reachableFiles(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const module of valueImports(readFileSync(file, "utf8"))) {
      if (!module.startsWith("@/")) continue;
      const base = join(SOURCE_DIRECTORY, module.slice(2));
      const found = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((candidate) => existsSync(candidate));
      if (found !== undefined) queue.push(found);
    }
  }
  return [...seen];
}

describe("브라우저 스크립트는 지도의 한 조각뿐", () => {
  it("\"use client\" 는 ui/TrafficMapLive.tsx 하나 — 이 기능의 다른 파일 · 화면 · 중계 경로에는 없다", () => {
    const files = [...sourceFiles(FEATURE_DIRECTORY), ...sourceFiles(join(SOURCE_DIRECTORY, "app", "traffic")), ...sourceFiles(join(SOURCE_DIRECTORY, "app", "api", "traffic"))];
    const clients = files.filter((file) => /^\s*["']use client["']/m.test(readFileSync(file, "utf8")));
    expect(clients.map((file) => relative(SOURCE_DIRECTORY, file))).toEqual(["features/traffic-map/ui/TrafficMapLive.tsx"]);
  });

  it("어드민 전체에서 \"use client\" 는 로그인 폼 · 로그아웃 단추 · 지도의 조각 셋뿐", () => {
    const clients = sourceFiles(SOURCE_DIRECTORY).filter((file) => /^\s*["']use client["']/m.test(readFileSync(file, "utf8")))
      .map((file) => relative(SOURCE_DIRECTORY, file)).sort();
    expect(clients).toEqual(["features/auth/ui/LoginForm.tsx", "features/auth/ui/LogoutButton.tsx", "features/traffic-map/ui/TrafficMapLive.tsx"]);
  });

  it("그 조각이 값으로 닿는 모든 파일에 서버 모듈 · 다른 서버의 클라이언트 · 설정 · 환경 변수 · 로거 · 비밀값 머리글 이름이 없다", () => {
    const files = reachableFiles(LIVE_FILE);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const name = relative(SOURCE_DIRECTORY, file);
      expect(source, name).not.toMatch(/process\.env/);
      expect(source, name).not.toMatch(/X-Observe-Secret|OBSERVE_URL|OBSERVE_SECRET/);
      for (const module of valueImports(source)) {
        expect(module, `${name} → ${module}`).not.toMatch(/\/server\/|^server-only$|^next\/headers$|-client$|server-config|shared\/lib\/logger|ioredis|node:/);
      }
    }
  });

  it("그 조각은 같은 출처의 중계 경로만 연다 — 다른 서버의 주소 · fetch 없음", () => {
    // 주석은 뺀다(주석의 보기 주소는 번들에 들지 않는다)
    const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const files = reachableFiles(LIVE_FILE).map((file) => withoutComments(readFileSync(file, "utf8"))).join("\n");
    expect(files).toContain("/api/traffic/stream");
    expect(files).not.toMatch(/https?:\/\//);
    expect(files).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("파일 · 의존성", () => {
  it("화면 · 중계 경로 파일이 있다", () => {
    expect(existsSync(join(SOURCE_DIRECTORY, "app", "traffic", "page.tsx"))).toBe(true);
    expect(existsSync(join(SOURCE_DIRECTORY, "app", "api", "traffic", "stream", "route.ts"))).toBe(true);
  });

  it("새 의존성 없음 — package.json 의 것 · @/ · 상대 경로 · node: 만(그림 라이브러리 없이 SVG 를 직접)", () => {
    const packageJson = JSON.parse(readFileSync(join(SOURCE_DIRECTORY, "..", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const known = new Set(Object.keys(packageJson.dependencies ?? {}));
    for (const file of sourceFiles(FEATURE_DIRECTORY)) {
      for (const module of allImports(readFileSync(file, "utf8"))) {
        if (module.startsWith("@/") || module.startsWith(".") || module.startsWith("node:") || module === "server-only") continue;
        expect(known.has(module) || module === "react" || module.startsWith("react/"), `${file} → ${module}`).toBe(true);
      }
    }
  });
});
