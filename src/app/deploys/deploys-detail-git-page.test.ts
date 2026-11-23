/** 배포 상세 화면 — 출처 교체(명세 §12.2 어드민 항 · 12.7 relation · 12.8 unknown 문구 · 12.9 repository_changing 문구 · §10.2 "더 있음" · 글자 그대로).
 * 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 master 의 배포 이력 · git 두 경로 · 가짜 GitHub — PR 만)를 거친다.
 * 진입 모듈의 캐시가 사례 사이에 이어지지 않게 사례마다 모듈을 새로 읽는다.
 * 화면 글자(명세 문구):
 * - not_ancestor: "직전 배포가 이 커밋의 조상이 아님" + 링크 "GitHub 에서 비교 보기"(비교 주소)
 * - unknown: "이 서버의 git 이력으로는 알 수 없음(최근 50개 밖일 수 있음)" + 링크 "GitHub 에서 비교 보기"(비교 주소)
 * - 404 commit_not_found · parent_unavailable: "이 서버의 git 이력에 없음(최근 50개 밖일 수 있음)" + 링크 "GitHub 에서 보기"
 *   (커밋 목록 칸이면 비교 주소 — A 없음이면 B 의 커밋 주소, 고른 커밋 칸이면 그 커밋의 주소)
 * - 503 repository_changing: "배포가 이력을 바꾸는 중 — 잠시 뒤 새로 고침"
 * - 그 밖의 실패: 기존 관례(고정 사유 + "HTTP <상태>") — git 칸의 실패에는 "GitHub:" 를 붙이지 않는다(출처가 master 다).
 * - 범위로 B 를 보일 수 없으면(not_ancestor · unknown · 범위 조회 실패) 안내 · 실패 문구와 함께 B 커밋 하나를 보이고 고를 수 있다(메인 판정 11-23).
 *   B 도 실패하면 범위 실패 문구와 B 의 실패 문구를 둘 다(범위 조회 실패일 때 — 명세 §12.11) · 안내 + B 의 실패 문구(not_ancestor · unknown 일 때).
 * - 범위 조회 실패 문구에는 이유와 무관하게 "GitHub 에서 비교 보기"(비교 주소) 링크가 붙는다(A 없음에서 B 실패는 B 의 커밋 주소).
 * - patch 끝의 줄바꿈은 줄이 아니다 — diff 표의 줄 수 = patch 의 줄 수(빈 줄을 하나 더 그리지 않는다).
 * - truncated · range_complete:false · body_truncated · files_truncated · patch_truncated: "더 있음" 류 + GitHub 링크(조용히 자르지 않는다). */
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
  gitCommitDetailJson, gitCommitJson, gitCommitRangeJson, gitFileJson, gitPatchWithLines, masterGitFailure, masterGitSuccess,
} from "@/features/deploy-detail/lib/deploy-git-test-fakes";
import {
  REPOSITORY_WEB, fakeSha, githubCommitObject, githubCommitWithFiles, githubComparison, githubFile, githubPullRequest, githubResponse, rateLimitedResponse,
} from "@/features/deploy-detail/lib/github-test-fakes";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, UPSTREAM_RAW_MARKER, createRoutedFetch, expectNoForbiddenText, jsonBody, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const SHA_A = fakeSha(1);
const SHA_B = fakeSha(2);
const SHA_MIDDLE = fakeSha(3);
const COMPARE_URL = `${REPOSITORY_WEB}/compare/${SHA_A}...${SHA_B}`;

type Row = Record<string, unknown>;

function row(requestId: string, commitSha: string, overrides: Row = {}): Row {
  return {
    request_id: requestId, service: "backend", commit_sha: commitSha, state: "succeeded", accepted_at: "2026-11-22T02:00:00Z",
    finished_at: "2026-11-22T02:05:00Z", ci_ms: 60000, cd_ms: 30000, ...overrides,
  };
}

const DEFAULT_ROWS: Row[] = [row("selected-1", SHA_B), row("previous-1", SHA_A, { accepted_at: "2026-11-22T01:00:00Z" })];

let rows: Row[] = DEFAULT_ROWS;
let commitsHandler: RoutedFetchHandler = defaultCommitsHandler;
let commitHandler: RoutedFetchHandler = defaultCommitHandler;
let githubHandler: RoutedFetchHandler = defaultGithubHandler;

function defaultCommitsHandler(): Response {
  return masterGitSuccess(gitCommitRangeJson([
    gitCommitJson(SHA_B, { subject: "fix: head" }),
    gitCommitJson(SHA_MIDDLE, { subject: "feat: middle", body: "middle body" }),
  ]));
}

