/** 배포 상세 조립 — 출처 교체(명세 §10.3 · §12.2 "어드민: 커밋 목록 · diff 는 master 의 두 경로에서, PR 제목 · 본문만 GitHub") ·
 * 12.7 relation(not_ancestor) · 12.8 unknown · §10.2 범위 세 상태 · 목록 밖 commit 거절 · 한 칸이 실패해도 다른 칸은 그대로.
 * master 배포 이력 · master git · GitHub 클라이언트는 가짜 객체(이 층은 조립 · 보기 모델로 옮기기만 본다 — 응답 해석은 deploy-git-client.test).
 *
 * 고정하는 보기 모델(바깥 꼴 DeployDetailView 의 칸 query · deployment · range · repository · pullRequest · commits · commit 은 그대로):
 * - 의존성: { deployHistory, deployGit: DeployGitClient, github } — github 은 listPullRequestsForCommit 만 부른다(compareCommits · getCommit 0회).
 * - CommitListView = { relation: "ancestor"|"not_ancestor"|"unknown"|null, commits: CommitSummary[], hasMoreCommits, rangeComplete, htmlUrl,
 *     rangeFailure: UpstreamFailure|null(범위 조회의 실패 — B 하나를 대신 보일 때), headFailure: UpstreamFailure|null(대신 부른 B 조회의 실패) }
 *   · range: listCommits(서비스, A, B) — commits 는 **오래된 것 먼저(B 가 마지막)**: master 순서(B 먼저)를 뒤집는다(GitHub 때의 화면 순서 유지).
 *     hasMoreCommits = truncated · rangeComplete = range_complete · htmlUrl = GitHub 비교 주소(githubCompareUrl(저장소, A, B)) — relation 과 무관하게.
 *   · 범위로 B 를 보일 수 없을 때 B 하나로 물러선다(메인 판정 11-23 — "이번 배포가 무엇인가"는 범위를 못 내도 보여야 한다):
 *     - relation not_ancestor · unknown → getCommit(서비스, B) 한 번 → { relation 그대로, commits:[B], hasMoreCommits:false, rangeComplete 그대로, htmlUrl: 비교 주소,
 *       rangeFailure:null, headFailure:null }. B 조회가 실패하면 { …, commits:[], headFailure: 그 실패 } — 안내(relation)는 남는다.
 *     - 범위 조회 자체가 실패 → getCommit(서비스, B) 한 번 → 성공이면 { relation:null, commits:[B], hasMoreCommits:false, rangeComplete:false,
 *       htmlUrl: 비교 주소, rangeFailure: 범위의 실패, headFailure:null }. B 도 실패면 commits 칸 = 범위의 실패 그대로(범위 실패 문구만).
 *     - 이때 commit=B 는 고를 수 있다(이미 받은 B — 다시 부르지 않는다). B 조회가 실패했는데 commit=B 면 commit = 그 실패(commits 칸이 실패면 그 실패).
 *       B 밖의 commit 은 invalid_input(commit).
 *   · no_previous: getCommit(서비스, B) 하나 → { relation:null, commits:[B 의 요약], hasMoreCommits:false, rangeComplete:true, htmlUrl: B 의 커밋 주소 }
 *   · same_commit: 부르지 않는다 → { relation:null, commits:[], hasMoreCommits:false, rangeComplete:true, htmlUrl:null }
 *   (comparisonStatus · diverged · totalCommits 는 GitHub 비교의 칸이라 없어진다.)
 * - CommitSummary = { sha, title: subject, message: body 가 비면 subject · 아니면 subject + "\n\n" + body, messageTruncated: bodyTruncated,
 *   authorName: 빈 글자면 null, authoredAt, htmlUrl: githubCommitUrl(저장소, sha) }
 * - CommitDetail = CommitSummary + { files: CommitFileChange[], hasMoreFiles: filesTruncated }
 * - CommitFileChange = { filename: path, previousFilename: previousPath, status(deleted → "removed" — 화면의 낱말표 그대로, 그 밖은 같은 낱말), additions, deletions, patch }
 * - FilePatch = { kind:"text", text, truncated: patchTruncated, totalLines: patchTotalLines(null = 모름) }
 *             | { kind:"unavailable", reason:"binary" }(binary — 다른 조건보다 먼저)
 *             | { kind:"unavailable", reason:"omitted" }(바이너리 아님 · patch 가 null 또는 빈 글자 · patchTruncated — "더 있음"으로 보인다)
 *             | { kind:"unavailable", reason:"empty" }(바이너리 아님 · patch 가 null 또는 빈 글자 · 잘림 아님 — 내용 없는 이름 바뀜 · 빈 파일 등) */
