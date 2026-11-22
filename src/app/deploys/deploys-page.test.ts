/** 배포 이력 화면 — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 master)를 거쳐 표 · 서비스 선택 · 빈 목록 ·
 * 다른 서버 실패 · 잘못된 입력 · 임시 제한 표시 · 내비게이션("준비 중")을 본다. 비밀값 · master 주소 · 원문은 HTML 에 없다. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ restricted: false, cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => state.restricted }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookieValue !== undefined && name === "admin_session" ? { name, value: state.cookieValue } : undefined),
    has: () => state.cookieValue !== undefined,
    getAll: () => [],
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import DeploysPage from "@/app/deploys/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, UPSTREAM_RAW_MARKER, createRoutedFetch, expectNoForbiddenText, jsonBody, leakyErrorBody,
  leakyNetworkError, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const ROWS = [
  { request_id: "0f8fad5b-d9cb-469f-a165-70867728950e", service: "backend", commit_sha: "0123456789abcdef0123456789abcdef01234567",
    state: "failed", failed_stage: "ci_test", detail: `${UPSTREAM_RAW_MARKER} build output`, accepted_at: "2026-11-22T01:00:00Z",
    finished_at: "2026-11-22T01:03:00Z", ci_ms: 125000, cd_ms: 0 },
  { request_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", service: "front", commit_sha: "fedcba9876543210fedcba9876543210fedcba98",
    state: "succeeded", accepted_at: "2026-11-21T15:30:05Z", finished_at: "2026-11-21T15:33:00Z", ci_ms: 60000, cd_ms: 30000 },
  { request_id: "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b", service: "llm", commit_sha: "aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd",
    state: "ci_running", accepted_at: "2026-11-22T02:00:00Z", ci_ms: 0, cd_ms: 0 },
];

let handler: RoutedFetchHandler = () => jsonBody({ success: true, data: { deployments: ROWS } });
const masterFetch = createRoutedFetch((url, init) => handler(url, init));

async function render(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const element = await DeploysPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  state.restricted = false;
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  handler = () => jsonBody({ success: true, data: { deployments: ROWS } });
  masterFetch.mockClear();
  vi.stubGlobal("fetch", masterFetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("배포 이력 화면 — 표", () => {
  it("접수 시각은 KST, 원본 UTC 는 title · 커밋 앞 7자 · 요청 ID 앞 8자 · 실패 단계 · 걸린 시간 · 건수", async () => {
    const html = await render();
    expect(html).toContain("2026-11-22 10:00:00");
    expect(html).toContain('title="UTC 2026-11-22T01:00:00Z"');
    expect(html).toContain("2026-11-22 00:30:05");   // 15:30:05Z → 다음 날 00:30:05 KST
    expect(html).toContain(">0123456<");
    expect(html).toContain(">0f8fad5b<");
    expect(html).toContain("테스트");
    expect(html).toContain("ci_test");
    expect(html).toContain("2분 5초");
    expect(html).toContain("3건");
  });

  it("상태는 글자로도 구분한다 — 성공 · 실패 · 진행 중", async () => {
    const html = await render();
    for (const word of ["성공", "실패", "진행 중"]) expect(html).toContain(word);
  });

  it("detail(빌드 출력) · 비밀값 · master 주소는 HTML 에 없다", async () => {
    const html = await render();
    expectNoForbiddenText(html);
    expect(html).not.toContain("build output");
  });
});

describe("배포 이력 화면 — 서비스 선택(링크 · GET)", () => {
  it("전체 + 서비스 여섯을 링크로 — 고른 것에 aria-current", async () => {
    const html = await render({ service: "front" });
    expect(html).toContain('href="/deploys"');
    for (const service of ["front", "backend", "llm", "alert", "observe", "admin"]) expect(html).toContain(`href="/deploys?service=${service}"`);
    expect(html).toMatch(/href="\/deploys\?service=front" aria-current="page"/);
    expect(new URL(masterFetch.mock.calls[0][0]).searchParams.get("service")).toBe("front");
  });

  it("빈 목록이면 안내", async () => {
    handler = () => jsonBody({ success: true, data: { deployments: [] } });
    const html = await render({ service: "alert" });
    expect(html).toContain("alert 의 배포 기록이 없습니다.");
    expect(html).toContain("0건");
  });
});

describe("배포 이력 화면 — 실패 · 잘못된 입력", () => {
  it("master 연결 실패 → '배포 서버: 닿지 않음', 예외 문구 · 주소 · 비밀값 없음", async () => {
    handler = () => Promise.reject(leakyNetworkError());
    const html = await render();
    expect(html).toContain("배포 이력을 불러오지 못했습니다");
    expect(html).toContain("배포 서버: 닿지 않음");
    expectNoForbiddenText(html);
  });

  it("master 503 → 짧은 사유와 상태 코드만", async () => {
    handler = () => textResponse(leakyErrorBody(), 503);
    const html = await render();
    expect(html).toContain("서버 일시 장애");
    expect(html).toContain("HTTP 503");
    expectNoForbiddenText(html);
  });

  it("틀린 service → 조건 안내, master 를 부르지 않는다", async () => {
    const html = await render({ service: "not-a-service" });
    expect(html).toContain("조회 조건이 맞지 않습니다");
    expect(html).toContain("서비스");
    expect(masterFetch).not.toHaveBeenCalled();
  });
});

describe("공통 틀", () => {
  it("내비게이션 — 배포 이력은 링크(현재 화면), 나머지 셋은 링크 없이 '준비 중' · 로그아웃", async () => {
    const html = await render();
    expect(html).toMatch(/href="\/deploys" aria-current="page"[^>]*>배포 이력</);
    for (const title of ["로그 조회", "상태 한눈에", "로그인 시도 기록"]) {
      expect(html).toContain(title);
      expect(html).not.toMatch(new RegExp(`<a[^>]*>${title}<`));
    }
    expect(html).toContain("준비 중");
    expect(html).toContain("로그아웃");
  });

  it("임시 제한 중이면 배포 이력 화면에도 표시", async () => {
    state.restricted = true;
    expect(await render()).toContain("임시 제한 중");
    state.restricted = false;
    expect(await render()).not.toContain("임시 제한 중");
  });
});
