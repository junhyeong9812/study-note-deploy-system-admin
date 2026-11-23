/** 배포 상세 데이터 경로 — 출처 교체(명세 §10.3 · §12.2 어드민 항 · 12.7~12.9). GET /api/deploys/detail(Route Handler → server/ 진입).
 * 전역 fetch 를 가짜로 바꾼다: master 의 `/deploys` · `/deploys/git/commits` · `/deploys/git/commit` 과 GitHub(api.github.com — PR 만 불려야 한다).
 * 진입 모듈의 캐시가 사례 사이에 이어지지 않게 사례마다 모듈을 새로 읽는다(vi.resetModules).
 * 범위로 B 를 보일 수 없으면(not_ancestor · unknown · 범위 조회 실패) B 하나로 물러선다(메인 판정 11-23) — 보기 모델의 rangeFailure · headFailure.
 * 설정 키는 늘지 않는다 — master git 조회는 배포 이력과 같은 DEPLOY_MASTER_URL · DEPLOY_SECRET, GITHUB_TOKEN 은 계속 선택. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
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
  gitCommitDetailJson, gitCommitJson, gitCommitRangeJson, gitFileJson, masterGitFailure, masterGitSuccess,
} from "@/features/deploy-detail/lib/deploy-git-test-fakes";
import {
  REPOSITORY_WEB, fakeSha, githubCommitObject, githubCommitWithFiles, githubComparison, githubFile, githubPullRequest, githubResponse, rateLimitedResponse,
} from "@/features/deploy-detail/lib/github-test-fakes";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, UPSTREAM_RAW_MARKER, createRoutedFetch, expectNoForbiddenText, headersOf, jsonBody,
  type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const GITHUB_TOKEN_VALUE = "fake-github-token-marker-git-route-r86";
const SHA_A = fakeSha(1);
const SHA_MIDDLE = fakeSha(3);
const SHA_B = fakeSha(2);
const DETAIL_PATH = "/api/deploys/detail";
const COMPARE_URL = `${REPOSITORY_WEB}/compare/${SHA_A}...${SHA_B}`;

const ROWS = [
  { request_id: "selected-1", service: "backend", commit_sha: SHA_B, state: "succeeded", accepted_at: "2026-11-22T02:00:00Z",
    finished_at: "2026-11-22T02:05:00Z", ci_ms: 60000, cd_ms: 30000 },
  { request_id: "previous-1", service: "backend", commit_sha: SHA_A, state: "succeeded", accepted_at: "2026-11-22T01:00:00Z",
    finished_at: "2026-11-22T01:05:00Z", ci_ms: 60000, cd_ms: 30000 },
];

let rows: unknown[] = ROWS;
let commitsHandler: RoutedFetchHandler = defaultCommitsHandler;
let commitHandler: RoutedFetchHandler = defaultCommitHandler;
let githubHandler: RoutedFetchHandler = defaultGithubHandler;

function defaultCommitsHandler(): Response {
  return masterGitSuccess(gitCommitRangeJson([gitCommitJson(SHA_B, { subject: "fix: head" }), gitCommitJson(SHA_MIDDLE, { subject: "feat: middle" })]));
}

function defaultCommitHandler(url: URL): Response {
  return masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [gitFileJson("src/a.ts")]));
}

/** GitHub 의 비교 · 커밋 조회에도 답은 준다 — 불렸는지는 githubCommitCalls() 로 0회를 단언한다. */
function defaultGithubHandler(url: URL): Response {
  if (url.pathname.includes("/compare/")) return githubResponse(githubComparison(SHA_A, SHA_B, [githubCommitObject(SHA_MIDDLE), githubCommitObject(SHA_B)]));
  if (url.pathname.endsWith("/pulls")) return githubResponse([githubPullRequest(12)]);
  const sha = url.pathname.split("/").pop()!;
  return githubResponse(githubCommitWithFiles(sha, [githubFile("src/a.ts")]));
}