import { describe, expect, it, vi } from "vitest";
import type { DeployHistoryClient, DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import type { DeployDetailQuery } from "@/features/deploy-detail/lib/deploy-detail-query";
import { buildDeployDetail, type DeployDetailDependencies, type DeployDetailOutcome, type DeployDetailView } from "@/features/deploy-detail/lib/deploy-detail-view";
import type { DeployGitClient, GitCommit, GitCommitDetail, GitCommitRange, GitFileChange } from "@/features/deploy-detail/lib/deploy-git-client";
import type { PullRequestSummary } from "@/features/deploy-detail/lib/github-client";
import { githubCommitUrl, githubCompareUrl } from "@/features/deploy-detail/lib/github-repository";
import { REPOSITORY_WEB, fakeSha } from "@/features/deploy-detail/lib/github-test-fakes";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";
import { expectFailure, okValue } from "@/shared/lib/upstream-test-fakes";

const SHA_A = fakeSha(1);
const SHA_B = fakeSha(2);
const SHA_MIDDLE = fakeSha(3);
/** 글자가 섞인 SHA — 대문자로 바꾸면 실제로 달라진다(fakeSha 는 숫자뿐이라 대소문자 사례에 못 쓴다). */
const SHA_WITH_LETTERS = "ab".repeat(20);
const REPOSITORY = { owner: "junhyeong9812", name: "study-note-deploy-system-backend" };
const COMPARE_URL = `${REPOSITORY_WEB}/compare/${SHA_A}...${SHA_B}`;

function deployment(requestId: string, commitSha: string, overrides: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    requestId, state: "succeeded", service: "backend", commitSha, failedStage: null, acceptedAt: "2026-11-22T01:00:00Z",
    finishedAt: "2026-11-22T01:05:00Z", integrationMilliseconds: 60_000, deliveryMilliseconds: 30_000, ...overrides,
  };
}

function gitCommit(sha: string, overrides: Partial<GitCommit> = {}): GitCommit {
  return { sha, authorName: "Jun", authoredAt: "2026-11-22T01:00:00Z", subject: `commit ${sha.slice(0, 7)}`, body: "", bodyTruncated: false, ...overrides };
}

function gitRange(commits: GitCommit[], overrides: Partial<GitCommitRange> = {}): GitCommitRange {
  return { commits, truncated: false, rangeComplete: true, relation: "ancestor", ...overrides };
}

function gitFile(path: string, overrides: Partial<GitFileChange> = {}): GitFileChange {
  return {
    path, previousPath: null, status: "modified", additions: 1, deletions: 1, binary: false, patch: "@@ -1 +1 @@\n-a\n+b",
    patchTruncated: false, patchTotalLines: 3, ...overrides,
  };
}

function gitDetail(sha: string, overrides: Partial<GitCommitDetail> = {}): GitCommitDetail {
  return { ...gitCommit(sha), files: [gitFile("a.ts")], filesTruncated: false, ...overrides };
}

/** 보기 모델의 커밋 요약(기본 가짜 커밋에서 옮긴 값). */
function summary(sha: string, overrides: Record<string, unknown> = {}) {
  return {
    sha, title: `commit ${sha.slice(0, 7)}`, message: `commit ${sha.slice(0, 7)}`, messageTruncated: false, authorName: "Jun",
    authoredAt: "2026-11-22T01:00:00Z", htmlUrl: `${REPOSITORY_WEB}/commit/${sha}`, ...overrides,
  };
}