function defaultCommitHandler(url: URL): Response {
  return masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [
    gitFileJson("src/a.ts", { patch: "@@ -1,2 +1,2 @@\n context\n-old line\n+new line\n" }),
  ], { subject: "fix: head" }));
}

/** GitHub 의 비교 · 커밋 조회에는 다른 제목을 준다 — 화면에 나오면 GitHub 를 부른 것이다. */
function defaultGithubHandler(url: URL): Response {
  if (url.pathname.endsWith("/pulls")) return githubResponse([githubPullRequest(12, { title: "배포 상세 화면", body: "PR 본문" })]);
  if (url.pathname.includes("/compare/")) return githubResponse(githubComparison(SHA_A, SHA_B, [githubCommitObject(SHA_B, "from-github-compare")]));
  const sha = url.pathname.split("/").pop()!;
  return githubResponse(githubCommitWithFiles(sha, [githubFile("from-github.ts")], "from-github-commit"));
}

const networkFetch = createRoutedFetch((url, init) => {
  if (url.hostname === "api.github.com") return githubHandler(url, init);
  if (url.origin === new URL(FAKE_DEPLOY_MASTER_URL).origin) {
    if (url.pathname === "/deploys") {
      const service = url.searchParams.get("service");
      return jsonBody({ success: true, data: { deployments: rows.filter((item) => service === null || item.service === service) } });
    }
    if (url.pathname === "/deploys/git/commits") return commitsHandler(url, init);
    if (url.pathname === "/deploys/git/commit") return commitHandler(url, init);
  }
  throw new Error(`unexpected request ${url.href}`);
});

async function render(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const { default: DeploysPage } = await import("@/app/deploys/page");
  const element = await DeploysPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function githubCommitCalls() {
  return networkFetch.mock.calls
    .map(([input]) => new URL(input))
    .filter((url) => url.hostname === "api.github.com" && !url.pathname.endsWith("/pulls"));
}

/** 새 창 링크(<a href=… target=_blank rel=noopener noreferrer>글자</a>). */
function externalLink(href: string, text: string): RegExp {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<a href="${escaped}" target="_blank" rel="noopener noreferrer">${text}</a>`);
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

describe("출처 — 커밋 목록 · diff 는 master, PR 만 GitHub", () => {
  it("커밋 목록(오래된 것 먼저) · 고른 커밋의 diff 는 master 의 글자, PR 은 GitHub, GitHub 비교 · 커밋 조회 0회, 더 있음 없음", async () => {
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toContain("feat: middle");
    expect(html).toContain("fix: head");
    expect(html.indexOf("feat: middle")).toBeLessThan(html.indexOf("fix: head"));
    expect(html).toContain("배포 상세 화면");
    expect(html).toContain("src/a.ts");
    expect(html).toContain(">old line<");
    expect(html).toContain(">new line<");
    expect(html).not.toContain("from-github");
    expect(html).not.toContain("더 있음");
    expect(githubCommitCalls()).toHaveLength(0);
    expectNoForbiddenText(html);
  });

  it("고른 커밋의 'GitHub 에서 보기'는 그 커밋의 공개 저장소 주소(새 창)", async () => {
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toMatch(externalLink(`${REPOSITORY_WEB}/commit/${SHA_MIDDLE}`, "GitHub 에서 보기"));
  });
});

describe("relation — 조상 아님 · 알 수 없음(B 하나는 보인다)", () => {
  it("not_ancestor — '직전 배포가 이 커밋의 조상이 아님' + 'GitHub 에서 비교 보기'(비교 주소) + B 커밋 한 줄", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([], { relation: "not_ancestor" }));
    const html = await render(SELECTED);
    expect(html).toContain("직전 배포가 이 커밋의 조상이 아님");
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 비교 보기"));
    expect(html).not.toContain("이 서버의 git 이력으로는 알 수 없음");
    expect(html).toContain("fix: head");
    expect(html).toContain(`commit=${SHA_B}`);
  });

  it("unknown — '이 서버의 git 이력으로는 알 수 없음(최근 50개 밖일 수 있음)' + 'GitHub 에서 비교 보기'(비교 주소) + B 커밋 한 줄", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([], { relation: "unknown", range_complete: false }));
    const html = await render(SELECTED);
    expect(html).toContain("이 서버의 git 이력으로는 알 수 없음(최근 50개 밖일 수 있음)");
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 비교 보기"));
    expect(html).not.toContain("직전 배포가 이 커밋의 조상이 아님");
    expect(html).toContain("fix: head");
  });

  it.each(["not_ancestor", "unknown"])("%s + commit=B — 안내와 함께 B 의 바뀐 파일과 diff, 고른 줄에 aria-current", async (relation) => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([], { relation, range_complete: relation !== "unknown" }));
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 비교 보기"));
    expect(html).toMatch(new RegExp(`commit=${SHA_B}" aria-current="true"`));
    expect(html).toContain("src/a.ts");
    expect(html).toContain(">new line<");
    expect(html).not.toContain("선택 조건이 맞지 않습니다");
  });

  it("not_ancestor + B 밖의 commit — '선택 조건이 맞지 않습니다'", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([], { relation: "not_ancestor" }));
    expect(await render({ ...SELECTED, commit: SHA_MIDDLE })).toContain("선택 조건이 맞지 않습니다");
  });

  it("not_ancestor + B 가 이력 밖 — 안내 문구는 남고 '이 서버의 git 이력에 없음(…)' + B 커밋의 'GitHub 에서 보기'", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([], { relation: "not_ancestor" }));
    commitHandler = () => masterGitFailure(404, "commit_not_found");
    const html = await render(SELECTED);
    expect(html).toContain("직전 배포가 이 커밋의 조상이 아님");
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 비교 보기"));
    expect(html).toContain("이 서버의 git 이력에 없음(최근 50개 밖일 수 있음)");
    expect(html).toMatch(externalLink(`${REPOSITORY_WEB}/commit/${SHA_B}`, "GitHub 에서 보기"));
    expect(html).toContain("배포 상세 화면");
  });
});

