/** 로그인 폼 — 비밀번호 보이기/가리기 버튼. 기본은 가림, 버튼은 제출하지 않고(type=button), 접근성 이름·눌림 상태를 가진다. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LoginForm, passwordVisibilityView } from "@/features/auth/ui/LoginForm";

async function renderLoginForm(): Promise<string> {
  // @types/react-dom 을 더하지 않으려고 이름을 변수로 둔다(기존 화면 테스트와 같은 방식)
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(<LoginForm />);
}

function findTag(markup: string, pattern: RegExp): string {
  const match = markup.match(pattern);
  expect(match, `태그를 찾지 못함: ${pattern}`).not.toBeNull();
  return match![0];
}

describe("비밀번호 보이기/가리기 — 상태별 꼴", () => {
  it("가린 상태: 입력 칸은 password, 버튼 이름은 '비밀번호 보이기'", () => {
    expect(passwordVisibilityView(false)).toEqual({ inputType: "password", toggleLabel: "비밀번호 보이기" });
  });

  it("보인 상태: 입력 칸은 text, 버튼 이름은 '비밀번호 가리기'", () => {
    expect(passwordVisibilityView(true)).toEqual({ inputType: "text", toggleLabel: "비밀번호 가리기" });
  });
});

describe("비밀번호 보이기/가리기 — 첫 렌더", () => {
  it("기본은 가림이고 입력 칸의 name·autocomplete 는 그대로다", async () => {
    const passwordInput = findTag(await renderLoginForm(), /<input[^>]*name="password"[^>]*>/);
    expect(passwordInput).toContain('type="password"');
    expect(passwordInput).toContain('autoComplete="current-password"');
  });

  it("토글 버튼은 type=button 이고 aria-label·aria-pressed=false 를 가진다", async () => {
    const toggleButton = findTag(await renderLoginForm(), /<button[^>]*aria-label="비밀번호 보이기"[^>]*>/);
    expect(toggleButton).toContain('type="button"');
    expect(toggleButton).toContain('aria-pressed="false"');
  });

  it("제출 버튼은 하나뿐이다(토글이 제출 버튼이 아니다)", async () => {
    const submitButtons = (await renderLoginForm()).match(/<button[^>]*type="submit"[^>]*>/g) ?? [];
    expect(submitButtons).toHaveLength(1);
  });

  it("아이콘은 인라인 SVG 이고 스크린리더에서 숨긴다", async () => {
    const icon = findTag(await renderLoginForm(), /<svg[^>]*>/);
    expect(icon).toContain('aria-hidden="true"');
  });
});

describe("비밀번호 보이기/가리기 — 소스 고정", () => {
  const source = readFileSync(fileURLToPath(new URL("./LoginForm.tsx", import.meta.url)), "utf8");

  it("버튼을 누르면 상태를 뒤집는다", () => {
    expect(source).toContain("onClick={() => setPasswordVisible((visible) => !visible)}");
  });

  it("상태를 저장하지 않고 값을 내보내지 않는다", () => {
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\.|data-password/);
  });
});
