/** master git 조회 클라이언트 — 명세 §12.2 "어드민: 커밋 목록 · diff 를 GitHub 대신 master 의 두 경로에서" · 12.7 relation · 오류 사상 ·
 * 12.8 unknown · agent_unauthorized · 12.9 repository_changing · §10.2 상한 · 글자 그대로 · 5초 · 재시도 없음.
 * 가짜 master(전역 fetch 아님 — 클라이언트에 주입)로 요청 꼴 · 해석 · 상한 · 실패 이유 · 캐시를 본다. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPLOY_GIT_CACHE_MAXIMUM_ENTRIES, DEPLOY_GIT_COMMITS_PATH, DEPLOY_GIT_COMMIT_PATH, GIT_COMMIT_FILE_LIMIT, GIT_COMMIT_LIST_LIMIT,
  GIT_FILE_PATCH_LINE_LIMIT, createCachedDeployGitClient, createDeployGitClient, type DeployGitClient,
} from "@/features/deploy-detail/lib/deploy-git-client";
import {
  gitCommitDetailJson, gitCommitJson, gitCommitRangeJson, gitFileJson, gitPatchWithLines, masterGitFailure, masterGitSuccess, masterRouteMissing, patchLines,
} from "@/features/deploy-detail/lib/deploy-git-test-fakes";
import { fakeSha } from "@/features/deploy-detail/lib/github-test-fakes";
import { UPSTREAM_FAILURE_MESSAGES, type UpstreamResult } from "@/shared/lib/upstream-result";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal, expectFailure,
  expectNoForbiddenText, expectReadOnlyRequest, hangUntilAborted, headersOf, headersThenStalledBody, jsonBody, okValue, textResponse, track,
  type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const SHA_A = fakeSha(1);
const SHA_B = fakeSha(2);
const SHA_MIDDLE = fakeSha(3);
/** 글자가 섞인 SHA — 대문자로 바꾸면 실제로 달라진다(fakeSha 는 숫자뿐이라 대소문자 사례에 못 쓴다). */
const SHA_WITH_LETTERS = "ab".repeat(20);
const SHA_WITH_LETTERS_OTHER = "cd".repeat(20);
const SHA_WITH_LETTERS_THIRD = "ef".repeat(20);

function defaultHandler(url: URL): Response {
  if (url.pathname === DEPLOY_GIT_COMMITS_PATH) return masterGitSuccess(gitCommitRangeJson([gitCommitJson(SHA_B), gitCommitJson(SHA_MIDDLE)]));
  if (url.pathname === DEPLOY_GIT_COMMIT_PATH) return masterGitSuccess(gitCommitDetailJson(url.searchParams.get("sha") ?? "", [gitFileJson("src/a.ts")]));
  throw new Error(`unexpected path ${url.pathname}`);
}

function setup(handler: RoutedFetchHandler = defaultHandler, baseUrl = FAKE_DEPLOY_MASTER_URL) {
  const fetch = createRoutedFetch(handler);
  const timeout = createTimerTimeoutSignal();
  const client = createDeployGitClient({ baseUrl, secret: FAKE_DEPLOY_SECRET, fetch, timeoutSignal: timeout.factory });
  return { fetch, client, timeout };
}

/** 커밋 목록 응답만 바꾼다. */
function rangeHandler(data: unknown): RoutedFetchHandler {
  return (url) => (url.pathname === DEPLOY_GIT_COMMITS_PATH ? masterGitSuccess(data) : defaultHandler(url));
}