const networkFetch = createRoutedFetch((url, init) => {
  if (url.hostname === "api.github.com") return githubHandler(url, init);
  if (url.origin === new URL(FAKE_DEPLOY_MASTER_URL).origin) {
    if (url.pathname === "/deploys") return jsonBody({ success: true, data: { deployments: rows } });
    if (url.pathname === "/deploys/git/commits") return commitsHandler(url, init);
    if (url.pathname === "/deploys/git/commit") return commitHandler(url, init);
  }
  throw new Error(`unexpected request ${url.href}`);
});

const consoleLines: string[] = [];

function callsTo(predicate: (url: URL) => boolean) {
  return networkFetch.mock.calls.filter(([input]) => predicate(new URL(input)));
}

const isMaster = (url: URL) => url.origin === new URL(FAKE_DEPLOY_MASTER_URL).origin;
const masterHistoryCalls = () => callsTo((url) => isMaster(url) && url.pathname === "/deploys");
const masterCommitsCalls = () => callsTo((url) => isMaster(url) && url.pathname === "/deploys/git/commits");
const masterCommitCalls = () => callsTo((url) => isMaster(url) && url.pathname === "/deploys/git/commit");
const githubCalls = () => callsTo((url) => url.hostname === "api.github.com");
/** GitHub 의 비교 · 커밋 조회(PR 조회 `/commits/{sha}/pulls` 가 아닌 것) — 언제나 0회여야 한다. */
const githubCommitCalls = () => githubCalls().filter(([input]) => !new URL(input).pathname.endsWith("/pulls"));

async function callDetail(search: string): Promise<Response> {
  const route = await import("@/app/api/deploys/detail/route");
  return route.GET(new Request(new URL(`${DETAIL_PATH}${search}`, FAKE_ORIGIN)));
}