function pullRequest(number: number): PullRequestSummary {
  return { number, title: `PR ${number}`, body: `본문 ${number}`, state: "closed", mergedAt: "2026-11-22T00:00:00Z", htmlUrl: `${REPOSITORY_WEB}/pull/${number}` };
}

const NORMAL_LIST = [deployment("selected", SHA_B), deployment("previous", SHA_A)];

function fakes(options: {
  deployments?: UpstreamResult<DeploymentSummary[]>;
  range?: UpstreamResult<GitCommitRange>;
  commit?: (sha: string) => UpstreamResult<GitCommitDetail>;
  pulls?: UpstreamResult<PullRequestSummary[]>;
} = {}) {
  const deployHistory: DeployHistoryClient = {
    listDeployments: vi.fn(async () => options.deployments ?? { ok: true as const, value: NORMAL_LIST }),
  };
  const deployGit = {
    listCommits: vi.fn(async (_service: string, _fromSha: string, _toSha: string) => options.range ?? { ok: true as const, value: gitRange([gitCommit(SHA_B), gitCommit(SHA_MIDDLE)]) }),
    getCommit: vi.fn(async (_service: string, sha: string) => (options.commit ? options.commit(sha) : { ok: true as const, value: gitDetail(sha) })),
  } satisfies DeployGitClient;
  /** GitHub — PR 만 남는다. 비교 · 커밋 조회가 불리면 사례 실패(호출 0회 단언). */
  const github = {
    compareCommits: vi.fn(async () => upstreamFailure("bad_status")),
    getCommit: vi.fn(async () => upstreamFailure("bad_status")),
    listPullRequestsForCommit: vi.fn(async () => options.pulls ?? { ok: true as const, value: [pullRequest(12)] }),
  };
  return { deployHistory, deployGit, github };
}

/** 새 의존성 꼴(deployGit 추가)로 부른다 — 선언이 바뀌기 전에도 타입 검사가 통과하도록 넓혀서 넘긴다. */
function build(dependencies: ReturnType<typeof fakes>, query: DeployDetailQuery): Promise<DeployDetailOutcome> {
  return buildDeployDetail(dependencies as unknown as DeployDetailDependencies, query);
}

function query(overrides: Partial<DeployDetailQuery> = {}): DeployDetailQuery {
  return { service: "backend", selectedRequestId: "selected", commitSha: null, ...overrides };
}

function viewOf(outcome: DeployDetailOutcome): DeployDetailView {
  expect(outcome.kind, JSON.stringify(outcome)).toBe("view");
  if (outcome.kind !== "view") throw new Error("expected view");
  return outcome.view;
}

function expectNoGitHubCommitCalls(dependencies: ReturnType<typeof fakes>) {
  expect(dependencies.github.compareCommits).not.toHaveBeenCalled();
  expect(dependencies.github.getCommit).not.toHaveBeenCalled();
}

describe("GitHub 웹 주소(링크만 — API 를 부르지 않는다)", () => {
  it("비교 · 커밋 주소", () => {
    expect(githubCompareUrl(REPOSITORY, SHA_A, SHA_B)).toBe(`https://github.com/junhyeong9812/study-note-deploy-system-backend/compare/${SHA_A}...${SHA_B}`);
    expect(githubCommitUrl(REPOSITORY, SHA_B)).toBe(`https://github.com/junhyeong9812/study-note-deploy-system-backend/commit/${SHA_B}`);
  });
});