describe("이력 밖 · 이력이 바뀌는 중", () => {
  it("커밋 목록 404 commit_not_found — '이 서버의 git 이력에 없음(최근 50개 밖일 수 있음)' + 'GitHub 에서 보기'(비교 주소)", async () => {
    commitsHandler = () => masterGitFailure(404, "commit_not_found");
    const html = await render(SELECTED);
    expect(html).toContain("이 서버의 git 이력에 없음(최근 50개 밖일 수 있음)");
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 (비교 )?보기"));
    expect(html).toContain("fix: head");          // 범위 실패 아래 B 커밋 한 줄
    expect(html).toContain("배포 상세 화면");   // PR 구역은 그대로
    expectNoForbiddenText(html, [UPSTREAM_RAW_MARKER, "/srv/deploy"]);
  });

  it("A 없음 + B 가 이력 밖 — 같은 문구 + B 커밋의 'GitHub 에서 보기'", async () => {
    rows = [row("selected-1", SHA_B)];
    commitHandler = () => masterGitFailure(404, "commit_not_found");
    const html = await render(SELECTED);
    expect(html).toContain("이 서버의 git 이력에 없음(최근 50개 밖일 수 있음)");
    expect(html).toMatch(externalLink(`${REPOSITORY_WEB}/commit/${SHA_B}`, "GitHub 에서 보기"));
  });

  it.each(["commit_not_found", "parent_unavailable"])("고른 커밋 404 %s — 같은 문구 + 그 커밋의 'GitHub 에서 보기', 커밋 목록은 그대로", async (code) => {
    commitHandler = () => masterGitFailure(404, code);
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toContain("이 서버의 git 이력에 없음(최근 50개 밖일 수 있음)");
    expect(html).toMatch(externalLink(`${REPOSITORY_WEB}/commit/${SHA_MIDDLE}`, "GitHub 에서 보기"));
    expect(html).toContain("feat: middle");
  });

  it("503 repository_changing — '배포가 이력을 바꾸는 중 — 잠시 뒤 새로 고침'", async () => {
    commitsHandler = () => masterGitFailure(503, "repository_changing");
    const html = await render(SELECTED);
    expect(html).toContain("배포가 이력을 바꾸는 중 — 잠시 뒤 새로 고침");
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 비교 보기"));
    expect(html).toContain("fix: head");
    expect(html).toContain("배포 상세 화면");
  });

  it("범위 조회 실패 + commit=B — 범위 실패 문구와 함께 B 의 diff", async () => {
    commitsHandler = () => masterGitFailure(503, "repository_changing");
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(html).toContain("배포가 이력을 바꾸는 중 — 잠시 뒤 새로 고침");
    expect(html).toContain(">new line<");
  });

  it("범위 조회 실패 + B 도 실패 — 범위의 실패 문구(404 이력 밖)와 B 의 실패 문구(429 한도 초과)가 둘 다, 커밋 줄 없음, PR 은 그대로", async () => {
    commitsHandler = () => masterGitFailure(404, "commit_not_found");
    commitHandler = () => masterGitFailure(429, "too_many_requests");
    const html = await render(SELECTED);
    expect(html).toContain("이 서버의 git 이력에 없음(최근 50개 밖일 수 있음)");
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 (비교 )?보기"));
    expect(html).toContain("한도 초과");
    expect(html).toContain("HTTP 429");
    expect(html).not.toContain("GitHub: 한도 초과");
    expect(html).not.toContain("fix: head");
    expect(html).toContain("배포 상세 화면");
    expectNoForbiddenText(html, [UPSTREAM_RAW_MARKER, "/srv/deploy", FAKE_DEPLOY_SECRET, "deploy-master.example.test"]);
  });

  it("범위 조회 실패 + B 도 실패 + commit=B — 고른 커밋 자리에 B 의 실패(429 한도 초과)", async () => {
    commitsHandler = () => masterGitFailure(404, "commit_not_found");
    commitHandler = () => masterGitFailure(429, "too_many_requests");
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(html).toContain("한도 초과");
    expect(html).not.toContain("선택 조건이 맞지 않습니다");
  });

  it("범위 조회 실패 + B 도 실패 + B 밖의 commit — '선택 조건이 맞지 않습니다'", async () => {
    commitsHandler = () => masterGitFailure(404, "commit_not_found");
    commitHandler = () => masterGitFailure(429, "too_many_requests");
    expect(await render({ ...SELECTED, commit: SHA_MIDDLE })).toContain("선택 조건이 맞지 않습니다");
  });
});