/** 커밋 하나 응답만 바꾼다. */
function detailHandler(data: unknown): RoutedFetchHandler {
  return (url) => (url.pathname === DEPLOY_GIT_COMMIT_PATH ? masterGitSuccess(data) : defaultHandler(url));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("요청 — 경로 · 인자 · 머리글 · 읽기 전용", () => {
  it("경로 상수", () => {
    expect(DEPLOY_GIT_COMMITS_PATH).toBe("/deploys/git/commits");
    expect(DEPLOY_GIT_COMMIT_PATH).toBe("/deploys/git/commit");
  });

  it("커밋 목록: GET <master>/deploys/git/commits?service=&from=<A>&to=<B> · X-Deploy-Secret · redirect manual · 한 번만", async () => {
    const { fetch, client } = setup();
    await client.listCommits("backend", SHA_A, SHA_B);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    expect(input).toBe(`${FAKE_DEPLOY_MASTER_URL}/deploys/git/commits?service=backend&from=${SHA_A}&to=${SHA_B}`);
    expectReadOnlyRequest(init);
    expect(init?.redirect).toBe("manual");
    expect(headersOf(init).get("X-Deploy-Secret")).toBe(FAKE_DEPLOY_SECRET);
    expect(headersOf(init).has("Authorization")).toBe(false);
  });

  it("커밋 하나: GET <master>/deploys/git/commit?service=&sha= (기준 주소 끝의 / 허용)", async () => {
    const { fetch, client } = setup(defaultHandler, `${FAKE_DEPLOY_MASTER_URL}/`);
    await client.getCommit("admin", SHA_MIDDLE);
    const [input, init] = fetch.mock.calls[0];
    expect(input).toBe(`${FAKE_DEPLOY_MASTER_URL}/deploys/git/commit?service=admin&sha=${SHA_MIDDLE}`);
    expectReadOnlyRequest(init);
    expect(init?.redirect).toBe("manual");
    expect(headersOf(init).get("X-Deploy-Secret")).toBe(FAKE_DEPLOY_SECRET);
  });

  it("SHA 는 소문자로 바꿔 보낸다(master 는 소문자 16진수만 받는다)", async () => {
    const { fetch, client } = setup();
    await client.listCommits("backend", SHA_WITH_LETTERS.toUpperCase(), SHA_WITH_LETTERS_OTHER.toUpperCase());
    await client.getCommit("backend", SHA_WITH_LETTERS_THIRD.toUpperCase());
    const [listUrl, commitUrl] = fetch.mock.calls.map(([input]) => new URL(input));
    expect(listUrl.searchParams.get("from")).toBe(SHA_WITH_LETTERS);
    expect(listUrl.searchParams.get("to")).toBe(SHA_WITH_LETTERS_OTHER);
    expect(commitUrl.searchParams.get("sha")).toBe(SHA_WITH_LETTERS_THIRD);
  });

  it("제한 시간 신호를 5000ms 로 만들어 넘긴다", async () => {
    const { fetch, client, timeout } = setup();
    await client.getCommit("backend", SHA_B);
    expect(timeout.requestedMilliseconds).toEqual([5000]);
    expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["abcdef", "g".repeat(40), "a".repeat(41), `${SHA_A}..${SHA_B}`, "--output=/tmp/x", ""])("SHA 인자 %j 가 형식 밖이면 부르지 않는다(invalid_input sha)", async (sha) => {
    const { fetch, client } = setup();
    for (const result of [
      await client.listCommits("backend", sha, SHA_B), await client.listCommits("backend", SHA_A, sha), await client.getCommit("backend", sha),
    ]) {
      expectFailure(result, "invalid_input");
      expect(!result.ok && result.field).toBe("sha");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["ci-cd", "Backend", " backend", "constructor", ""])("service %j 가 허용 목록 밖이면 부르지 않는다(invalid_input service)", async (service) => {
    const { fetch, client } = setup();
    const results = [
      await client.listCommits(service as never, SHA_A, SHA_B), await client.getCommit(service as never, SHA_B),
    ];
    for (const result of results) {
      expectFailure(result, "invalid_input");
      expect(!result.ok && result.field).toBe("service");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("커밋 목록 — 필요한 칸만 · master 순서 · relation 세 값", () => {
  it("ancestor — 요약(sha · 작성자 이름 · 작성 시각 · 제목 · 본문 · 본문 잘림)만, 그 밖 칸(이메일 등)은 버린다, B 쪽이 먼저(받은 순서 그대로)", async () => {
    const data = gitCommitRangeJson([
      gitCommitJson(SHA_B, { subject: "fix: head", body: "본문 줄\n둘째 줄", author_email: `${UPSTREAM_RAW_MARKER}@example.test`, extra: UPSTREAM_RAW_MARKER }),
      gitCommitJson(SHA_MIDDLE, { subject: "feat: middle", body_truncated: true }),
    ], { note: UPSTREAM_RAW_MARKER });
    const { client } = setup(rangeHandler(data));
    expect(okValue(await client.listCommits("backend", SHA_A, SHA_B))).toEqual({
      commits: [
        { sha: SHA_B, authorName: "Jun", authoredAt: "2026-11-22T01:00:00Z", subject: "fix: head", body: "본문 줄\n둘째 줄", bodyTruncated: false },
        { sha: SHA_MIDDLE, authorName: "Jun", authoredAt: "2026-11-22T01:00:00Z", subject: "feat: middle", body: "", bodyTruncated: true },
      ],
      truncated: false, rangeComplete: true, relation: "ancestor",
    });
  });

  it("not_ancestor — 빈 목록 · relation 그대로", async () => {
    const { client } = setup(rangeHandler(gitCommitRangeJson([], { relation: "not_ancestor" })));
    expect(okValue(await client.listCommits("backend", SHA_A, SHA_B))).toEqual({ commits: [], truncated: false, rangeComplete: true, relation: "not_ancestor" });
  });

  it("unknown — 빈 목록 · rangeComplete:false 그대로", async () => {
    const { client } = setup(rangeHandler(gitCommitRangeJson([], { relation: "unknown", range_complete: false })));
    expect(okValue(await client.listCommits("backend", SHA_A, SHA_B))).toEqual({ commits: [], truncated: false, rangeComplete: false, relation: "unknown" });
  });

  it("ancestor 인데 range_complete:false(목록에 얕은 경계 커밋) · truncated:true 를 그대로 알린다", async () => {
    const { client } = setup(rangeHandler(gitCommitRangeJson([gitCommitJson(SHA_B)], { truncated: true, range_complete: false })));
    const range = okValue(await client.listCommits("backend", SHA_A, SHA_B));
    expect(range.truncated).toBe(true);
    expect(range.rangeComplete).toBe(false);
  });

  it("제목 · 본문은 글자 그대로(HTML · 마크다운 · 제어 문자 해석 없음)", async () => {
    const subject = "<script>alert(1)</script> **굵게**";
    const body = "<img src=x onerror=alert(1)>\r\n\ttab &amp;";
    const { client } = setup(rangeHandler(gitCommitRangeJson([gitCommitJson(SHA_B, { subject, body })])));
    const [commit] = okValue(await client.listCommits("backend", SHA_A, SHA_B)).commits;
    expect(commit.subject).toBe(subject);
    expect(commit.body).toBe(body);
  });

  it.each([
    ["relation 이 세 값 밖", gitCommitRangeJson([], { relation: "diverged" })],
    ["relation 없음", { commits: [], truncated: false, range_complete: true }],
    ["relation 이 글자가 아님", gitCommitRangeJson([], { relation: 1 })],
    ["commits 가 배열이 아님", gitCommitRangeJson([], { commits: {} })],
    ["truncated 없음", { commits: [], range_complete: true, relation: "ancestor" }],
    ["range_complete 가 글자", gitCommitRangeJson([], { range_complete: "true" })],
    ["커밋 sha 가 짧음(전체 SHA 아님)", gitCommitRangeJson([gitCommitJson(SHA_B.slice(0, 12))])],
    ["커밋 sha 가 대문자", gitCommitRangeJson([gitCommitJson(SHA_WITH_LETTERS.toUpperCase())])],
    ["커밋 sha 가 16진수 아님", gitCommitRangeJson([gitCommitJson("z".repeat(40))])],
    ["subject 없음", gitCommitRangeJson([{ ...gitCommitJson(SHA_B), subject: undefined }])],
    ["author_name 이 null", gitCommitRangeJson([gitCommitJson(SHA_B, { author_name: null })])],
    ["authored_at 이 숫자", gitCommitRangeJson([gitCommitJson(SHA_B, { authored_at: 1763773200 })])],
    ["body 가 null", gitCommitRangeJson([gitCommitJson(SHA_B, { body: null })])],
    ["body_truncated 없음", gitCommitRangeJson([{ ...gitCommitJson(SHA_B), body_truncated: undefined }])],
    ["not_ancestor 인데 커밋이 있음", gitCommitRangeJson([gitCommitJson(SHA_B)], { relation: "not_ancestor" })],
    ["unknown 인데 커밋이 있음", gitCommitRangeJson([gitCommitJson(SHA_B)], { relation: "unknown", range_complete: false })],
  ])("꼴이 다르면 전체 unparseable — %s", async (_label, data) => {
    const { client } = setup(rangeHandler(JSON.parse(JSON.stringify(data))));
    expectFailure(await client.listCommits("backend", SHA_A, SHA_B), "unparseable");
  });

  it.each([
    ["success 가 false 인 200", { success: false, data: gitCommitRangeJson([]) }],
    ["data 없음", { success: true }],
    ["봉투 없이 data 만", gitCommitRangeJson([])],
  ])("봉투가 아니면 unparseable — %s", async (_label, body) => {
    const { client } = setup((url) => (url.pathname === DEPLOY_GIT_COMMITS_PATH ? jsonBody(body) : defaultHandler(url)));
    expectFailure(await client.listCommits("backend", SHA_A, SHA_B), "unparseable");
  });
});

describe("커밋 목록 상한 — 100개(경계)", () => {
  it("상한 상수", () => {
    expect(GIT_COMMIT_LIST_LIMIT).toBe(100);
    expect(GIT_COMMIT_FILE_LIMIT).toBe(100);
    expect(GIT_FILE_PATCH_LINE_LIMIT).toBe(500);
  });

  it("정확히 100개 — 전부, truncated 아님", async () => {
    const commits = Array.from({ length: 100 }, (_, index) => gitCommitJson(fakeSha(100 + index)));
    const { client } = setup(rangeHandler(gitCommitRangeJson(commits)));
    const range = okValue(await client.listCommits("backend", SHA_A, SHA_B));
    expect(range.commits).toHaveLength(100);
    expect(range.truncated).toBe(false);
  });

  it("master 가 101개를 주면(상한을 믿지 않는다) — 앞(B 쪽) 100개 · truncated:true", async () => {
    const commits = Array.from({ length: 101 }, (_, index) => gitCommitJson(fakeSha(100 + index)));
    const { client } = setup(rangeHandler(gitCommitRangeJson(commits)));
    const range = okValue(await client.listCommits("backend", SHA_A, SHA_B));
    expect(range.commits).toHaveLength(100);
    expect(range.commits[0].sha).toBe(fakeSha(100));
    expect(range.commits[99].sha).toBe(fakeSha(199));
    expect(range.truncated).toBe(true);
  });
});

describe("커밋 하나 — 파일 · patch", () => {
  it("정상 — 요약 + 파일(경로 · 이전 경로 · status · 줄 수 · 바이너리 · patch · 잘림 · 전체 줄 수)만, 그 밖 칸은 버린다", async () => {
    const data = gitCommitDetailJson(SHA_B, [
      gitFileJson("src/a.ts", { patch: "@@ -1,2 +1,2 @@\n context\n-old\n+new\n", extra: UPSTREAM_RAW_MARKER }),
      gitFileJson("src/new-name.ts", { previous_path: "src/old-name.ts", status: "renamed", additions: 0, deletions: 0, patch: null }),
      gitFileJson("image.png", { status: "added", binary: true, additions: 0, deletions: 0, patch: null }),
      gitFileJson("gone.ts", { status: "deleted", additions: 0, deletions: 3, patch: "@@ -1,3 +0,0 @@\n-a\n-b\n-c\n" }),
    ], { subject: "fix: head", body: "본문", author_email: `${UPSTREAM_RAW_MARKER}@example.test` });
    const { client } = setup(detailHandler(data));
    expect(okValue(await client.getCommit("backend", SHA_B))).toEqual({
      sha: SHA_B, authorName: "Jun", authoredAt: "2026-11-22T01:00:00Z", subject: "fix: head", body: "본문", bodyTruncated: false,
      files: [
        { path: "src/a.ts", previousPath: null, status: "modified", additions: 1, deletions: 1, binary: false,
          patch: "@@ -1,2 +1,2 @@\n context\n-old\n+new\n", patchTruncated: false, patchTotalLines: 4 },   // 끝 줄바꿈은 줄이 아니다
        { path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed", additions: 0, deletions: 0, binary: false,
          patch: null, patchTruncated: false, patchTotalLines: null },
        { path: "image.png", previousPath: null, status: "added", additions: 0, deletions: 0, binary: true,
          patch: null, patchTruncated: false, patchTotalLines: null },
        { path: "gone.ts", previousPath: null, status: "deleted", additions: 0, deletions: 3, binary: false,
          patch: "@@ -1,3 +0,0 @@\n-a\n-b\n-c\n", patchTruncated: false, patchTotalLines: 4 },
      ],
      filesTruncated: false,
    });
  });

  it("짧은 SHA 로 물으면 응답의 전체 SHA 가 그것으로 시작해야 한다(그대로 받는다)", async () => {
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, [])));
    expect(okValue(await client.getCommit("backend", SHA_B.slice(0, 7))).sha).toBe(SHA_B);
  });

  it("응답의 sha 가 요청한 커밋이 아니면 unparseable", async () => {
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_A, [])));
    expectFailure(await client.getCommit("backend", SHA_B), "unparseable");
  });

  it("경로 · patch 는 글자 그대로(탭 · 줄바꿈 · 따옴표 · HTML 해석 없음)", async () => {
    const path = "dir/a\tb \"q\" <i>.ts";
    const patch = "@@ -1 +1 @@\n-<b>x</b>\n+<script>evil()</script>\r";
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, [gitFileJson(path, { patch })])));
    const [file] = okValue(await client.getCommit("backend", SHA_B)).files;
    expect(file.path).toBe(path);
    expect(file.patch).toBe(patch);
  });

  it("master 가 patch 를 잘랐으면(patch_truncated) 그대로 알리고 전체 줄 수는 모름(null)", async () => {
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, [
      gitFileJson("big.ts", { patch: gitPatchWithLines(500), patch_truncated: true }),
      gitFileJson("emptied.ts", { patch: "", patch_truncated: true }),
    ])));
    const [big, emptied] = okValue(await client.getCommit("backend", SHA_B)).files;
    expect(big).toMatchObject({ patchTruncated: true, patchTotalLines: null });
    expect(patchLines(big.patch ?? "")).toHaveLength(500);
    expect(emptied).toMatchObject({ patchTruncated: true, patchTotalLines: null });
  });

  it("files_truncated · body_truncated 를 그대로", async () => {
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, [gitFileJson("a.ts")], { files_truncated: true, body_truncated: true })));
    const detail = okValue(await client.getCommit("backend", SHA_B));
    expect(detail.filesTruncated).toBe(true);
    expect(detail.bodyTruncated).toBe(true);
  });

  it.each([
    ["files 없음", { ...gitCommitDetailJson(SHA_B, []), files: undefined }],
    ["files_truncated 없음", { ...gitCommitDetailJson(SHA_B, []), files_truncated: undefined }],
    ["sha 가 전체 SHA 아님", gitCommitDetailJson(SHA_B.slice(0, 7), [])],
    ["파일 status 가 네 값 밖(removed 는 GitHub 의 낱말)", gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { status: "removed" })])],
    ["path 없음", gitCommitDetailJson(SHA_B, [{ ...gitFileJson("a.ts"), path: undefined }])],
    ["previous_path 가 숫자", gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { previous_path: 3 })])],
    ["additions 가 음수", gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { additions: -1 })])],
    ["deletions 가 소수", gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { deletions: 1.5 })])],
    ["binary 가 글자", gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { binary: "false" })])],
    ["patch 가 배열", gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { patch: ["@@"] })])],
    ["patch_truncated 없음", gitCommitDetailJson(SHA_B, [{ ...gitFileJson("a.ts"), patch_truncated: undefined }])],
  ])("꼴이 다르면 전체 unparseable — %s", async (_label, data) => {
    const { client } = setup(detailHandler(JSON.parse(JSON.stringify(data))));
    expectFailure(await client.getCommit("backend", SHA_B), "unparseable");
  });
});