describe("출처 — 커밋 목록 · diff 는 master git, PR 만 GitHub", () => {
  it("range(ancestor) — listCommits(서비스, A, B) 한 번, 보기 모델은 오래된 것 먼저 · 비교 주소, GitHub 비교 · 커밋 조회 0회, PR 은 B", async () => {
    const dependencies = fakes();
    const view = viewOf(await build(dependencies, query()));
    expect(dependencies.deployGit.listCommits).toHaveBeenCalledTimes(1);
    expect(dependencies.deployGit.listCommits).toHaveBeenCalledWith("backend", SHA_A, SHA_B);
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalled();
    expect(okValue(view.commits!)).toEqual({
      relation: "ancestor", commits: [summary(SHA_MIDDLE), summary(SHA_B)], hasMoreCommits: false, rangeComplete: true, htmlUrl: COMPARE_URL, rangeFailure: null, headFailure: null,
    });
    expect(view.range).toEqual({ status: "range", baseRequestId: "previous", baseCommitSha: SHA_A, headCommitSha: SHA_B });
    expect(view.repository).toEqual(REPOSITORY);
    expect(okValue(view.pullRequest!)).toEqual(pullRequest(12));
    expect(dependencies.github.listPullRequestsForCommit).toHaveBeenCalledWith(REPOSITORY, SHA_B);
    expect(view.commit).toBeNull();
    expectNoGitHubCommitCalls(dependencies);
  });

  it("commit 이 목록에 있으면 deployGit.getCommit(서비스, 목록의 SHA) — 대소문자 무관 완전 일치, GitHub 커밋 조회 0회", async () => {
    const dependencies = fakes({ range: { ok: true, value: gitRange([gitCommit(SHA_B), gitCommit(SHA_WITH_LETTERS)]) } });
    const view = viewOf(await build(dependencies, query({ commitSha: SHA_WITH_LETTERS.toUpperCase() })));
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledTimes(1);
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledWith("backend", SHA_WITH_LETTERS);
    expect(okValue(view.commit!)).toEqual({
      ...summary(SHA_WITH_LETTERS), hasMoreFiles: false,
      files: [{ filename: "a.ts", previousFilename: null, status: "modified", additions: 1, deletions: 1, patch: { kind: "text", text: "@@ -1 +1 @@\n-a\n+b", truncated: false, totalLines: 3 } }],
    });
    expectNoGitHubCommitCalls(dependencies);
  });

  it.each([
    ["목록 밖의 임의 커밋", fakeSha(99)],
    ["A 자신(A 제외 · B 포함)", SHA_A],
    ["목록 커밋의 앞 7자(완전 일치 아님)", SHA_MIDDLE.slice(0, 7)],
  ])("목록 밖 commit(%s) → invalid_input(commit), 그 커밋은 master 에서도 부르지 않는다", async (_label, commitSha) => {
    const dependencies = fakes();
    expect(await build(dependencies, query({ commitSha }))).toEqual({ kind: "invalid_input", field: "commit" });
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalled();
    expectNoGitHubCommitCalls(dependencies);
  });
});