describe("그 밖의 git 실패 — 기존 관례(고정 사유 · HTTP 상태), 'GitHub:' 를 붙이지 않는다", () => {
  it.each([
    [429, "too_many_requests", "한도 초과"],
    [504, "git_timeout", "서버 조회 시간 초과"],
    [504, "agent_timeout", "서버 조회 시간 초과"],
    [502, "agent_unreachable", "예상하지 못한 응답"],
    [502, "agent_unauthorized", "예상하지 못한 응답"],
    [502, "unexpected_response", "예상하지 못한 응답"],
    [500, "git_failed", "예상하지 못한 응답"],
  ] as const)("커밋 목록 %d %s → '%s' · HTTP 상태, 요약 · PR 은 그대로, 원문 없음", async (status, code, message) => {
    commitsHandler = () => masterGitFailure(status, code);
    const html = await render(SELECTED);
    expect(html).toContain(message);
    expect(html).toContain(`HTTP ${status}`);
    expect(html).not.toContain(`GitHub: ${message}`);
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 비교 보기"));   // 이유와 무관하게 비교 링크
    expect(html).toContain(">selected-1<");
    expect(html).toContain("fix: head");          // 범위 실패 아래 B 커밋 한 줄
    expect(html).toContain("배포 상세 화면");
    expectNoForbiddenText(html, [UPSTREAM_RAW_MARKER, "/srv/deploy", FAKE_DEPLOY_SECRET, "deploy-master.example.test"]);
  });

  it("커밋 목록이 계약과 다른 꼴(unparseable) — '해석 불가' + 'GitHub 에서 비교 보기' + B 커밋 한 줄", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([], { relation: "diverged" }));
    const html = await render(SELECTED);
    expect(html).toContain("해석 불가");
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 비교 보기"));
    expect(html).toContain("fix: head");
  });

  it("PR(GitHub) 실패 — PR 구역만 사유, 커밋 목록 · diff 는 그대로", async () => {
    githubHandler = () => rateLimitedResponse(403);
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toContain("GitHub: 한도 초과");
    expect(html).toContain("feat: middle");
    expect(html).toContain(">new line<");
  });
});