describe("커밋 하나 상한 — 파일 100개 · patch 500줄(경계, 넘는 응답을 믿지 않는다)", () => {
  it("파일 정확히 100개 — 전부, 잘림 아님", async () => {
    const files = Array.from({ length: 100 }, (_, index) => gitFileJson(`file-${index}.ts`));
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, files)));
    const detail = okValue(await client.getCommit("backend", SHA_B));
    expect(detail.files).toHaveLength(100);
    expect(detail.filesTruncated).toBe(false);
  });

  it("파일 101개 — 앞 100개 · filesTruncated:true", async () => {
    const files = Array.from({ length: 101 }, (_, index) => gitFileJson(`file-${index}.ts`));
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, files)));
    const detail = okValue(await client.getCommit("backend", SHA_B));
    expect(detail.files).toHaveLength(100);
    expect(detail.files[99].path).toBe("file-99.ts");
    expect(detail.filesTruncated).toBe(true);
  });

  it("patch 정확히 500줄 — 그대로, 잘림 아님 · 전체 줄 수 500", async () => {
    const patch = gitPatchWithLines(500);
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { patch })])));
    expect(okValue(await client.getCommit("backend", SHA_B)).files[0]).toMatchObject({ patch, patchTruncated: false, patchTotalLines: 500 });
  });

  it("patch 501줄(master 가 자르지 않았다고 함) — 앞 500줄 · patchTruncated:true · 전체 줄 수 501", async () => {
    const patch = gitPatchWithLines(501);
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { patch })])));
    const [file] = okValue(await client.getCommit("backend", SHA_B)).files;
    expect(file).toMatchObject({ patchTruncated: true, patchTotalLines: 501 });
    expect(patchLines(file.patch ?? "")).toEqual(patchLines(patch).slice(0, 500));
  });

  it("끝 줄바꿈은 줄로 세지 않는다 — 머리줄 포함 4줄 + 끝 줄바꿈 = 4줄(글자는 그대로)", async () => {
    const patch = "@@ -1,2 +1,2 @@\n context\n-old\n+new\n";
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { patch })])));
    expect(okValue(await client.getCommit("backend", SHA_B)).files[0]).toMatchObject({ patch, patchTruncated: false, patchTotalLines: 4 });
  });

  it("'\\ No newline at end of file' 로 끝나는 patch(그 뒤에도 끝 줄바꿈) — 알림 줄까지 세고 끝 줄바꿈은 세지 않는다", async () => {
    const patch = "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n";
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { patch })])));
    expect(okValue(await client.getCommit("backend", SHA_B)).files[0]).toMatchObject({ patch, patchTruncated: false, patchTotalLines: 4 });
  });

  it("499줄 + 알림 줄 = 정확히 500줄(+ 끝 줄바꿈) — 잘리지 않음", async () => {
    const patch = `${gitPatchWithLines(499)}\\ No newline at end of file\n`;
    const { client } = setup(detailHandler(gitCommitDetailJson(SHA_B, [gitFileJson("a.ts", { patch })])));
    expect(okValue(await client.getCommit("backend", SHA_B)).files[0]).toMatchObject({ patch, patchTruncated: false, patchTotalLines: 500 });
  });
});