describe("relation — not_ancestor · unknown · 더 있음", () => {
  it("not_ancestor — B 하나로 물러선다: getCommit(B) 한 번 · commits [B] · relation 그대로 · 비교 주소", async () => {
    const dependencies = fakes({ range: { ok: true, value: gitRange([], { relation: "not_ancestor" }) } });
    const view = viewOf(await build(dependencies, query()));
    expect(okValue(view.commits!)).toEqual({
      relation: "not_ancestor", commits: [summary(SHA_B)], hasMoreCommits: false, rangeComplete: true, htmlUrl: COMPARE_URL, rangeFailure: null, headFailure: null,
    });
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledTimes(1);
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledWith("backend", SHA_B);
    expect(view.range?.status).toBe("range");
    expectNoGitHubCommitCalls(dependencies);
  });

  it("unknown — B 하나로 물러선다: commits [B] · rangeComplete:false 그대로 · 비교 주소", async () => {
    const dependencies = fakes({ range: { ok: true, value: gitRange([], { relation: "unknown", rangeComplete: false }) } });
    expect(okValue(viewOf(await build(dependencies, query())).commits!)).toEqual({
      relation: "unknown", commits: [summary(SHA_B)], hasMoreCommits: false, rangeComplete: false, htmlUrl: COMPARE_URL, rangeFailure: null, headFailure: null,
    });
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledTimes(1);
  });

  it.each(["not_ancestor", "unknown"] as const)("%s + commit=B → B 의 파일 · diff(이미 받은 B — getCommit 한 번)", async (relation) => {
    const dependencies = fakes({
      deployments: { ok: true, value: [deployment("selected", SHA_WITH_LETTERS), deployment("previous", SHA_A)] },
      range: { ok: true, value: gitRange([], { relation, rangeComplete: relation !== "unknown" }) },
    });
    const view = viewOf(await build(dependencies, query({ commitSha: SHA_WITH_LETTERS.toUpperCase() })));
    expect(okValue(view.commit!).sha).toBe(SHA_WITH_LETTERS);
    expect(okValue(view.commit!).files).toHaveLength(1);
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledTimes(1);
  });

  it.each(["not_ancestor", "unknown"] as const)("%s + B 밖의 commit → invalid_input(commit), 그 커밋은 부르지 않는다", async (relation) => {
    const dependencies = fakes({ range: { ok: true, value: gitRange([], { relation, rangeComplete: relation !== "unknown" }) } });
    expect(await build(dependencies, query({ commitSha: SHA_MIDDLE }))).toEqual({ kind: "invalid_input", field: "commit" });
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalledWith("backend", SHA_MIDDLE);
  });

  it.each(["not_ancestor", "unknown"] as const)("%s + B 조회 실패 → commits 칸은 relation 을 남기고 빈 목록 · headFailure, PR 은 그대로", async (relation) => {
    const failure = upstreamFailure("not_in_history", { status: 404 });
    const dependencies = fakes({ range: { ok: true, value: gitRange([], { relation, rangeComplete: false }) }, commit: () => failure });
    const view = viewOf(await build(dependencies, query()));
    expect(okValue(view.commits!)).toEqual({
      relation, commits: [], hasMoreCommits: false, rangeComplete: false, htmlUrl: COMPARE_URL, rangeFailure: null, headFailure: failure,
    });
    expect(okValue(view.pullRequest!)?.number).toBe(12);
  });

  it("not_ancestor + B 조회 실패 + commit=B → commit = 그 실패(다시 부르지 않는다)", async () => {
    const failure = upstreamFailure("not_in_history", { status: 404 });
    const dependencies = fakes({ range: { ok: true, value: gitRange([], { relation: "not_ancestor" }) }, commit: () => failure });
    const view = viewOf(await build(dependencies, query({ commitSha: SHA_B })));
    expect(view.commit).toEqual(failure);
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledTimes(1);
  });

  it("truncated · range_complete:false(ancestor) → hasMoreCommits · rangeComplete 를 그대로 (조용히 자르지 않는다)", async () => {
    const dependencies = fakes({ range: { ok: true, value: gitRange([gitCommit(SHA_B), gitCommit(SHA_MIDDLE)], { truncated: true, rangeComplete: false }) } });
    expect(okValue(viewOf(await build(dependencies, query())).commits!)).toEqual({
      relation: "ancestor", commits: [summary(SHA_MIDDLE), summary(SHA_B)], hasMoreCommits: true, rangeComplete: false, htmlUrl: COMPARE_URL, rangeFailure: null, headFailure: null,
    });
  });
});

