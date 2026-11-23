/** 배포 이력 화면의 배포 상세(명세 §10.2 · §10.3) — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 master — 배포 이력 · git 조회, 가짜 GitHub — PR)를 거친다.
 * 선택 없음 · 분할 · 닫기 · 커밋 링크 주소 · 범위 세 상태 · PR 없음 · GitHub 실패 구역 · 상한 "더 있음" · 바이너리 ·
 * 글자 그대로(이스케이프) · 세션 없음을 본다(relation · 이력 밖 · 출처 교체는 deploys-detail-git-page.test). 진입 모듈의 캐시가 사례 사이에 이어지지 않게 사례마다 모듈을 새로 읽는다. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => false }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookieValue !== undefined && name === "admin_session" ? { name, value: state.cookieValue } : undefined),
    has: () => state.cookieValue !== undefined,
    getAll: () => [],
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  gitCommitDetailJson, gitCommitJson, gitCommitRangeJson, gitFileJson, gitPatchWithLines, masterGitSuccess,
} from "@/features/deploy-detail/lib/deploy-git-test-fakes";
import { REPOSITORY_WEB, fakeSha, githubPullRequest, githubResponse, rateLimitedResponse } from "@/features/deploy-detail/lib/github-test-fakes";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, UPSTREAM_RAW_MARKER, createRoutedFetch, expectNoForbiddenText, jsonBody, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const SHA_A = fakeSha(1);
const SHA_B = fakeSha(2);
const SHA_MIDDLE = fakeSha(3);
const SHA_FRONT = fakeSha(4);

type Row = Record<string, unknown>;

function row(requestId: string, service: string, commitSha: string, overrides: Row = {}): Row {
  return {
    request_id: requestId, service, commit_sha: commitSha, state: "succeeded", accepted_at: "2026-11-22T02:00:00Z",
    finished_at: "2026-11-22T02:05:00Z", ci_ms: 60000, cd_ms: 30000, ...overrides,
  };
}

const DEFAULT_ROWS: Row[] = [
  row("front-1", "front", SHA_FRONT, { accepted_at: "2026-11-22T03:00:00Z" }),
  row("selected-1", "backend", SHA_B, { detail: `${UPSTREAM_RAW_MARKER} build output` }),
  row("previous-1", "backend", SHA_A, { accepted_at: "2026-11-22T01:00:00Z" }),
];

let rows: Row[] = DEFAULT_ROWS;
let masterHandler: RoutedFetchHandler = defaultMasterHandler;
let commitsHandler: RoutedFetchHandler = defaultCommitsHandler;
let commitHandler: RoutedFetchHandler = defaultCommitHandler;
let githubHandler: RoutedFetchHandler = defaultGithubHandler;

/** master 배포 이력. */
function defaultMasterHandler(url: URL): Response {
  const service = url.searchParams.get("service");
  return jsonBody({ success: true, data: { deployments: rows.filter((item) => service === null || item.service === service) } });
}

/** master git — 커밋 목록(B 쪽이 먼저). */
function defaultCommitsHandler(): Response {
  return masterGitSuccess(gitCommitRangeJson([gitCommitJson(SHA_B, { subject: "fix: head" }), gitCommitJson(SHA_MIDDLE, { subject: "feat: middle", body: "body" })]));
}

/** master git — 커밋 하나. */
function defaultCommitHandler(url: URL): Response {
  return masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [gitFileJson("src/a.ts", { patch: "@@ -1,2 +1,2 @@\n context\n-old line\n+new line" })]));
}

/** GitHub — PR 만. */
function defaultGithubHandler(url: URL): Response {
  if (url.pathname.endsWith("/pulls")) return githubResponse([githubPullRequest(12, { title: "배포 상세 화면", body: "## 바뀐 것\n- 상세" })]);
  throw new Error(`unexpected GitHub path ${url.pathname}`);
}

