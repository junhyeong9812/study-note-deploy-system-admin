/** 소스 검사 — 문제 화면 기능의 층 경계(app/screen-data-imports.test.ts 의 규칙을 이 기능에 그대로):
 * lib/ 는 순수(설정 · 환경 변수 · Next · server-only · server/ 를 읽지 않는다) · ui/ 는 진입 함수 · 클라이언트 · 설정을 임포트하지 않고 브라우저 스크립트가 없다
 * ("use client" 없음 — 읽기 전용 화면) · server/ 는 server-only 이고 세션 검증을 직접 부른다 · 새 조회 클라이언트를 만들지 않는다(fetch 를 직접 부르지 않는다). */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FEATURE_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));

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

function valueImports(source: string): string[] {
  const modules: string[] = [];
  for (const match of source.matchAll(/^\s*import\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/gm)) modules.push(match[2]);
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) modules.push(match[1]);
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) modules.push(match[1]);
  return modules;
}

function allImports(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("incidents/lib — 순수", () => {
  const files = sourceFiles(join(FEATURE_DIRECTORY, "lib"));
  it("파일을 찾는다(빈 검사가 아니다)", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    it(relative(FEATURE_DIRECTORY, file), () => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/process\.env/);
      expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);   // 전역 fetch 를 부르지 않는다 — 다른 서버는 기존 클라이언트로만(options.fetch 를 넘길 뿐)
      for (const module of allImports(source)) {
        expect(module).not.toBe("server-only");
        expect(module).not.toMatch(/^next(\/|$)/);
        expect(module).not.toBe("@/shared/config/server-config");
        expect(module).not.toMatch(/\/server\//);
      }
    });
  }
});

describe("incidents/ui — 브라우저 스크립트 없음 · 서버 모듈 · 클라이언트 · 설정을 값으로 임포트하지 않음", () => {
  const files = sourceFiles(join(FEATURE_DIRECTORY, "ui"));
  it("파일을 찾는다", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    it(relative(FEATURE_DIRECTORY, file), () => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/^\s*["']use client["']/m);
      for (const module of valueImports(source)) {
        expect(module).not.toMatch(/\/server\//);
        expect(module).not.toMatch(/-client$/);
        expect(module).not.toBe("@/shared/config/server-config");
      }
      expect(source).not.toMatch(/process\.env/);
      expect(source).not.toMatch(/<form\b|<button\b|<input\b|<script\b|dangerouslySetInnerHTML/);
    });
  }
});

describe("incidents/server — server-only · 세션 검증을 직접", () => {
  const files = sourceFiles(join(FEATURE_DIRECTORY, "server"));
  it("진입 모듈이 있다", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    it(relative(FEATURE_DIRECTORY, file), () => {
      const source = readFileSync(file, "utf8");
      expect(valueImports(source)).toContain("server-only");
      expect(valueImports(source)).toContain("@/features/auth/server/require-session");
      expect(source).toMatch(/\brequireSession\s*\(/);
      expect(source).toMatch(/\brequireApiSession\s*\(/);
    });
  }
});