describe("A 없음 · A==B", () => {
  it("A 없음 — getCommit(서비스, B) 하나, 범위 조회 · GitHub 비교/커밋 0회, htmlUrl = B 의 커밋 주소", async () => {
    const dependencies = fakes({ deployments: { ok: true, value: [deployment("selected", SHA_B)] } });
    const view = viewOf(await build(dependencies, query()));
    expect(view.range).toEqual({ status: "no_previous", baseRequestId: null, baseCommitSha: null, headCommitSha: SHA_B });
    expect(okValue(view.commits!)).toEqual({
      relation: null, commits: [summary(SHA_B)], hasMoreCommits: false, rangeComplete: true, htmlUrl: `${REPOSITORY_WEB}/commit/${SHA_B}`, rangeFailure: null, headFailure: null,
    });
    expect(dependencies.deployGit.listCommits).not.toHaveBeenCalled();
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledWith("backend", SHA_B);
    expectNoGitHubCommitCalls(dependencies);
  });

  it("A 없음 + commit=B → 이미 받은 B 를 쓴다(getCommit 한 번)", async () => {
    const dependencies = fakes({ deployments: { ok: true, value: [deployment("selected", SHA_B)] } });
    const view = viewOf(await build(dependencies, query({ commitSha: SHA_B })));
    expect(okValue(view.commit!).sha).toBe(SHA_B);
    expect(okValue(view.commit!).files).toHaveLength(1);
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledTimes(1);
  });

  it("A 없음 + B 가 서버 이력에 없음 → commits 만 not_in_history, 요약 · PR 은 그대로", async () => {
    const dependencies = fakes({
      deployments: { ok: true, value: [deployment("selected", SHA_B)] }, commit: () => upstreamFailure("not_in_history", { status: 404 }),
    });
    const view = viewOf(await build(dependencies, query()));
    expectFailure(view.commits!, "not_in_history", 404);
    expect(view.deployment.ok).toBe(true);
    expect(okValue(view.pullRequest!)?.number).toBe(12);
  });

  it("A==B — 변경 없음: master git 도 GitHub 도 부르지 않는다(PR 은 B 기준으로 그대로)", async () => {
    const dependencies = fakes({ deployments: { ok: true, value: [deployment("selected", SHA_B), deployment("previous", SHA_B)] } });
    const view = viewOf(await build(dependencies, query()));
    expect(view.range?.status).toBe("same_commit");
    expect(okValue(view.commits!)).toEqual({ relation: null, commits: [], hasMoreCommits: false, rangeComplete: true, htmlUrl: null, rangeFailure: null, headFailure: null });
    expect(dependencies.deployGit.listCommits).not.toHaveBeenCalled();
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalled();
    expectNoGitHubCommitCalls(dependencies);
    expect(okValue(view.pullRequest!)?.number).toBe(12);
  });
});