describe("더 있음 — 조용히 자르지 않는다", () => {
  it("커밋 목록 truncated — '더 있음' + 비교 주소", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([gitCommitJson(SHA_B)], { truncated: true }));
    const html = await render(SELECTED);
    expect(html).toContain("더 있음");
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 (비교 )?보기"));
  });

  it("range_complete:false(ancestor — 목록이 얕은 이력의 경계에서 끝남) — '더 있음' + 비교 주소", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([gitCommitJson(SHA_B)], { range_complete: false }));
    const html = await render(SELECTED);
    expect(html).toContain("더 있음");
    expect(html).toMatch(externalLink(COMPARE_URL, "GitHub 에서 (비교 )?보기"));
  });

  it("body_truncated — 고른 커밋의 메시지 아래 '더 있음'", async () => {
    commitHandler = (url) => masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [gitFileJson("a.ts")], { body: "긴 본문 앞부분", body_truncated: true }));
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toContain("긴 본문 앞부분");
    expect(html).toContain("더 있음");
  });

  it("files_truncated — '파일이 더 있음' + 커밋 주소", async () => {
    commitHandler = (url) => masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [gitFileJson("a.ts")], { files_truncated: true }));
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toContain("파일이 더 있음");
    expect(html).toMatch(externalLink(`${REPOSITORY_WEB}/commit/${SHA_MIDDLE}`, "GitHub 에서 보기"));
  });

  it("patch_truncated(전체 줄 수 모름) — 받은 줄은 보이고 '더 있음'", async () => {
    commitHandler = (url) => masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [
      gitFileJson("big.ts", { patch: "@@ -1 +1 @@\n+kept line\n", patch_truncated: true }),
    ]));
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toContain(">kept line<");
    expect(html).toContain("더 있음");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null줄");
  });

  it("patch 를 비운 파일(patch_truncated + 빈 patch) — '더 있음'(바이너리 문구가 아니다)", async () => {
    commitHandler = (url) => masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [
      gitFileJson("huge.json", { patch: "", patch_truncated: true }),
    ]));
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toContain("huge.json");
    expect(html).toContain("더 있음");
    expect(html).not.toContain("바이너리");
  });

  it("바이너리 — '미리 볼 수 없음'", async () => {
    commitHandler = (url) => masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [
      gitFileJson("image.png", { status: "added", binary: true, additions: 0, deletions: 0, patch: null }),
    ]));
    const html = await render({ ...SELECTED, commit: SHA_MIDDLE });
    expect(html).toContain("image.png");
    expect(html).toContain("미리 볼 수 없음");
  });
});

describe("글자 그대로 — git 의 제목 · 본문 · 경로 · patch 는 HTML 로 해석하지 않는다", () => {
  it("<script> · <img> 는 이스케이프된 글자로", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([gitCommitJson(SHA_B, { subject: "<img src=x onerror=alert(1)>" }), gitCommitJson(SHA_MIDDLE)]));
    commitHandler = (url) => masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [
      gitFileJson("<b>a</b>.html", { patch: "@@ -1 +1 @@\n-<b>x</b>\n+<script>evil()</script>\n" }),
    ], { subject: "<img src=x onerror=alert(1)>", body: "<script>alert(1)</script>\n**굵게**" }));
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;a&lt;/b&gt;.html");
    expect(html).toContain("**굵게**");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });
});

describe("patch 끝의 줄바꿈 — 줄로 세지 않는다(실제 master 응답 꼴)", () => {
  /** 파일 하나의 diff 표에 그려진 줄(<tr>) 수. */
  function diffRowCount(html: string, filename: string): number {
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const table = new RegExp(`aria-label="${escaped} diff"[\\s\\S]*?</table>`).exec(html);
    expect(table, `${filename} 의 diff 표`).not.toBeNull();
    return (table![0].match(/<tr[ >]/g) ?? []).length;
  }

  function commitWith(patch: string): RoutedFetchHandler {
    return (url) => masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [gitFileJson("src/a.ts", { patch })]));
  }

  it("머리줄 포함 4줄 + 끝 줄바꿈 → 표의 줄 4개(빈 줄을 더 그리지 않는다)", async () => {
    commitHandler = commitWith("@@ -1,2 +1,2 @@\n context\n-old line\n+new line\n");
    expect(diffRowCount(await render({ ...SELECTED, commit: SHA_B }), "src/a.ts")).toBe(4);
  });

  it("'\\ No newline at end of file' 뒤의 끝 줄바꿈 → 알림 줄까지 4개", async () => {
    commitHandler = commitWith("@@ -1 +1 @@\n-old line\n+new line\n\\ No newline at end of file\n");
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(diffRowCount(html, "src/a.ts")).toBe(4);
    expect(html).toContain("No newline at end of file");
  });

  it("정확히 500줄(+ 끝 줄바꿈) — 500줄 모두 · '더 있음' 없음", async () => {
    commitHandler = commitWith(gitPatchWithLines(500));
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(diffRowCount(html, "src/a.ts")).toBe(500);
    expect(html).not.toContain("더 있음");
  });

  it("501줄(+ 끝 줄바꿈) — 500줄만 · '더 있음'", async () => {
    commitHandler = commitWith(gitPatchWithLines(501));
    const html = await render({ ...SELECTED, commit: SHA_B });
    expect(diffRowCount(html, "src/a.ts")).toBe(500);
    expect(html).toContain("더 있음");
  });
});
