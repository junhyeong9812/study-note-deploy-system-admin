/** 테스트 전용 — GitHub REST API 의 실제 응답 꼴(docs.github.com/rest/commits, apiVersion 2022-11-28)을 본뜬 가짜.
 * 주소는 문서용 도메인(.test), 토큰은 명백한 가짜. 화면에 넘기지 않아야 하는 칸에는 UPSTREAM_RAW_MARKER 를 넣는다. */
import type { GitHubRepository } from "@/features/deploy-detail/lib/github-repository";
import { UPSTREAM_RAW_MARKER } from "@/shared/lib/upstream-test-fakes";

export const FAKE_GITHUB_API_URL = "https://github-api.example.test";
export const FAKE_GITHUB_TOKEN = "fake-github-token-marker-g74";
export const TEST_REPOSITORY: GitHubRepository = { owner: "junhyeong9812", name: "study-note-deploy-system-backend" };
export const REPOSITORY_WEB = "https://github.com/junhyeong9812/study-note-deploy-system-backend";

/** n 번째 가짜 SHA(40자 16진수). */
export function fakeSha(index: number): string {
  return index.toString(16).padStart(8, "0").repeat(5);
}

export function githubCommitObject(sha: string, message = `commit ${sha.slice(0, 7)}`, date = "2026-11-22T01:00:00Z") {
  return {
    sha,
    node_id: `${UPSTREAM_RAW_MARKER}-node`,
    commit: {
      author: { name: "Jun", email: `${UPSTREAM_RAW_MARKER}@example.test`, date },
      committer: { name: "GitHub", email: `${UPSTREAM_RAW_MARKER}-committer@example.test`, date },
      message,
      tree: { sha: fakeSha(9999), url: `${FAKE_GITHUB_API_URL}/tree` },
      url: `${FAKE_GITHUB_API_URL}/repos/x/y/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
    },
    url: `${FAKE_GITHUB_API_URL}/repos/x/y/commits/${sha}`,
    html_url: `${REPOSITORY_WEB}/commit/${sha}`,
    comments_url: `${FAKE_GITHUB_API_URL}/comments`,
    author: { login: `${UPSTREAM_RAW_MARKER}-login`, id: 1 },
    committer: { login: "web-flow", id: 2 },
    parents: [{ sha: fakeSha(8888), url: `${FAKE_GITHUB_API_URL}/p`, html_url: `${REPOSITORY_WEB}/commit/${fakeSha(8888)}` }],
  };
}

export function githubFile(filename: string, overrides: Record<string, unknown> = {}) {
  return {
    sha: fakeSha(7777),
    filename,
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    blob_url: `${REPOSITORY_WEB}/blob/${fakeSha(1)}/${filename}`,
    raw_url: `${REPOSITORY_WEB}/raw/${fakeSha(1)}/${filename}`,
    contents_url: `${FAKE_GITHUB_API_URL}/contents/${filename}`,
    patch: "@@ -1 +1 @@\n-old\n+new",
    ...overrides,
  };
}

export function githubCommitWithFiles(sha: string, files: unknown[], message?: string) {
  return { ...githubCommitObject(sha, message), stats: { total: 2, additions: 1, deletions: 1 }, files };
}

export function githubComparison(baseSha: string, headSha: string, commits: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    url: `${FAKE_GITHUB_API_URL}/repos/x/y/compare/${baseSha}...${headSha}`,
    html_url: `${REPOSITORY_WEB}/compare/${baseSha}...${headSha}`,
    permalink_url: `${REPOSITORY_WEB}/compare/x...y`,
    diff_url: `${REPOSITORY_WEB}/compare/${baseSha}...${headSha}.diff`,
    patch_url: `${REPOSITORY_WEB}/compare/${baseSha}...${headSha}.patch`,
    base_commit: githubCommitObject(baseSha),
    merge_base_commit: githubCommitObject(baseSha),
    status: "ahead",
    ahead_by: commits.length,
    behind_by: 0,
    total_commits: commits.length,
    commits,
    files: [githubFile(`${UPSTREAM_RAW_MARKER}.txt`)],
    ...overrides,
  };
}

export function githubPullRequest(number: number, overrides: Record<string, unknown> = {}) {
  return {
    url: `${FAKE_GITHUB_API_URL}/repos/x/y/pulls/${number}`,
    id: 1000 + number,
    node_id: `${UPSTREAM_RAW_MARKER}-pr-node`,
    html_url: `${REPOSITORY_WEB}/pull/${number}`,
    number,
    state: "closed",
    locked: false,
    title: `PR ${number}`,
    user: { login: `${UPSTREAM_RAW_MARKER}-user`, id: 3 },
    body: `body ${number}`,
    created_at: "2026-11-21T00:00:00Z",
    updated_at: "2026-11-22T00:00:00Z",
    closed_at: "2026-11-22T00:00:00Z",
    merged_at: "2026-11-22T00:00:00Z",
    merge_commit_sha: fakeSha(number),
    head: { ref: `${UPSTREAM_RAW_MARKER}-branch`, sha: fakeSha(number + 1) },
    base: { ref: "main", sha: fakeSha(number + 2) },
    draft: false,
    ...overrides,
  };
}

/** GitHub 응답 — 머리글(x-ratelimit-* · link 등)을 함께 준다. */
export function githubResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8", "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59",
      "x-ratelimit-reset": "1763805600", "x-github-api-version-selected": "2022-11-28", ...headers,
    },
  });
}

/** 1차 한도 초과(문서의 꼴 — 403 또는 429, x-ratelimit-remaining: 0). 본문에 원문 표식. */
export function rateLimitedResponse(status: 403 | 429): Response {
  return githubResponse({ message: `API rate limit exceeded ${UPSTREAM_RAW_MARKER}`, documentation_url: "https://docs.github.com/rest" }, status, {
    "x-ratelimit-remaining": "0",
  });
}

/** n 줄짜리 patch(`\n` 으로 이은 n 줄). */
export function patchWithLines(count: number): string {
  const lines = ["@@ -1,1 +1,1 @@"];
  for (let index = 1; index < count; index += 1) lines.push(`+line ${index}`);
  return lines.slice(0, count).join("\n");
}