async function detailBody(search: string) {
  const response = await callDetail(search);
  expect(response.status).toBe(200);
  return response.json();
}

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
  rows = ROWS;
  commitsHandler = defaultCommitsHandler;
  commitHandler = defaultCommitHandler;
  githubHandler = defaultGithubHandler;
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  consoleLines.length = 0;
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("출처 — 커밋 목록 · diff 는 master, PR 만 GitHub", () => {
  it("200 — 범위의 커밋 목록(relation · 오래된 것 먼저 · 비교 주소)과 고른 커밋의 파일, 원문 · 비밀 · master 주소 없음", async () => {
    const body = await detailBody(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    expect(body.success).toBe(true);
    const commits = body.data.commits;
    expect(commits.ok).toBe(true);
    expect(commits.value).toMatchObject({ relation: "ancestor", hasMoreCommits: false, rangeComplete: true, htmlUrl: COMPARE_URL });
    expect(commits.value.commits.map((commit: { sha: string }) => commit.sha)).toEqual([SHA_MIDDLE, SHA_B]);
    expect(commits.value.commits[1]).toEqual({
      sha: SHA_B, title: "fix: head", message: "fix: head", messageTruncated: false, authorName: "Jun", authoredAt: "2026-11-22T01:00:00Z",
      htmlUrl: `${REPOSITORY_WEB}/commit/${SHA_B}`,
    });
    expect(body.data.commit.value.sha).toBe(SHA_MIDDLE);
    expect(body.data.commit.value.files).toEqual([
      { filename: "src/a.ts", previousFilename: null, status: "modified", additions: 1, deletions: 1, patch: { kind: "text", text: "@@ -1 +1 @@\n-old\n+new", truncated: false, totalLines: 3 } },
    ]);
    expect(body.data.pullRequest.value).toMatchObject({ number: 12, title: "PR 12" });
    expectNoForbiddenText(body);
  });

  it("master 호출 — /deploys(limit 200) · /deploys/git/commits?service=&from=A&to=B · /deploys/git/commit?service=&sha=, 전부 GET · X-Deploy-Secret · redirect manual · Authorization 없음", async () => {
    vi.stubEnv("GITHUB_TOKEN", GITHUB_TOKEN_VALUE);
    await callDetail(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    expect(masterHistoryCalls()).toHaveLength(1);
    expect(masterCommitsCalls()).toHaveLength(1);
    expect(masterCommitCalls()).toHaveLength(1);
    const commitsUrl = new URL(masterCommitsCalls()[0][0]);
    expect([...commitsUrl.searchParams.entries()]).toEqual([["service", "backend"], ["from", SHA_A], ["to", SHA_B]]);
    const commitUrl = new URL(masterCommitCalls()[0][0]);
    expect([...commitUrl.searchParams.entries()]).toEqual([["service", "backend"], ["sha", SHA_MIDDLE]]);
    for (const [, init] of [...masterCommitsCalls(), ...masterCommitCalls()]) {
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
      expect(init?.body ?? null).toBeNull();
      expect(init?.redirect).toBe("manual");
      expect(headersOf(init).get("X-Deploy-Secret")).toBe(FAKE_DEPLOY_SECRET);
      expect(headersOf(init).has("Authorization")).toBe(false);
    }
  });

  it("GitHub — PR 조회(B 의 /pulls) 한 번뿐, 비교 · 커밋 조회 0회, 비밀 헤더 없음", async () => {
    await callDetail(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    expect(githubCommitCalls()).toHaveLength(0);
    const paths = githubCalls().map(([input]) => new URL(input).pathname);
    expect(paths).toEqual([`/repos/junhyeong9812/study-note-deploy-system-backend/commits/${SHA_B}/pulls`]);
    for (const [, init] of githubCalls()) expect(headersOf(init).has("X-Deploy-Secret")).toBe(false);
  });

  it("A 없음 — master 의 커밋 하나(B)만, 범위 조회 · GitHub 비교/커밋 0회", async () => {
    rows = [ROWS[0]];
    const body = await detailBody(`?service=backend&selected=selected-1&commit=${SHA_B}`);
    expect(body.data.range.status).toBe("no_previous");
    expect(body.data.commits.value).toMatchObject({ relation: null, hasMoreCommits: false, rangeComplete: true, htmlUrl: `${REPOSITORY_WEB}/commit/${SHA_B}` });
    expect(body.data.commit.value.sha).toBe(SHA_B);
    expect(masterCommitsCalls()).toHaveLength(0);
    expect(masterCommitCalls()).toHaveLength(1);
    expect(githubCommitCalls()).toHaveLength(0);
  });

  it("A==B — master git · GitHub 비교/커밋 0회", async () => {
    rows = [ROWS[0], { ...ROWS[1], commit_sha: SHA_B }];
    const body = await detailBody("?service=backend&selected=selected-1");
    expect(body.data.range.status).toBe("same_commit");
    expect(body.data.commits.value).toEqual({ relation: null, commits: [], hasMoreCommits: false, rangeComplete: true, htmlUrl: null, rangeFailure: null, headFailure: null });
    expect(masterCommitsCalls()).toHaveLength(0);
    expect(masterCommitCalls()).toHaveLength(0);
    expect(githubCommitCalls()).toHaveLength(0);
  });
});

describe("relation · 더 있음", () => {
  it.each([
    ["not_ancestor", gitCommitRangeJson([], { relation: "not_ancestor" }), true],
    ["unknown", gitCommitRangeJson([], { relation: "unknown", range_complete: false }), false],
  ] as const)("%s — B 하나로 물러선다(master 의 커밋 하나 한 번) · relation 그대로 · 비교 주소", async (relation, data, rangeComplete) => {
    commitsHandler = () => masterGitSuccess(data);
    const body = await detailBody("?service=backend&selected=selected-1");
    expect(body.data.commits.ok).toBe(true);
    expect(body.data.commits.value).toMatchObject({ relation, hasMoreCommits: false, rangeComplete, htmlUrl: COMPARE_URL, rangeFailure: null, headFailure: null });
    expect(body.data.commits.value.commits.map((commit: { sha: string }) => commit.sha)).toEqual([SHA_B]);
    expect(masterCommitCalls()).toHaveLength(1);
    expect(new URL(masterCommitCalls()[0][0]).searchParams.get("sha")).toBe(SHA_B);
    expect(githubCommitCalls()).toHaveLength(0);
  });

  it("not_ancestor + commit=B → 200 · B 의 파일(커밋 하나는 한 번만 부른다)", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([], { relation: "not_ancestor" }));
    const body = await detailBody(`?service=backend&selected=selected-1&commit=${SHA_B}`);
    expect(body.data.commit.value.sha).toBe(SHA_B);
    expect(body.data.commit.value.files).toHaveLength(1);
    expect(masterCommitCalls()).toHaveLength(1);
  });

  it("not_ancestor + B 밖의 commit → 422 invalid_input(commit), 그 커밋은 부르지 않는다", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([], { relation: "not_ancestor" }));
    const response = await callDetail(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ success: false, error: { code: "invalid_input", field: "commit" } });
    expect(masterCommitCalls().some(([input]) => new URL(input).searchParams.get("sha") === SHA_MIDDLE)).toBe(false);
  });

  it("unknown + B 가 이력 밖 → commits 칸은 relation 을 남기고 빈 목록 · headFailure(not_in_history 404)", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([], { relation: "unknown", range_complete: false }));
    commitHandler = () => masterGitFailure(404, "commit_not_found");
    const body = await detailBody("?service=backend&selected=selected-1");
    expect(body.data.commits.value).toMatchObject({ relation: "unknown", commits: [], rangeFailure: null, headFailure: { ok: false, reason: "not_in_history", status: 404 } });
    expect(body.data.pullRequest.ok).toBe(true);
  });

  it("truncated · range_complete:false · body_truncated · files_truncated · patch_truncated 를 칸으로 낸다", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([gitCommitJson(SHA_B, { body: "긴 본문", body_truncated: true })], { truncated: true, range_complete: false }));
    commitHandler = (url) => masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [
      gitFileJson("big.ts", { patch: "@@ -1 +1 @@\n+x", patch_truncated: true }),
    ], { files_truncated: true }));
    const body = await detailBody(`?service=backend&selected=selected-1&commit=${SHA_B}`);
    expect(body.data.commits.value).toMatchObject({ hasMoreCommits: true, rangeComplete: false });
    expect(body.data.commits.value.commits[0]).toMatchObject({ message: `commit ${SHA_B.slice(0, 7)}\n\n긴 본문`, messageTruncated: true });
    expect(body.data.commit.value.hasMoreFiles).toBe(true);
    expect(body.data.commit.value.files[0].patch).toEqual({ kind: "text", text: "@@ -1 +1 @@\n+x", truncated: true, totalLines: null });
  });
});

