/** GitHub 클라이언트 · 캐시 — 명세 §10.2 "호출마다 5초 제한, 재시도 없음" · "크기 상한 … 넘으면 더 있음 … 조용히 자르지 않는다" ·
 * "PR 본문 · 커밋 메시지 · diff 는 글자 그대로" · "캐시: SHA 로 정해지는 응답은 메모리에(상한 있음). PR 조회는 10분" · "GITHUB_TOKEN 은 선택" ·
 * 읽기 전용(GET 만) · 다른 서버의 응답은 필요한 칸만. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMIT_FILE_LIMIT, COMMIT_LIST_LIMIT, FILE_PATCH_LINE_LIMIT, GITHUB_API_BASE_URL, choosePullRequest, createGitHubClient,
  type GitHubClient, type PullRequestSummary,
} from "@/features/deploy-detail/lib/github-client";
import { PULL_REQUEST_CACHE_MILLISECONDS, createCachedGitHubClient } from "@/features/deploy-detail/lib/github-cache";
import {
  FAKE_GITHUB_API_URL, FAKE_GITHUB_TOKEN, REPOSITORY_WEB, TEST_REPOSITORY, fakeSha, githubCommitObject, githubCommitWithFiles,
  githubComparison, githubFile, githubPullRequest, githubResponse, patchWithLines, rateLimitedResponse,
} from "@/features/deploy-detail/lib/github-test-fakes";
import { UPSTREAM_FAILURE_MESSAGES } from "@/shared/lib/upstream-result";
import {
  UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal, expectFailure, expectNoForbiddenText, expectReadOnlyRequest,
  hangUntilAborted, headersOf, headersThenStalledBody, leakyNetworkError, okValue, track, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const SHA_A = fakeSha(1);
const SHA_B = fakeSha(2);
const FORBIDDEN = [UPSTREAM_RAW_MARKER, FAKE_GITHUB_TOKEN, "github-api.example.test"];

function clientWith(handler: RoutedFetchHandler, token: string | null = null) {
  const fetch = createRoutedFetch(handler);
  const client = createGitHubClient({ baseUrl: FAKE_GITHUB_API_URL, token, fetch });
  return { fetch, client };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("요청 — 경로 · 머리글 · 읽기 전용", () => {
  it("실제 기준 주소 상수는 api.github.com", () => {
    expect(GITHUB_API_BASE_URL).toBe("https://api.github.com");
  });

  it("비교: GET <base>/repos/{owner}/{repo}/compare/{A}...{B} · 쪽 나눔 인자 없음 · Accept · API 버전 · redirect manual", async () => {
    const { fetch, client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, [githubCommitObject(SHA_B)])));
    await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.origin).toBe(FAKE_GITHUB_API_URL);
    expect(url.pathname).toBe(`/repos/junhyeong9812/study-note-deploy-system-backend/compare/${SHA_A}...${SHA_B}`);
    expect([...url.searchParams]).toEqual([]);
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("Accept")).toBe("application/vnd.github+json");
    expect(headersOf(init).get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(init?.redirect).toBe("manual");
  });

  it("커밋 하나: GET <base>/repos/{owner}/{repo}/commits/{sha}?per_page=100(끝의 / 허용)", async () => {
    const fetch = createRoutedFetch(() => githubResponse(githubCommitWithFiles(SHA_B, [])));
    const client = createGitHubClient({ baseUrl: `${FAKE_GITHUB_API_URL}/`, token: null, fetch });
    await client.getCommit(TEST_REPOSITORY, SHA_B);
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.pathname).toBe(`/repos/junhyeong9812/study-note-deploy-system-backend/commits/${SHA_B}`);
    expect(url.searchParams.get("per_page")).toBe("100");
    expectReadOnlyRequest(init);
    expect(init?.redirect).toBe("manual");
  });

  it("PR: GET <base>/repos/{owner}/{repo}/commits/{sha}/pulls", async () => {
    const { fetch, client } = clientWith(() => githubResponse([]));
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    const [input, init] = fetch.mock.calls[0];
    expect(new URL(input).pathname).toBe(`/repos/junhyeong9812/study-note-deploy-system-backend/commits/${SHA_B}/pulls`);
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("Accept")).toBe("application/vnd.github+json");
  });

  it("토큰이 있으면 Authorization: Bearer <토큰>", async () => {
    const { fetch, client } = clientWith(() => githubResponse([]), FAKE_GITHUB_TOKEN);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(headersOf(fetch.mock.calls[0][1]).get("Authorization")).toBe(`Bearer ${FAKE_GITHUB_TOKEN}`);
  });

  it.each([null, ""])("토큰이 %j 면 Authorization 을 싣지 않는다", async (token) => {
    const { fetch, client } = clientWith(() => githubResponse([]), token);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(headersOf(fetch.mock.calls[0][1]).has("Authorization")).toBe(false);
  });

  it("다른 서버의 비밀 머리글은 싣지 않는다", async () => {
    const { fetch, client } = clientWith(() => githubResponse([]), FAKE_GITHUB_TOKEN);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    const headers = headersOf(fetch.mock.calls[0][1]);
    for (const name of ["X-Deploy-Secret", "X-Observe-Secret", "X-Alert-Secret", "Cookie"]) expect(headers.has(name)).toBe(false);
  });

  it("제한 시간 신호를 5000ms 로 만들어 넘긴다", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch(() => githubResponse([]));
    const client = createGitHubClient({ baseUrl: FAKE_GITHUB_API_URL, token: null, fetch, timeoutSignal: timeout.factory });
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(timeout.requestedMilliseconds).toEqual([5_000]);
    expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["abcdef", "g".repeat(40), "a".repeat(41), `${SHA_A}/../x`, `${SHA_A}...${SHA_B}`, ""])("SHA 인자 %j 가 형식 밖이면 부르지 않는다(invalid_input sha)", async (sha) => {
    const { fetch, client } = clientWith(() => githubResponse([]));
    for (const result of [
      await client.getCommit(TEST_REPOSITORY, sha), await client.listPullRequestsForCommit(TEST_REPOSITORY, sha),
      await client.compareCommits(TEST_REPOSITORY, sha, SHA_B), await client.compareCommits(TEST_REPOSITORY, SHA_A, sha),
    ]) {
      expectFailure(result, "invalid_input");
      expect(!result.ok && result.field).toBe("sha");
    }
    expect(fetch).toHaveBeenCalledTimes(0);
  });
});

describe("비교 — 필요한 칸만 · 시간순 · 갈라진 이력", () => {
  it("정상 — 커밋 요약(SHA · 제목 · 메시지 · 작성자 · 작성 시각 · 주소)만, 그 밖 칸은 버린다", async () => {
    const commits = [githubCommitObject(fakeSha(10), "feat: first\n\nbody line", "2026-11-22T01:00:00Z"), githubCommitObject(SHA_B, "fix: second", "2026-11-22T02:00:00Z")];
    const { client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, commits)));
    const comparison = okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B));
    expect(comparison).toStrictEqual({
      status: "ahead", aheadBy: 2, behindBy: 0, totalCommits: 2, hasMoreCommits: false,
      htmlUrl: `${REPOSITORY_WEB}/compare/${SHA_A}...${SHA_B}`,
      commits: [
        { sha: fakeSha(10), title: "feat: first", message: "feat: first\n\nbody line", authorName: "Jun", authoredAt: "2026-11-22T01:00:00Z", htmlUrl: `${REPOSITORY_WEB}/commit/${fakeSha(10)}` },
        { sha: SHA_B, title: "fix: second", message: "fix: second", authorName: "Jun", authoredAt: "2026-11-22T02:00:00Z", htmlUrl: `${REPOSITORY_WEB}/commit/${SHA_B}` },
      ],
    });
    expectNoForbiddenText(comparison, FORBIDDEN);
  });

  it("커밋 메시지는 글자 그대로(HTML · 마크다운 · 줄바꿈 해석 없음)", async () => {
    const message = "<script>alert(1)</script> **bold** &amp;\r\n\r\n- item\t탭";
    const { client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, [githubCommitObject(SHA_B, message)])));
    const comparison = okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B));
    expect(comparison.commits[0].message).toBe(message);
    expect(comparison.commits[0].title.startsWith("<script>alert(1)</script> **bold** &amp;")).toBe(true);
  });

  it("갈라진 이력 — status diverged 와 behind_by 를 그대로", async () => {
    const { client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, [githubCommitObject(SHA_B)], { status: "diverged", ahead_by: 1, behind_by: 3 })));
    const comparison = okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B));
    expect(comparison.status).toBe("diverged");
    expect(comparison.aheadBy).toBe(1);
    expect(comparison.behindBy).toBe(3);
  });

  it.each(["behind", "identical"])("status %s 도 그대로(커밋 0개)", async (status) => {
    const { client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, [], { status, ahead_by: 0, behind_by: status === "behind" ? 2 : 0 })));
    const comparison = okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B));
    expect(comparison.status).toBe(status);
    expect(comparison.commits).toEqual([]);
  });

  it("모르는 status → unparseable", async () => {
    const { client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, [], { status: `${UPSTREAM_RAW_MARKER}` })));
    expectFailure(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B), "unparseable");
  });

  it.each([
    ["commits 빠짐", (body: Record<string, unknown>) => { delete body.commits; }],
    ["total_commits 가 글자", (body: Record<string, unknown>) => { body.total_commits = "2"; }],
    ["커밋 하나의 sha 가 숫자", (body: Record<string, unknown>) => { (body.commits as Record<string, unknown>[])[0].sha = 12; }],
    ["커밋 하나의 commit.message 빠짐", (body: Record<string, unknown>) => { delete ((body.commits as Record<string, unknown>[])[0].commit as Record<string, unknown>).message; }],
    ["html_url 이 github.com 이 아님", (body: Record<string, unknown>) => { body.html_url = "javascript:alert(1)"; }],
    ["커밋 html_url 이 다른 호스트", (body: Record<string, unknown>) => { (body.commits as Record<string, unknown>[])[0].html_url = "https://evil.example.test/commit"; }],
  ])("꼴이 다르면 전체 unparseable — %s", async (_label, mutate) => {
    const body = githubComparison(SHA_A, SHA_B, [githubCommitObject(SHA_B)]) as Record<string, unknown>;
    mutate(body);
    const { client } = clientWith(() => githubResponse(body));
    expectFailure(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B), "unparseable");
  });

  it("commit.author 가 null 이면 작성자 · 시각 null", async () => {
    const commit = githubCommitObject(SHA_B);
    (commit.commit as Record<string, unknown>).author = null;
    const { client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, [commit])));
    const comparison = okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B));
    expect(comparison.commits[0].authorName).toBeNull();
    expect(comparison.commits[0].authoredAt).toBeNull();
  });
});

describe("상한 — 커밋 100개(경계)", () => {
  function commitsOf(count: number) {
    return Array.from({ length: count }, (_, index) => githubCommitObject(fakeSha(100 + index)));
  }

  it("상한 상수", () => {
    expect(COMMIT_LIST_LIMIT).toBe(100);
    expect(COMMIT_FILE_LIMIT).toBe(100);
    expect(FILE_PATCH_LINE_LIMIT).toBe(500);
  });

  it("정확히 100개 — 전부, 더 있음 아님", async () => {
    const { client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, commitsOf(100))));
    const comparison = okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B));
    expect(comparison.commits).toHaveLength(100);
    expect(comparison.hasMoreCommits).toBe(false);
    expect(comparison.totalCommits).toBe(100);
  });

  it("101개 — 마지막(가장 최근) 100개를 남기고 더 있음 + 비교 주소", async () => {
    const commits = commitsOf(101);
    const { client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, commits)));
    const comparison = okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B));
    expect(comparison.commits).toHaveLength(100);
    expect(comparison.commits[0].sha).toBe(fakeSha(101));
    expect(comparison.commits[99].sha).toBe(fakeSha(200));
    expect(comparison.hasMoreCommits).toBe(true);
    expect(comparison.totalCommits).toBe(101);
    expect(comparison.htmlUrl).toBe(`${REPOSITORY_WEB}/compare/${SHA_A}...${SHA_B}`);
  });

  it("GitHub 가 250개만 주고 total_commits 가 더 크면(300) — 100개 · 더 있음 · 전체 수 300", async () => {
    const { client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, commitsOf(250), { total_commits: 300, ahead_by: 300 })));
    const comparison = okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B));
    expect(comparison.commits).toHaveLength(100);
    expect(comparison.hasMoreCommits).toBe(true);
    expect(comparison.totalCommits).toBe(300);
  });

  it("받은 것은 100개 이하인데 total_commits 가 더 크면 더 있음", async () => {
    const { client } = clientWith(() => githubResponse(githubComparison(SHA_A, SHA_B, commitsOf(100), { total_commits: 101 })));
    const comparison = okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B));
    expect(comparison.commits).toHaveLength(100);
    expect(comparison.hasMoreCommits).toBe(true);
  });
});

describe("커밋 하나 — 파일 · patch", () => {
  it("정상 — 파일 이름 · 이전 이름 · status · 더한/뺀 줄 · patch 만(blob_url · raw_url · sha 버림), 메시지 · 주소", async () => {
    const files = [
      githubFile("src/a.ts", { patch: "@@ -1,2 +1,2 @@\n-old\n+new\n context" }),
      githubFile("src/b.ts", { status: "renamed", previous_filename: "src/old-b.ts", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }),
    ];
    const { client } = clientWith(() => githubResponse(githubCommitWithFiles(SHA_B, files, "feat: x\n\n본문")));
    const detail = okValue(await client.getCommit(TEST_REPOSITORY, SHA_B));
    expect(detail).toStrictEqual({
      sha: SHA_B, title: "feat: x", message: "feat: x\n\n본문", authorName: "Jun", authoredAt: "2026-11-22T01:00:00Z",
      htmlUrl: `${REPOSITORY_WEB}/commit/${SHA_B}`, hasMoreFiles: false,
      files: [
        { filename: "src/a.ts", previousFilename: null, status: "modified", additions: 1, deletions: 1,
          patch: { kind: "text", text: "@@ -1,2 +1,2 @@\n-old\n+new\n context", truncated: false, totalLines: 4 } },
        { filename: "src/b.ts", previousFilename: "src/old-b.ts", status: "renamed", additions: 1, deletions: 1,
          patch: { kind: "text", text: "@@ -1 +1 @@\n-a\n+b", truncated: false, totalLines: 3 } },
      ],
    });
    expectNoForbiddenText(detail, FORBIDDEN);
  });

  it("patch 가 없는 파일(바이너리 · 너무 큼)은 unavailable 로 구분", async () => {
    const binary = githubFile("image.png", { status: "added", additions: 0, deletions: 0 });
    delete (binary as Record<string, unknown>).patch;
    const { client } = clientWith(() => githubResponse(githubCommitWithFiles(SHA_B, [binary, githubFile("huge.json", { patch: null })])));
    const detail = okValue(await client.getCommit(TEST_REPOSITORY, SHA_B));
    expect(detail.files.map((file) => file.patch)).toEqual([{ kind: "unavailable" }, { kind: "unavailable" }]);
  });

  it("patch 는 글자 그대로(HTML · 제어 문자 · 탭 · \\r 해석 없음)", async () => {
    const patch = "@@ -1 +1 @@\n-<div>&amp;</div>\r\n+<script>x</script>\t\u0000끝";
    const { client } = clientWith(() => githubResponse(githubCommitWithFiles(SHA_B, [githubFile("a.html", { patch })])));
    const detail = okValue(await client.getCommit(TEST_REPOSITORY, SHA_B));
    expect(detail.files[0].patch).toEqual({ kind: "text", text: patch, truncated: false, totalLines: 3 });
  });

  it("파일 status 가 열거 밖이면 unparseable", async () => {
    const { client } = clientWith(() => githubResponse(githubCommitWithFiles(SHA_B, [githubFile("a.ts", { status: "exploded" })])));
    expectFailure(await client.getCommit(TEST_REPOSITORY, SHA_B), "unparseable");
  });

  it("files 칸이 없으면 unparseable", async () => {
    const body = githubCommitWithFiles(SHA_B, []) as Record<string, unknown>;
    delete body.files;
    const { client } = clientWith(() => githubResponse(body));
    expectFailure(await client.getCommit(TEST_REPOSITORY, SHA_B), "unparseable");
  });
});

describe("상한 — 파일 100개 · patch 500줄(경계)", () => {
  function filesOf(count: number) {
    return Array.from({ length: count }, (_, index) => githubFile(`file-${index}.ts`));
  }

  it("파일 정확히 100개 · Link 없음 — 전부, 더 있음 아님", async () => {
    const { client } = clientWith(() => githubResponse(githubCommitWithFiles(SHA_B, filesOf(100))));
    const detail = okValue(await client.getCommit(TEST_REPOSITORY, SHA_B));
    expect(detail.files).toHaveLength(100);
    expect(detail.hasMoreFiles).toBe(false);
  });

  it("파일 101개 — 앞 100개 · 더 있음 · 커밋 주소", async () => {
    const { client } = clientWith(() => githubResponse(githubCommitWithFiles(SHA_B, filesOf(101))));
    const detail = okValue(await client.getCommit(TEST_REPOSITORY, SHA_B));
    expect(detail.files).toHaveLength(100);
    expect(detail.files[0].filename).toBe("file-0.ts");
    expect(detail.files[99].filename).toBe("file-99.ts");
    expect(detail.hasMoreFiles).toBe(true);
    expect(detail.htmlUrl).toBe(`${REPOSITORY_WEB}/commit/${SHA_B}`);
  });

  it("파일 100개 + Link 머리글에 rel=\"next\" — 더 있음", async () => {
    const link = `<${FAKE_GITHUB_API_URL}/repos/x/y/commits/${SHA_B}?per_page=100&page=2>; rel="next", <${FAKE_GITHUB_API_URL}/repos/x/y/commits/${SHA_B}?per_page=100&page=3>; rel="last"`;
    const { client } = clientWith(() => githubResponse(githubCommitWithFiles(SHA_B, filesOf(100)), 200, { link }));
    const detail = okValue(await client.getCommit(TEST_REPOSITORY, SHA_B));
    expect(detail.files).toHaveLength(100);
    expect(detail.hasMoreFiles).toBe(true);
    expectNoForbiddenText(detail, FORBIDDEN);
  });

  it("patch 정확히 500줄 — 그대로, 잘리지 않음", async () => {
    const patch = patchWithLines(500);
    const { client } = clientWith(() => githubResponse(githubCommitWithFiles(SHA_B, [githubFile("a.ts", { patch })])));
    const detail = okValue(await client.getCommit(TEST_REPOSITORY, SHA_B));
    expect(detail.files[0].patch).toEqual({ kind: "text", text: patch, truncated: false, totalLines: 500 });
  });

  it("patch 501줄 — 앞 500줄 · truncated · 전체 줄 수", async () => {
    const patch = patchWithLines(501);
    const { client } = clientWith(() => githubResponse(githubCommitWithFiles(SHA_B, [githubFile("a.ts", { patch })])));
    const detail = okValue(await client.getCommit(TEST_REPOSITORY, SHA_B));
    expect(detail.files[0].patch).toEqual({ kind: "text", text: patch.split("\n").slice(0, 500).join("\n"), truncated: true, totalLines: 501 });
  });
});

describe("PR — 필요한 칸만 · 병합된 것 우선", () => {
  it("번호 · 제목 · 본문(글자 그대로) · 상태 · 병합 시각 · 주소만", async () => {
    const body = "## 제목\r\n<img src=x onerror=alert(1)>\n- [ ] 할 일";
    const { client } = clientWith(() => githubResponse([githubPullRequest(12, { body, title: "<b>feat</b>" })]));
    const pullRequests = okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B));
    expect(pullRequests).toStrictEqual([{
      number: 12, title: "<b>feat</b>", body, state: "closed", mergedAt: "2026-11-22T00:00:00Z", htmlUrl: `${REPOSITORY_WEB}/pull/12`,
    }]);
    expectNoForbiddenText(pullRequests, FORBIDDEN);
  });

  it("PR 없음 — 빈 목록", async () => {
    const { client } = clientWith(() => githubResponse([]));
    expect(okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B))).toEqual([]);
  });

  it("본문이 null 이면 null · 병합 안 됐으면 mergedAt null", async () => {
    const { client } = clientWith(() => githubResponse([githubPullRequest(3, { body: null, merged_at: null, state: "open" })]));
    const [pullRequest] = okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B));
    expect(pullRequest.body).toBeNull();
    expect(pullRequest.mergedAt).toBeNull();
    expect(pullRequest.state).toBe("open");
  });

  it.each([
    ["배열이 아님", { message: "x" }],
    ["number 가 글자", [githubPullRequest(1, { number: "1" })]],
    ["state 가 열거 밖", [githubPullRequest(1, { state: "merged" })]],
    ["html_url 이 github.com 이 아님", [githubPullRequest(1, { html_url: "http://github.com.evil.example.test/pull/1" })]],
  ])("꼴이 다르면 unparseable — %s", async (_label, body) => {
    const { client } = clientWith(() => githubResponse(body));
    expectFailure(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B), "unparseable");
  });

  const open = (number: number): PullRequestSummary => ({ number, title: `t${number}`, body: null, state: "open", mergedAt: null, htmlUrl: `${REPOSITORY_WEB}/pull/${number}` });
  const merged = (number: number): PullRequestSummary => ({ ...open(number), state: "closed", mergedAt: "2026-11-22T00:00:00Z" });

  it("choosePullRequest — 여럿이면 병합된 것 우선(GitHub 순서의 첫 병합)", () => {
    expect(choosePullRequest([open(1), merged(2), merged(3)])?.number).toBe(2);
  });

  it("choosePullRequest — 병합된 것이 없으면 첫 번째 · 빈 목록이면 null", () => {
    expect(choosePullRequest([open(5), open(6)])?.number).toBe(5);
    expect(choosePullRequest([])).toBeNull();
  });
});

describe("실패 — 한도 초과 · 없는 SHA · 5xx · 리다이렉트 · 깨진 JSON · 연결 실패 · 시간 초과(재시도 없음)", () => {
  type Call = (client: GitHubClient) => Promise<{ ok: boolean }>;
  const calls: [string, Call][] = [
    ["compare", (client) => client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B)],
    ["commit", (client) => client.getCommit(TEST_REPOSITORY, SHA_B)],
    ["pulls", (client) => client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B)],
  ];

  for (const [name, call] of calls) {
    it.each([403, 429] as const)(`${name}: %d + x-ratelimit-remaining: 0 → rate_limited(한 번만 부른다)`, async (status) => {
      const { fetch, client } = clientWith(() => rateLimitedResponse(status), FAKE_GITHUB_TOKEN);
      const result = await call(client) as Parameters<typeof expectFailure>[0];
      expectFailure(result, "rate_limited", status);
      expect(!result.ok && result.message).toBe("한도 초과");
      expectNoForbiddenText(result, FORBIDDEN);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${name}: 403 + retry-after(2차 한도) → rate_limited`, async () => {
      const { client } = clientWith(() => githubResponse({ message: "secondary" }, 403, { "retry-after": "60" }));
      expectFailure(await call(client) as Parameters<typeof expectFailure>[0], "rate_limited", 403);
    });

    it(`${name}: 한도 머리글 없는 403 → bad_status(한도 초과가 아니다)`, async () => {
      const { client } = clientWith(() => githubResponse({ message: `forbidden ${UPSTREAM_RAW_MARKER}` }, 403));
      expectFailure(await call(client) as Parameters<typeof expectFailure>[0], "bad_status", 403);
    });

    it.each([404, 422])(`${name}: %d(없는 SHA · 저장소) → not_found`, async (status) => {
      const { client } = clientWith(() => githubResponse({ message: `No commit found for SHA: ${UPSTREAM_RAW_MARKER}` }, status));
      const result = await call(client) as Parameters<typeof expectFailure>[0];
      expectFailure(result, "not_found", status);
      expect(!result.ok && result.message).toBe("찾을 수 없음");
    });

    it.each([
      [500, "bad_status"], [502, "bad_status"], [503, "unavailable"], [504, "server_timeout"], [401, "unauthorized"],
    ])(`${name}: %d → %s(원문 없음, 재시도 없음)`, async (status, reason) => {
      const { fetch, client } = clientWith(() => githubResponse(`<html>${UPSTREAM_RAW_MARKER} ${FAKE_GITHUB_TOKEN}</html>`, status), FAKE_GITHUB_TOKEN);
      const result = await call(client) as Parameters<typeof expectFailure>[0];
      expectFailure(result, reason, status);
      expectNoForbiddenText(result, FORBIDDEN);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([301, 302, 307])(`${name}: 리다이렉트 %d → 따라가지 않고 bad_status`, async (status) => {
      const { fetch, client } = clientWith(() => new Response(null, { status, headers: { location: "https://evil.example.test/repos" } }));
      expectFailure(await call(client) as Parameters<typeof expectFailure>[0], "bad_status", status);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${name}: 깨진 JSON → unparseable`, async () => {
      const { client } = clientWith(() => githubResponse(`{"sha":"${UPSTREAM_RAW_MARKER}`));
      expectFailure(await call(client) as Parameters<typeof expectFailure>[0], "unparseable");
    });

    it(`${name}: 연결 실패 → unreachable(예외 문구 없음)`, async () => {
      const { fetch, client } = clientWith(() => { throw leakyNetworkError(); });
      expectFailure(await call(client) as Parameters<typeof expectFailure>[0], "unreachable");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${name}: 응답하지 않으면 5초에 timeout(재시도 없음)`, async () => {
      vi.useFakeTimers();
      const timeout = createTimerTimeoutSignal();
      const fetch = createRoutedFetch((_url, init) => hangUntilAborted(init));
      const client = createGitHubClient({ baseUrl: FAKE_GITHUB_API_URL, token: null, fetch, timeoutSignal: timeout.factory });
      const pending = track(call(client));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(pending.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(pending.settled).toBe(true);
      expectFailure(pending.value as Parameters<typeof expectFailure>[0], "timeout");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${name}: 머리글만 주고 본문을 끝내지 않으면 5초에 timeout`, async () => {
      vi.useFakeTimers();
      const timeout = createTimerTimeoutSignal();
      const fetch = createRoutedFetch((_url, init) => headersThenStalledBody(init));
      const client = createGitHubClient({ baseUrl: FAKE_GITHUB_API_URL, token: null, fetch, timeoutSignal: timeout.factory });
      const pending = track(call(client));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pending.settled).toBe(true);
      expectFailure(pending.value as Parameters<typeof expectFailure>[0], "timeout");
    });
  }

  it("새 실패 이유의 화면 글자는 고정 표에 있고 비밀 · 주소가 없다", () => {
    expect(UPSTREAM_FAILURE_MESSAGES.rate_limited).toBe("한도 초과");
    expect(UPSTREAM_FAILURE_MESSAGES.not_found).toBe("찾을 수 없음");
    for (const message of Object.values(UPSTREAM_FAILURE_MESSAGES)) expectNoForbiddenText(message, FORBIDDEN);
  });
});

describe("캐시 — SHA 로 정해지는 응답 · PR 10분 · 실패는 저장 안 함 · 상한", () => {
  function cachedClientWith(handler: RoutedFetchHandler, options: { maximumEntries?: number } = {}) {
    let now = 1_763_800_000_000;
    const fetch = createRoutedFetch(handler);
    const inner = createGitHubClient({ baseUrl: FAKE_GITHUB_API_URL, token: null, fetch });
    const client = createCachedGitHubClient(inner, { clock: () => now, ...options });
    return { fetch, client, advance: (milliseconds: number) => { now += milliseconds; } };
  }

  function defaultHandler(url: URL): Response {
    if (url.pathname.includes("/compare/")) return githubResponse(githubComparison(SHA_A, SHA_B, [githubCommitObject(SHA_B)]));
    if (url.pathname.endsWith("/pulls")) return githubResponse([githubPullRequest(12)]);
    const sha = url.pathname.split("/").pop()!;
    return githubResponse(githubCommitWithFiles(sha, [githubFile("a.ts")]));
  }

  it("PR 캐시 수명 상수는 10분", () => {
    expect(PULL_REQUEST_CACHE_MILLISECONDS).toBe(600_000);
  });

  it("비교 · 커밋 하나 — 같은 SHA 의 두 번째는 부르지 않는다(시간이 많이 지나도)", async () => {
    const { fetch, client, advance } = cachedClientWith(defaultHandler);
    const firstComparison = okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B));
    const firstCommit = okValue(await client.getCommit(TEST_REPOSITORY, SHA_B));
    advance(24 * 60 * 60 * 1000);
    expect(okValue(await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B))).toEqual(firstComparison);
    expect(okValue(await client.getCommit(TEST_REPOSITORY, SHA_B))).toEqual(firstCommit);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("열쇠는 저장소 · SHA 별 — 다른 SHA · 다른 저장소 · 비교 방향이 다르면 새로 부른다", async () => {
    const { fetch, client } = cachedClientWith(defaultHandler);
    await client.getCommit(TEST_REPOSITORY, SHA_B);
    await client.getCommit(TEST_REPOSITORY, SHA_A);
    await client.getCommit({ owner: "junhyeong9812", name: "study-note-deploy-system-front" }, SHA_B);
    await client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B);
    await client.compareCommits(TEST_REPOSITORY, SHA_B, SHA_A);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("PR — 10분 안에는 적중, 10분이 되는 순간부터 다시 부른다", async () => {
    const { fetch, client, advance } = cachedClientWith(defaultHandler);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    advance(PULL_REQUEST_CACHE_MILLISECONDS - 1);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(1);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("PR 없음(빈 목록)도 성공이므로 10분 저장", async () => {
    const { fetch, client } = cachedClientWith(() => githubResponse([]));
    expect(okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B))).toEqual([]);
    expect(okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B))).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["한도 초과", () => rateLimitedResponse(403)],
    ["5xx", () => githubResponse("oops", 500)],
    ["깨진 JSON", () => githubResponse("{")],
    ["없는 SHA", () => githubResponse({ message: "No commit found" }, 422)],
  ])("실패(%s)는 저장하지 않는다 — 다음 요청이 다시 부르고, 성공하면 그때부터 저장", async (_label, makeFailure) => {
    let failing = true;
    const { fetch, client } = cachedClientWith((url) => (failing ? makeFailure() : defaultHandler(url)));
    for (const call of [
      () => client.getCommit(TEST_REPOSITORY, SHA_B), () => client.compareCommits(TEST_REPOSITORY, SHA_A, SHA_B),
      () => client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B),
    ]) {
      failing = true;
      fetch.mockClear();
      expect((await call()).ok).toBe(false);
      failing = false;
      expect((await call()).ok).toBe(true);
      expect((await call()).ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("상한 — 항목 수가 넘으면 가장 오래된 것부터 버린다(최근 것은 남는다)", async () => {
    const { fetch, client } = cachedClientWith(defaultHandler, { maximumEntries: 3 });
    for (const index of [1, 2, 3, 4]) await client.getCommit(TEST_REPOSITORY, fakeSha(index));
    expect(fetch).toHaveBeenCalledTimes(4);
    await client.getCommit(TEST_REPOSITORY, fakeSha(4));
    expect(fetch).toHaveBeenCalledTimes(4);   // 가장 최근 것은 적중
    await client.getCommit(TEST_REPOSITORY, fakeSha(1));
    expect(fetch).toHaveBeenCalledTimes(5);   // 가장 오래된 것은 버려졌다
  });

  it("상한 — PR 저장소에도 같은 상한", async () => {
    const { fetch, client } = cachedClientWith(defaultHandler, { maximumEntries: 2 });
    for (const index of [1, 2, 3]) await client.listPullRequestsForCommit(TEST_REPOSITORY, fakeSha(index));
    await client.listPullRequestsForCommit(TEST_REPOSITORY, fakeSha(3));
    expect(fetch).toHaveBeenCalledTimes(3);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, fakeSha(1));
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("캐시를 거쳐도 값은 원래 클라이언트와 같다(필요한 칸만)", async () => {
    const { client } = cachedClientWith(defaultHandler);
    const detail = okValue(await client.getCommit(TEST_REPOSITORY, SHA_B));
    expect(Object.keys(detail).sort()).toEqual(["authorName", "authoredAt", "files", "hasMoreFiles", "htmlUrl", "message", "sha", "title"]);
  });
});
