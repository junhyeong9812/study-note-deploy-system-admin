/** 세부 4 — "임시 제한 중"은 로그인 화면과 로그인 뒤 화면(홈) 모두에 보인다. 서버 쪽 상태 함수의 값을 바꿔 가며 실제로 렌더한다. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ active: false, cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({
  isTemporaryRestrictionActive: () => state.active,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookieValue !== undefined && name === "admin_session" ? { name, value: state.cookieValue } : undefined),
    has: () => state.cookieValue !== undefined,
    getAll: () => [],
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (location: string) => { throw new Error(`redirect:${location}`); },
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

import HomePage from "@/app/page";
import LoginPage from "@/app/login/page";
import { SESSION_COOKIE_NAME, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";

const NOTICE_WORDS = "임시 제한 중";
const pageProps = { params: Promise.resolve({}), searchParams: Promise.resolve({}) };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  state.active = false;
  state.cookieValue = undefined;
  expect(SESSION_COOKIE_NAME).toBe("admin_session");
});

async function renderPage(page: (props: typeof pageProps) => unknown): Promise<string> {
  const element = await page(pageProps);
  // @types/react-dom 을 더하지 않으려고 이름을 변수로 둔다(타입 검사 밖 — 런타임은 react-dom 의 node 서버 렌더러)
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

describe("홈(로그인 뒤)", () => {
  it("임시 제한 중이면 표시가 있다", async () => {
    state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
    state.active = true;
    expect(await renderPage(HomePage)).toContain(NOTICE_WORDS);
  });

  it("아니면 표시가 없다", async () => {
    state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
    state.active = false;
    expect(await renderPage(HomePage)).not.toContain(NOTICE_WORDS);
  });
});

describe("로그인 화면", () => {
  it("임시 제한 중이면 로그인 전에도 표시가 있다", async () => {
    state.active = true;
    expect(await renderPage(LoginPage)).toContain(NOTICE_WORDS);
  });

  it("아니면 표시가 없다", async () => {
    state.active = false;
    expect(await renderPage(LoginPage)).not.toContain(NOTICE_WORDS);
  });
});