describe("master git 실패 — 200 · 그 칸만 고정 이유 · 다른 구역은 그대로", () => {
  it.each([
    [404, "commit_not_found", "not_in_history"],
    [503, "repository_changing", "history_changing"],
    [429, "too_many_requests", "rate_limited"],
    [504, "git_timeout", "server_timeout"],
    [504, "agent_timeout", "server_timeout"],
    [502, "agent_unreachable", "bad_status"],
    [502, "agent_unauthorized", "bad_status"],
    [502, "unexpected_response", "bad_status"],
    [500, "git_failed", "bad_status"],
  ] as const)("커밋 목록 %d %s → rangeFailure = %s(상태 코드) + B 하나(commit=B 도 보인다), 요약 · PR 은 그대로, detail 원문 없음", async (status, code, reason) => {
    commitsHandler = () => masterGitFailure(status, code);
    const body = await detailBody(`?service=backend&selected=selected-1&commit=${SHA_B}`);
    expect(body.data.commits.ok).toBe(true);
    expect(body.data.commits.value.rangeFailure).toMatchObject({ ok: false, reason, status });
    expect(body.data.commits.value).toMatchObject({ relation: null, headFailure: null, htmlUrl: COMPARE_URL });
    expect(body.data.commits.value.commits.map((commit: { sha: string }) => commit.sha)).toEqual([SHA_B]);
    expect(body.data.commit.value.sha).toBe(SHA_B);
    expect(body.data.deployment.ok).toBe(true);
    expect(body.data.pullRequest.value).toMatchObject({ number: 12 });
    expect(masterCommitCalls()).toHaveLength(1);
    expect(githubCommitCalls()).toHaveLength(0);
    expectNoForbiddenText(body, [UPSTREAM_RAW_MARKER, "/srv/deploy", FAKE_DEPLOY_SECRET, "deploy-master.example.test"]);
  });

  it("커밋 목록 실패 + B 도 실패 → commits · commit 칸 = 범위의 실패(범위 실패 문구만), PR 은 그대로", async () => {
    commitsHandler = () => masterGitFailure(503, "repository_changing");
    commitHandler = () => masterGitFailure(404, "commit_not_found");
    const body = await detailBody(`?service=backend&selected=selected-1&commit=${SHA_B}`);
    expect(body.data.commits).toMatchObject({ ok: false, reason: "history_changing", status: 503 });
    expect(body.data.commit).toMatchObject({ ok: false, reason: "history_changing", status: 503 });
    expect(body.data.pullRequest.ok).toBe(true);
    expect(masterCommitCalls()).toHaveLength(1);
  });

  it.each([
    [404, "commit_not_found", "not_in_history"],
    [404, "parent_unavailable", "not_in_history"],
    [503, "repository_changing", "history_changing"],
  ] as const)("고른 커밋 %d %s → commit = %s, 목록 · PR 은 그대로", async (status, code, reason) => {
    commitHandler = () => masterGitFailure(status, code);
    const body = await detailBody(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    expect(body.data.commit).toMatchObject({ ok: false, reason, status });
    expect(body.data.commits.ok).toBe(true);
    expect(body.data.pullRequest.ok).toBe(true);
  });

  it("GitHub PR 실패(한도 초과) → pullRequest 만 실패, 커밋 목록 · 고른 커밋은 그대로", async () => {
    githubHandler = () => rateLimitedResponse(403);
    const body = await detailBody(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    expect(body.data.pullRequest).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(body.data.commits.ok).toBe(true);
    expect(body.data.commit.ok).toBe(true);
  });

  it("master 가 계약과 다른 꼴(relation 이 세 값 밖)을 주면 rangeFailure = unparseable + B 하나", async () => {
    commitsHandler = () => masterGitSuccess(gitCommitRangeJson([], { relation: "diverged" }));
    const body = await detailBody("?service=backend&selected=selected-1");
    expect(body.data.commits.value.rangeFailure).toMatchObject({ ok: false, reason: "unparseable" });
    expect(body.data.commits.value.commits.map((commit: { sha: string }) => commit.sha)).toEqual([SHA_B]);
  });

  it("실패한 git 조회는 앱 로그 1줄(B 로 물러서도 범위의 실패를 cell=commits 로 남긴다 — 이유 낱말 · 상태 코드만, master 주소 · 비밀값 · 원문 없음)", async () => {
    commitsHandler = () => masterGitFailure(503, "repository_changing");
    await callDetail("?service=backend&selected=selected-1");
    expect(consoleLines.some((line) => line.includes("cell=commits") && line.includes("upstream=history_changing") && line.includes("status=503"))).toBe(true);
    expectNoForbiddenText(consoleLines.join("\n"), [UPSTREAM_RAW_MARKER, FAKE_DEPLOY_SECRET, "deploy-master.example.test", "/srv/deploy"]);
  });
});

describe("입력 · 인증 · 선택 — 그대로(422 · 404 · 401), 그때 master git 을 부르지 않는다", () => {
  it("세션 없음 → 401, 아무 것도 부르지 않는다", async () => {
    state.cookieValue = undefined;
    expect((await callDetail(`?service=backend&selected=selected-1&commit=${SHA_B}`)).status).toBe(401);
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["잘못된 SHA", `?service=backend&selected=selected-1&commit=xyz123`, "commit"],
    ["허용 목록 밖 서비스", `?service=ci-cd&selected=selected-1`, "service"],
    ["잘못된 요청 ID", `?service=backend&selected=${encodeURIComponent("../x")}`, "selected"],
  ])("%s → 422 invalid_input(field), 호출 0회", async (_label, search, field) => {
    const response = await callDetail(search);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ success: false, error: { code: "invalid_input", field } });
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("목록 밖 commit → 422 invalid_input(commit), 그 커밋은 master 에서도 GitHub 에서도 부르지 않는다", async () => {
    const outside = fakeSha(99);
    const response = await callDetail(`?service=backend&selected=selected-1&commit=${outside}`);
    expect(response.status).toBe(422);
    expect(masterCommitCalls()).toHaveLength(0);
    expect(githubCommitCalls()).toHaveLength(0);
  });

  it("선택한 배포가 목록에 없음 → 404 not_found, master git · GitHub 를 부르지 않는다", async () => {
    const response = await callDetail("?service=backend&selected=missing-1");
    expect(response.status).toBe(404);
    expect(masterCommitsCalls()).toHaveLength(0);
    expect(masterCommitCalls()).toHaveLength(0);
    expect(githubCalls()).toHaveLength(0);
  });

  it("DEPLOY_SECRET 이 비면 not_configured — master git 도 부르지 않는다(새 설정 키 없음)", async () => {
    vi.stubEnv("DEPLOY_SECRET", "");
    const body = await detailBody("?service=backend&selected=selected-1");
    expect(body.data.deployment).toMatchObject({ ok: false, reason: "not_configured" });
    expect(networkFetch).not.toHaveBeenCalled();
  });
});

describe("캐시 — 요청 사이에 이어진다(SHA 로 정해지는 성공만)", () => {
  it("같은 요청 두 번 — ancestor · 온전 · 잘리지 않은 범위와 커밋 하나는 한 번씩(배포 이력은 매번)", async () => {
    await callDetail(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    await callDetail(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    expect(masterHistoryCalls()).toHaveLength(2);
    expect(masterCommitsCalls()).toHaveLength(1);
    expect(masterCommitCalls()).toHaveLength(1);
  });

  it.each([
    ["unknown", () => masterGitSuccess(gitCommitRangeJson([], { relation: "unknown", range_complete: false }))],
    ["not_ancestor", () => masterGitSuccess(gitCommitRangeJson([], { relation: "not_ancestor" }))],
    ["range_complete:false", () => masterGitSuccess(gitCommitRangeJson([gitCommitJson(SHA_B)], { range_complete: false }))],
    ["truncated", () => masterGitSuccess(gitCommitRangeJson([gitCommitJson(SHA_B)], { truncated: true }))],
    ["실패(repository_changing)", () => masterGitFailure(503, "repository_changing")],
  ] as [string, RoutedFetchHandler][])("범위 응답이 %s 면 저장하지 않는다 — 다음 요청이 다시 부른다", async (_label, handler) => {
    commitsHandler = handler;
    await callDetail("?service=backend&selected=selected-1");
    await callDetail("?service=backend&selected=selected-1");
    expect(masterCommitsCalls()).toHaveLength(2);
  });

  it("커밋 하나의 실패(not_in_history)는 저장하지 않는다", async () => {
    commitHandler = () => masterGitFailure(404, "commit_not_found");
    await callDetail(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    commitHandler = defaultCommitHandler;
    const body = await detailBody(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    expect(masterCommitCalls()).toHaveLength(2);
    expect(body.data.commit.ok).toBe(true);
  });
});