describe("보기 모델로 옮기기 — 메시지 · 작성자 · 파일 · patch", () => {
  it("메시지 = 제목 + 빈 줄 + 본문(본문이 비면 제목만) · 본문 잘림 · 빈 작성자 이름은 null · 글자 그대로", async () => {
    const commits = [
      gitCommit(SHA_B, { subject: "<b>fix</b>: head", body: "본문 <script>x</script>\n둘째 줄", bodyTruncated: true, authorName: "" }),
      gitCommit(SHA_MIDDLE, { subject: "feat: middle" }),
    ];
    const dependencies = fakes({ range: { ok: true, value: gitRange(commits) } });
    const listed = okValue(viewOf(await build(dependencies, query())).commits!).commits;
    expect(listed).toEqual([
      summary(SHA_MIDDLE, { title: "feat: middle", message: "feat: middle" }),
      summary(SHA_B, { title: "<b>fix</b>: head", message: "<b>fix</b>: head\n\n본문 <script>x</script>\n둘째 줄", messageTruncated: true, authorName: null }),
    ]);
  });

  it("파일 — 내용 없는 이름 바뀜(unavailable empty) · 삭제(removed) · 바이너리(unavailable binary) · 생략된 patch(unavailable omitted) · 잘린 patch(전체 줄 수 모름) · 파일 잘림", async () => {
    const detail = gitDetail(SHA_B, {
      filesTruncated: true,
      files: [
        gitFile("src/new.ts", { previousPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0, patch: null, patchTotalLines: null }),
        gitFile("gone.ts", { status: "deleted", additions: 0, deletions: 2, patch: "@@ -1,2 +0,0 @@\n-a\n-b", patchTotalLines: 3 }),
        gitFile("image.png", { status: "added", binary: true, additions: 0, deletions: 0, patch: null, patchTotalLines: null }),
        gitFile("huge.json", { patch: "", patchTruncated: true, patchTotalLines: null }),
        gitFile("long.ts", { patch: "@@ -1 +1 @@\n+x", patchTruncated: true, patchTotalLines: null }),
        gitFile("cut-here.ts", { patch: "@@ -1 +1 @@\n+y", patchTruncated: true, patchTotalLines: 501 }),
      ],
    });
    const dependencies = fakes({ commit: () => ({ ok: true, value: detail }) });
    const view = viewOf(await build(dependencies, query({ commitSha: SHA_B })));
    const value = okValue(view.commit!) as unknown as { files: unknown[]; hasMoreFiles: boolean };
    expect(value.hasMoreFiles).toBe(true);
    expect(value.files).toEqual([
      { filename: "src/new.ts", previousFilename: "src/old.ts", status: "renamed", additions: 0, deletions: 0, patch: { kind: "unavailable", reason: "empty" } },
      { filename: "gone.ts", previousFilename: null, status: "removed", additions: 0, deletions: 2, patch: { kind: "text", text: "@@ -1,2 +0,0 @@\n-a\n-b", truncated: false, totalLines: 3 } },
      { filename: "image.png", previousFilename: null, status: "added", additions: 0, deletions: 0, patch: { kind: "unavailable", reason: "binary" } },
      { filename: "huge.json", previousFilename: null, status: "modified", additions: 1, deletions: 1, patch: { kind: "unavailable", reason: "omitted" } },
      { filename: "long.ts", previousFilename: null, status: "modified", additions: 1, deletions: 1, patch: { kind: "text", text: "@@ -1 +1 @@\n+x", truncated: true, totalLines: null } },
      { filename: "cut-here.ts", previousFilename: null, status: "modified", additions: 1, deletions: 1, patch: { kind: "text", text: "@@ -1 +1 @@\n+y", truncated: true, totalLines: 501 } },
    ]);
  });
});