describe("실패 — master 의 오류 사상(명세 12.7 · 12.8 · 12.9) · 원문 없음 · 재시도 없음", () => {
  const calls: [string, (client: DeployGitClient) => Promise<UpstreamResult<unknown>>][] = [
    ["commits", (client) => client.listCommits("backend", SHA_A, SHA_B)],
    ["commit", (client) => client.getCommit("backend", SHA_B)],
  ];

  for (const [name, call] of calls) {
    it.each([
      [404, "commit_not_found", "not_in_history"],
      [404, "parent_unavailable", "not_in_history"],
      [503, "repository_changing", "history_changing"],
      [429, "too_many_requests", "rate_limited"],
      [504, "git_timeout", "server_timeout"],
      [504, "agent_timeout", "server_timeout"],
      [502, "agent_unreachable", "bad_status"],
      [502, "agent_unauthorized", "bad_status"],
      [502, "unexpected_response", "bad_status"],
      [500, "git_failed", "bad_status"],
      [401, "unauthorized", "unauthorized"],
      [422, "invalid_request", "invalid_request"],
      [503, "something_else", "unavailable"],
      [404, "something_else", "bad_status"],
    ] as const)(`${name}: %d %s → %s(상태 코드 · 고정 글자만, 한 번만 부른다)`, async (status, code, reason) => {
      const { fetch, client } = setup(() => masterGitFailure(status, code));
      const result = await call(client);
      expectFailure(result, reason, status);
      expect(fetch).toHaveBeenCalledTimes(1);   // 오류 봉투의 detail(원문 표식 · 경로)은 expectFailure 가 없음을 본다
    });

    it(`${name}: 경로 없음(옛 master 의 Go 기본 404 글자) → bad_status 404(이력 밖으로 보이지 않는다)`, async () => {
      const { client } = setup(() => masterRouteMissing());
      expectFailure(await call(client), "bad_status", 404);
    });

    it.each([301, 302, 307])(`${name}: 리다이렉트 %d → 따라가지 않고 bad_status`, async (status) => {
      const { fetch, client } = setup(() => new Response(null, { status, headers: { location: "https://evil.example.test/" } }));
      expectFailure(await call(client), "bad_status", status);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${name}: 깨진 JSON → unparseable`, async () => {
      const { client } = setup(() => textResponse(`{"success":true,"data":${UPSTREAM_RAW_MARKER}`));
      expectFailure(await call(client), "unparseable");
    });

    it(`${name}: 연결 실패 → unreachable(예외 문구 없음)`, async () => {
      const { client } = setup(() => { throw new TypeError(`fetch failed ${UPSTREAM_RAW_MARKER} ${FAKE_DEPLOY_MASTER_URL} ${FAKE_DEPLOY_SECRET}`); });
      expectFailure(await call(client), "unreachable");
    });

    it(`${name}: 응답하지 않으면 5초에 timeout(재시도 없음)`, async () => {
      vi.useFakeTimers();
      const { fetch, client } = setup((_url, init) => hangUntilAborted(init));
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
      const { client } = setup((_url, init) => headersThenStalledBody(init));
      const pending = track(call(client));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pending.settled).toBe(true);
      expectFailure(pending.value as Parameters<typeof expectFailure>[0], "timeout");
    });
  }

  it("새 실패 이유의 화면 글자(명세 문구)와 비밀 · 주소 없음", () => {
    expect(UPSTREAM_FAILURE_MESSAGES.not_in_history).toBe("이 서버의 git 이력에 없음(최근 50개 밖일 수 있음)");
    expect(UPSTREAM_FAILURE_MESSAGES.history_changing).toBe("배포가 이력을 바꾸는 중 — 잠시 뒤 새로 고침");
    for (const message of Object.values(UPSTREAM_FAILURE_MESSAGES)) expectNoForbiddenText(message);
  });
});

describe("캐시 — SHA 로 정해지는 성공만 · 범위는 ancestor + 온전 + 잘리지 않음만 · 상한", () => {
  function cachedSetup(handler: RoutedFetchHandler = defaultHandler, maximumEntries?: number) {
    const fetch = createRoutedFetch(handler);
    const inner = createDeployGitClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    const client = createCachedDeployGitClient(inner, maximumEntries === undefined ? {} : { maximumEntries });
    const countOf = (path: string) => fetch.mock.calls.filter(([input]) => new URL(input).pathname === path).length;
    return { fetch, client, countOf };
  }

  it("상한 상수", () => {
    expect(DEPLOY_GIT_CACHE_MAXIMUM_ENTRIES).toBe(500);
  });

  it("커밋 하나 — 같은 서비스 · SHA 의 두 번째는 부르지 않고 같은 값", async () => {
    const { client, countOf } = cachedSetup();
    const first = okValue(await client.getCommit("backend", SHA_B));
    expect(okValue(await client.getCommit("backend", SHA_B))).toEqual(first);
    expect(countOf(DEPLOY_GIT_COMMIT_PATH)).toBe(1);
  });

  it("커밋 하나 — 열쇠는 서비스 · SHA 별(다른 서비스 · 다른 SHA 는 새로 부른다)", async () => {
    const { client, countOf } = cachedSetup();
    await client.getCommit("backend", SHA_B);
    await client.getCommit("front", SHA_B);
    await client.getCommit("backend", SHA_A);
    expect(countOf(DEPLOY_GIT_COMMIT_PATH)).toBe(3);
  });

  it("범위 — ancestor · range_complete:true · truncated:false 는 저장(두 번째는 부르지 않는다), 열쇠는 서비스 · A · B 별", async () => {
    const { client, countOf } = cachedSetup();
    const first = okValue(await client.listCommits("backend", SHA_A, SHA_B));
    expect(okValue(await client.listCommits("backend", SHA_A, SHA_B))).toEqual(first);
    expect(countOf(DEPLOY_GIT_COMMITS_PATH)).toBe(1);
    await client.listCommits("backend", SHA_B, SHA_A);
    await client.listCommits("llm", SHA_A, SHA_B);
    expect(countOf(DEPLOY_GIT_COMMITS_PATH)).toBe(3);
  });

  it.each([
    ["not_ancestor", gitCommitRangeJson([], { relation: "not_ancestor" })],
    ["unknown", gitCommitRangeJson([], { relation: "unknown", range_complete: false })],
    ["ancestor 인데 range_complete:false", gitCommitRangeJson([gitCommitJson(SHA_B)], { range_complete: false })],
    ["ancestor 인데 truncated", gitCommitRangeJson([gitCommitJson(SHA_B)], { truncated: true })],
  ])("범위 — %s 는 저장하지 않는다(이력이 바뀌면 답이 달라진다)", async (_label, data) => {
    const { client, countOf } = cachedSetup(rangeHandler(data));
    await client.listCommits("backend", SHA_A, SHA_B);
    await client.listCommits("backend", SHA_A, SHA_B);
    expect(countOf(DEPLOY_GIT_COMMITS_PATH)).toBe(2);
  });

  it.each([
    ["not_in_history", () => masterGitFailure(404, "commit_not_found")],
    ["history_changing", () => masterGitFailure(503, "repository_changing")],
    ["rate_limited", () => masterGitFailure(429, "too_many_requests")],
    ["unreachable", () => { throw new TypeError("fetch failed"); }],
  ] as [string, RoutedFetchHandler][])("실패(%s)는 저장하지 않는다 — 다음 요청이 다시 부르고, 성공하면 그때부터 저장", async (_label, failing) => {
    let handler: RoutedFetchHandler = failing;
    const { client, countOf } = cachedSetup((url, init) => handler(url, init));
    expect((await client.getCommit("backend", SHA_B)).ok).toBe(false);
    expect((await client.listCommits("backend", SHA_A, SHA_B)).ok).toBe(false);
    handler = defaultHandler;
    expect((await client.getCommit("backend", SHA_B)).ok).toBe(true);
    expect((await client.listCommits("backend", SHA_A, SHA_B)).ok).toBe(true);
    await client.getCommit("backend", SHA_B);
    await client.listCommits("backend", SHA_A, SHA_B);
    expect(countOf(DEPLOY_GIT_COMMIT_PATH)).toBe(2);
    expect(countOf(DEPLOY_GIT_COMMITS_PATH)).toBe(2);
  });

  it("상한 — 항목 수가 넘으면 가장 오래된 것부터 버린다(최근 것은 남는다)", async () => {
    const { client, countOf } = cachedSetup(defaultHandler, 3);
    for (const index of [1, 2, 3, 4]) await client.getCommit("backend", fakeSha(index));
    expect(countOf(DEPLOY_GIT_COMMIT_PATH)).toBe(4);
    await client.getCommit("backend", fakeSha(4));
    expect(countOf(DEPLOY_GIT_COMMIT_PATH)).toBe(4);
    await client.getCommit("backend", fakeSha(1));
    expect(countOf(DEPLOY_GIT_COMMIT_PATH)).toBe(5);
  });

  it("입력 거절은 저장하지 않고 부르지도 않는다", async () => {
    const { fetch, client } = cachedSetup();
    expectFailure(await client.getCommit("backend", "xyz"), "invalid_input");
    expect(fetch).not.toHaveBeenCalled();
  });
});