const networkFetch = createRoutedFetch((url, init) => {
  if (url.hostname === "api.github.com") return githubHandler(url, init);
  if (url.origin === new URL(FAKE_DEPLOY_MASTER_URL).origin) {
    if (url.pathname === "/deploys/git/commits") return commitsHandler(url, init);
    if (url.pathname === "/deploys/git/commit") return commitHandler(url, init);
    return masterHandler(url, init);
  }
  throw new Error(`unexpected host ${url.hostname}`);
});

async function render(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const { default: DeploysPage } = await import("@/app/deploys/page");
  const element = await DeploysPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

/** HTML 속성 안의 주소(& 는 &amp; 로 나온다). */
function attributeHref(path: string): string {
  return `href="${path.replaceAll("&", "&amp;")}"`;
}

/** master 배포 이력 호출(git 조회 경로 제외). */
function masterCalls() {
  return networkFetch.mock.calls
    .map(([input]) => new URL(input))
    .filter((url) => url.origin === new URL(FAKE_DEPLOY_MASTER_URL).origin && url.pathname === "/deploys");
}

function masterGitCalls() {
  return networkFetch.mock.calls
    .map(([input]) => new URL(input))
    .filter((url) => url.origin === new URL(FAKE_DEPLOY_MASTER_URL).origin && url.pathname.startsWith("/deploys/git/"));
}

function githubCalls() {
  return networkFetch.mock.calls.filter(([input]) => new URL(input).hostname === "api.github.com");
}

const SELECTED = { service: "backend", selected: "selected-1", selectedService: "backend" };

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("LOG_REDIS_URL", "");
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  rows = DEFAULT_ROWS;
  masterHandler = defaultMasterHandler;
  commitsHandler = defaultCommitsHandler;
  commitHandler = defaultCommitHandler;
  githubHandler = defaultGithubHandler;
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("선택 없음 · 선택 있음(분할)", () => {
  it("선택 없음 — 상세 구역이 없고 GitHub · master git 을 부르지 않는다, 줄마다 상세 링크(목록의 서비스 선택 유지 · 줄의 서비스)", async () => {
    const html = await render({ service: "backend" });
    expect(html).not.toContain('aria-label="배포 상세"');
    expect(html).toContain("<th scope=\"col\">요청 ID</th>");
    expect(html).toContain(attributeHref("/deploys?service=backend&selected=selected-1&selectedService=backend"));
    expect(githubCalls()).toHaveLength(0);
    expect(masterGitCalls()).toHaveLength(0);
  });

  it("선택 있음 — 목록 | 상세, 고른 줄에 aria-current, 목록은 칸을 줄인다, 요약 · PR · 커밋 목록", async () => {
    const html = await render(SELECTED);
    expect(html).toContain('aria-label="배포 상세"');
    expect(html).toContain("<h2");
    expect(html).toMatch(/href="\/deploys\?service=backend&amp;selected=selected-1&amp;selectedService=backend" aria-current="true"/);
    expect(html).not.toContain("<th scope=\"col\">요청 ID</th>");
    expect(html).toContain(">selected-1<");                 // 요약의 요청 ID(전체)
    expect(html).toContain(`>${SHA_B}<`);                   // 요약의 커밋(전체)
    expect(html).toContain("2026-11-22 11:00:00");          // 접수 KST
    expect(html).toContain("배포 상세 화면");               // PR 제목
    expect(html).toContain("#12");
    expect(html).toContain("feat: middle");
    expect(html).toContain("fix: head");
    expect(html).toContain("위 목록에서 커밋을 고르면");
    expectNoForbiddenText(html);
  });

  it("닫기 · 목록으로 — selected · selectedService · commit 을 뺀 목록 주소(서비스 선택은 유지)", async () => {
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toContain("← 목록으로");
    expect(html).toContain("닫기 ✕");
    expect(html.match(/href="\/deploys\?service=backend"/g)?.length).toBeGreaterThanOrEqual(3);   // 서비스 선택 · 목록으로 · 닫기
  });

  it("'전체' 보기에서도 — 상세 조회는 줄의 서비스(selectedService)로, 닫기는 전체", async () => {
    const html = await render({ selected: "selected-1", selectedService: "backend" });
    expect(html).toContain('aria-label="배포 상세"');
    expect(html).toContain("fix: head");
    const services = masterCalls().map((url) => url.searchParams.get("service"));
    expect(services.sort()).toEqual(["backend", null].sort());
    expect(html).toContain(attributeHref("/deploys?selected=front-1&selectedService=front"));
    expect(html).toMatch(/class="[^"]*backLink[^"]*" href="\/deploys"/);
  });

  it("커밋 링크의 주소 — 목록 조건 + 줄 + commit(40자), 고른 커밋에 aria-current · 바뀐 파일과 diff", async () => {
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toContain(attributeHref(`/deploys?service=backend&selected=selected-1&selectedService=backend&commit=${SHA_B}`));
    expect(html).toMatch(new RegExp(`href="/deploys\\?service=backend&amp;selected=selected-1&amp;selectedService=backend&amp;commit=${SHA_MIDDLE}" aria-current="true"`));
    expect(html).toContain("<details");
    expect(html).toContain("src/a.ts");
    expect(html).toContain(">old line<");
    expect(html).toContain(">new line<");
    expect(html).toMatch(/lineDeletion[^"]*"><td[^>]*>2<\/td><td[^>]*><\/td><td[^>]*>−<\/td>/);   // 뺀 줄: 옛 번호 · 기호 −
    expect(html).toMatch(/lineAddition[^"]*"><td[^>]*><\/td><td[^>]*>2<\/td><td[^>]*>\+<\/td>/);  // 더한 줄: 새 번호 · 기호 +
    expect(html).toContain("@@ -1,2 +1,2 @@");
  });
});

describe("범위 한 줄", () => {
  it("A→B — 직전 성공 배포 → 이번 배포, 커밋 N개", async () => {
    const html = await render(SELECTED);
    expect(html).toContain("직전 성공 배포");
    expect(html).toMatch(new RegExp(`직전 성공 배포 <code[^>]*title="${SHA_A}">${SHA_A.slice(0, 7)}</code> → 이번 배포 <code[^>]*title="${SHA_B}">`));
    expect(html).toContain("커밋 2개");
  });

  it("A 없음 — 이전 성공 배포 없음 — 이번 커밋만(범위 조회는 부르지 않는다)", async () => {
    rows = [row("selected-1", "backend", SHA_B)];
    const html = await render(SELECTED);
    expect(html).toContain("이전 성공 배포 없음 — 이번 커밋만");
    expect(masterGitCalls().some((url) => url.pathname === "/deploys/git/commits")).toBe(false);
  });

  it("A==B — 변경 없음(같은 커밋 재배포), 커밋이 없다", async () => {
    rows = [row("selected-1", "backend", SHA_B), row("previous-1", "backend", SHA_B)];
    const html = await render(SELECTED);
    expect(html).toContain("변경 없음(같은 커밋 재배포)");
    expect(html).toContain("바뀐 커밋이 없습니다.");
  });
});

describe("PR · GitHub 실패 · 상한 · 바이너리 · 글자 그대로", () => {
  it("PR 없음 — '연결된 PR 없음'", async () => {
    githubHandler = () => githubResponse([]);
    expect(await render(SELECTED)).toContain("연결된 PR 없음");
  });

  it("GitHub 한도 초과 — 요약 · 목록은 그대로, GitHub 구역에만 짧은 사유(원문 없음)", async () => {
    githubHandler = () => rateLimitedResponse(403);
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(html).toContain("GitHub: 한도 초과");
    expect(html).toContain(">selected-1<");                       // 요약
    expect(html).toContain('aria-label="배포 이력 표"');           // 목록
    expect(html).not.toContain("API rate limit");
    expectNoForbiddenText(html);
  });

  it("master 실패 — 상세 자리에 기존 방식의 사유(배포 서버: …)", async () => {
    masterHandler = () => jsonBody({ success: false, error: { code: UPSTREAM_RAW_MARKER } }, 503);
    const html = await render(SELECTED);
    expect(html).toContain("배포 상세를 불러오지 못했습니다");
    expect(html).toContain("서버 일시 장애");
    expect(githubCalls()).toHaveLength(0);
    expect(masterGitCalls()).toHaveLength(0);
    expectNoForbiddenText(html);
  });

  it("상한 — 커밋 · 파일 · patch 가 넘으면 '더 있음 — GitHub 에서 보기'(새 창, noopener noreferrer)", async () => {
    const commits = [gitCommitJson(SHA_B), ...Array.from({ length: 101 }, (_, index) => gitCommitJson(fakeSha(100 + index)))];   // B 쪽이 먼저
    const files = Array.from({ length: 101 }, (_, index) => gitFileJson(`file-${index}.ts`, { patch: index === 0 ? gitPatchWithLines(501) : "@@ -1 +1 @@\n-a\n+b" }));
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson(commits));
    commitHandler = () => masterGitSuccess(gitCommitDetailJson(SHA_B, files));
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(html).toContain("이번 배포에 가까운 100개만");
    expect(html).toContain("전체 501줄 중 앞 500줄만");
    expect(html).toContain("파일이 더 있음");
    expect(html).toContain(`href="${REPOSITORY_WEB}/compare/${SHA_A}...${SHA_B}" target="_blank" rel="noopener noreferrer"`);
    expect(html).toContain(`href="${REPOSITORY_WEB}/commit/${SHA_B}" target="_blank" rel="noopener noreferrer"`);
  });

  it("바이너리 파일(patch 없음) — '미리 볼 수 없음(바이너리)'", async () => {
    commitHandler = () => masterGitSuccess(gitCommitDetailJson(SHA_B, [gitFileJson("image.png", { status: "added", binary: true, patch: null })]));
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(html).toContain("image.png");
    expect(html).toContain("미리 볼 수 없음(바이너리)");
  });

  it("PR 본문 · 커밋 메시지 · diff 의 <script> 는 글자로 나온다(이스케이프, 마크다운 해석 없음)", async () => {
    githubHandler = () => githubResponse([githubPullRequest(7, { body: "<script>alert(1)</script>\n**굵게**" })]);
    commitHandler = () => masterGitSuccess(gitCommitDetailJson(SHA_B, [
      gitFileJson("a.html", { patch: "@@ -1 +1 @@\n-<b>x</b>\n+<script>evil()</script>" }),
    ], { subject: "<img src=x onerror=alert(1)>" }));
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("**굵게**");
    expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<strong>굵게");
  });
});

describe("선택 조건 · 세션", () => {
  it("목록 밖 commit — 상세 자리에 조건 안내, 그 커밋은 master 에서도 GitHub 에서도 부르지 않는다", async () => {
    const outside = fakeSha(99);
    const html = await render({ ...SELECTED, commit: outside });
    expect(html).toContain("선택 조건이 맞지 않습니다");
    expect(html).toContain('aria-label="배포 이력 표"');
    expect(githubCalls().some(([input]) => new URL(input).pathname.endsWith(`/commits/${outside}`))).toBe(false);
    expect(masterGitCalls().some((url) => url.pathname === "/deploys/git/commit")).toBe(false);
  });

  it("목록에 없는 요청 ID — '선택한 배포를 찾을 수 없습니다'", async () => {
    expect(await render({ ...SELECTED, selected: "missing-1" })).toContain("선택한 배포를 찾을 수 없습니다");
  });

  it("세션이 없으면 로그인으로 — master · GitHub 를 부르지 않는다", async () => {
    state.cookieValue = undefined;
    await expect(render({ ...SELECTED, commit: SHA_B })).rejects.toThrow(/^redirect:/);
    expect(networkFetch).not.toHaveBeenCalled();
  });
});