describe("실패는 칸의 결과로 — 한 출처가 실패해도 다른 구역은 그대로", () => {
  it.each([
    ["이력이 바뀌는 중", upstreamFailure("history_changing", { status: 503 })],
    ["서버 이력에 없음", upstreamFailure("not_in_history", { status: 404 })],
    ["동시 조회 초과", upstreamFailure("rate_limited", { status: 429 })],
    ["agent 시간 초과", upstreamFailure("server_timeout", { status: 504 })],
    ["계약과 다른 꼴", upstreamFailure("unparseable")],
  ])("커밋 목록 실패(%s) → B 하나로 물러선다: rangeFailure = 그 실패 · commits [B], 요약 · 범위 · PR 은 그대로", async (_label, failure) => {
    const dependencies = fakes({ range: failure });
    const view = viewOf(await build(dependencies, query()));
    expect(okValue(view.commits!)).toEqual({
      relation: null, commits: [summary(SHA_B)], hasMoreCommits: false, rangeComplete: false, htmlUrl: COMPARE_URL, rangeFailure: failure, headFailure: null,
    });
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledTimes(1);
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledWith("backend", SHA_B);
    expect(view.deployment.ok).toBe(true);
    expect(view.range?.status).toBe("range");
    expect(okValue(view.pullRequest!)?.number).toBe(12);
  });

  it("커밋 목록 실패 + B 도 실패 → commits 칸 = 범위의 실패 그대로(범위 실패 문구만), PR 은 그대로", async () => {
    const rangeFailure = upstreamFailure("history_changing", { status: 503 });
    const dependencies = fakes({ range: rangeFailure, commit: () => upstreamFailure("not_in_history", { status: 404 }) });
    const view = viewOf(await build(dependencies, query()));
    expect(view.commits).toEqual(rangeFailure);
    expect(okValue(view.pullRequest!)?.number).toBe(12);
  });

  it("커밋 목록 실패 + commit=B → 대신 받은 B 의 파일 · diff(getCommit 한 번)", async () => {
    const dependencies = fakes({ range: upstreamFailure("history_changing", { status: 503 }) });
    const view = viewOf(await build(dependencies, query({ commitSha: SHA_B })));
    expect(okValue(view.commit!).sha).toBe(SHA_B);
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledTimes(1);
  });

  it("커밋 목록 실패 + B 도 실패 + commit=B → commit 도 범위의 실패, 더 부르지 않는다", async () => {
    const dependencies = fakes({ range: upstreamFailure("history_changing", { status: 503 }), commit: () => upstreamFailure("not_in_history", { status: 404 }) });
    const view = viewOf(await build(dependencies, query({ commitSha: SHA_B })));
    expectFailure(view.commit!, "history_changing", 503);
    expect(dependencies.deployGit.getCommit).toHaveBeenCalledTimes(1);
  });

  it("커밋 목록 실패 + B 밖의 commit → invalid_input(commit), 그 커밋은 부르지 않는다", async () => {
    const dependencies = fakes({ range: upstreamFailure("history_changing", { status: 503 }) });
    expect(await build(dependencies, query({ commitSha: SHA_MIDDLE }))).toEqual({ kind: "invalid_input", field: "commit" });
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalledWith("backend", SHA_MIDDLE);
  });

  it("PR 조회 실패(GitHub 한도) → pullRequest 만 실패, 커밋 목록은 그대로", async () => {
    const view = viewOf(await build(fakes({ pulls: upstreamFailure("rate_limited", { status: 403 }) }), query()));
    expectFailure(view.pullRequest!, "rate_limited", 403);
    expect(okValue(view.commits!).commits).toHaveLength(2);
  });

  it("고른 커밋이 서버 이력에 없음(얕은 경계의 parent_unavailable 포함) → commit 만 not_in_history, 목록은 그대로", async () => {
    const view = viewOf(await build(fakes({ commit: () => upstreamFailure("not_in_history", { status: 404 }) }), query({ commitSha: SHA_B })));
    expectFailure(view.commit!, "not_in_history", 404);
    expect(view.commits?.ok).toBe(true);
  });

  it("master 배포 이력 실패 → 나머지 칸 null, master git · GitHub 를 부르지 않는다", async () => {
    const dependencies = fakes({ deployments: upstreamFailure("timeout") });
    const view = viewOf(await build(dependencies, query({ commitSha: SHA_B })));
    expectFailure(view.deployment, "timeout");
    expect(view.commits).toBeNull();
    expect(dependencies.deployGit.listCommits).not.toHaveBeenCalled();
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalled();
    expect(dependencies.github.listPullRequestsForCommit).not.toHaveBeenCalled();
  });

  it("선택한 배포 없음 → not_found, 아무 것도 부르지 않는다", async () => {
    const dependencies = fakes();
    expect(await build(dependencies, query({ selectedRequestId: "missing" }))).toEqual({ kind: "not_found" });
    expect(dependencies.deployGit.listCommits).not.toHaveBeenCalled();
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalled();
    expect(dependencies.github.listPullRequestsForCommit).not.toHaveBeenCalled();
  });

  it.each([
    ["B 가 16진수가 아님", [deployment("selected", "not-a-sha-value"), deployment("previous", SHA_A)]],
    ["A 가 너무 짧음", [deployment("selected", SHA_B), deployment("previous", "abc")]],
  ])("master 가 준 SHA 가 형식 밖(%s) → PR · 커밋 칸 unparseable, master git · GitHub 를 부르지 않는다", async (_label, list) => {
    const dependencies = fakes({ deployments: { ok: true, value: list } });
    const view = viewOf(await build(dependencies, query()));
    expect(view.deployment.ok).toBe(true);
    expectFailure(view.pullRequest!, "unparseable");
    expectFailure(view.commits!, "unparseable");
    expect(dependencies.deployGit.listCommits).not.toHaveBeenCalled();
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalled();
    expect(dependencies.github.listPullRequestsForCommit).not.toHaveBeenCalled();
  });
});
