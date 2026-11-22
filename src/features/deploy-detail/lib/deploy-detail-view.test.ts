/** 배포 상세 조립 — 명세 §10.2 "상세에 담는 것: 배포 요약 · PR · A→B 커밋 목록 · 고른 커밋의 파일과 diff" ·
 * "GitHub 가 실패해도 배포 요약과 목록은 그대로 보이고 상세 자리에 이유만" · "A 가 없으면 B 커밋 하나만 · A 와 B 가 같으면 변경 없음" ·
 * "강제 푸시로 A 가 B 의 조상이 아니면 … 갈라진 이력 표시" · 임의 커밋 조회 통로가 되지 않게(목록 밖 commit 거절).
 * master · GitHub 클라이언트는 가짜 객체(이 층은 조립만 본다 — 응답 해석은 github-client.test · deploy-history.test 가 본다). */
import { describe, expect, it, vi } from "vitest";
import type { DeployHistoryClient, DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import type { DeployDetailQuery } from "@/features/deploy-detail/lib/deploy-detail-query";
import { DEPLOY_DETAIL_HISTORY_LIMIT, buildDeployDetail, type DeployDetailOutcome, type DeployDetailView } from "@/features/deploy-detail/lib/deploy-detail-view";
import type { CommitComparison, CommitDetail, CommitSummary, GitHubClient, PullRequestSummary } from "@/features/deploy-detail/lib/github-client";
import { REPOSITORY_WEB, fakeSha } from "@/features/deploy-detail/lib/github-test-fakes";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";
import { expectFailure, okValue } from "@/shared/lib/upstream-test-fakes";

const SHA_A = fakeSha(1);
const SHA_B = fakeSha(2);
const SHA_MIDDLE = fakeSha(3);

function deployment(requestId: string, commitSha: string, overrides: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    requestId, state: "succeeded", service: "backend", commitSha, failedStage: null, acceptedAt: "2026-11-22T01:00:00Z",
    finishedAt: "2026-11-22T01:05:00Z", integrationMilliseconds: 60_000, deliveryMilliseconds: 30_000, ...overrides,
  };
}

function summary(sha: string, title = `commit ${sha.slice(0, 7)}`): CommitSummary {
  return { sha, title, message: title, authorName: "Jun", authoredAt: "2026-11-22T01:00:00Z", htmlUrl: `${REPOSITORY_WEB}/commit/${sha}` };
}

function detail(sha: string): CommitDetail {
  return {
    ...summary(sha), hasMoreFiles: false,
    files: [{ filename: "a.ts", previousFilename: null, status: "modified", additions: 1, deletions: 1, patch: { kind: "text", text: "@@\n-a\n+b", truncated: false, totalLines: 3 } }],
  };
}

function comparison(commits: CommitSummary[], overrides: Partial<CommitComparison> = {}): CommitComparison {
  return {
    status: "ahead", aheadBy: commits.length, behindBy: 0, totalCommits: commits.length, commits, hasMoreCommits: false,
    htmlUrl: `${REPOSITORY_WEB}/compare/${SHA_A}...${SHA_B}`, ...overrides,
  };
}

function pullRequest(number: number, mergedAt: string | null): PullRequestSummary {
  return { number, title: `PR ${number}`, body: `본문 ${number}`, state: mergedAt === null ? "open" : "closed", mergedAt, htmlUrl: `${REPOSITORY_WEB}/pull/${number}` };
}

const NORMAL_LIST = [
  deployment("selected", SHA_B, { state: "succeeded" }),
  deployment("previous", SHA_A),
];

function fakes(options: {
  deployments?: UpstreamResult<DeploymentSummary[]>;
  compare?: UpstreamResult<CommitComparison>;
  commit?: (sha: string) => UpstreamResult<CommitDetail>;
  pulls?: UpstreamResult<PullRequestSummary[]>;
} = {}) {
  const deployHistory: DeployHistoryClient = {
    listDeployments: vi.fn(async () => options.deployments ?? { ok: true as const, value: NORMAL_LIST }),
  };
  const github = {
    compareCommits: vi.fn(async () => options.compare ?? { ok: true as const, value: comparison([summary(SHA_MIDDLE), summary(SHA_B)]) }),
    getCommit: vi.fn(async (_repository: unknown, sha: string) => (options.commit ? options.commit(sha) : { ok: true as const, value: detail(sha) })),
    listPullRequestsForCommit: vi.fn(async () => options.pulls ?? { ok: true as const, value: [pullRequest(12, "2026-11-22T00:00:00Z")] }),
  } satisfies GitHubClient;
  return { deployHistory, github };
}

function query(overrides: Partial<DeployDetailQuery> = {}): DeployDetailQuery {
  return { service: "backend", selectedRequestId: "selected", commitSha: null, ...overrides };
}

function viewOf(outcome: DeployDetailOutcome): DeployDetailView {
  expect(outcome.kind, JSON.stringify(outcome)).toBe("view");
  if (outcome.kind !== "view") throw new Error("expected view");
  return outcome.view;
}

const REPOSITORY = { owner: "junhyeong9812", name: "study-note-deploy-system-backend" };

describe("buildDeployDetail — 정상(A→B)", () => {
  it("master 를 service · limit 200 으로 한 번 부르고, 요약 · 범위 · 저장소 · PR · 커밋 목록을 낸다(commit 없으면 null)", async () => {
    const dependencies = fakes();
    const view = viewOf(await buildDeployDetail(dependencies, query()));
    expect(DEPLOY_DETAIL_HISTORY_LIMIT).toBe(200);
    expect(dependencies.deployHistory.listDeployments).toHaveBeenCalledTimes(1);
    expect(dependencies.deployHistory.listDeployments).toHaveBeenCalledWith({ service: "backend", limit: 200 });
    expect(view.query).toEqual(query());
    expect(okValue(view.deployment)).toEqual(NORMAL_LIST[0]);
    expect(view.range).toEqual({ status: "range", baseRequestId: "previous", baseCommitSha: SHA_A, headCommitSha: SHA_B });
    expect(view.repository).toEqual(REPOSITORY);
    expect(okValue(view.pullRequest!)).toEqual(pullRequest(12, "2026-11-22T00:00:00Z"));
    expect(okValue(view.commits!)).toEqual({
      comparisonStatus: "ahead", diverged: false, commits: [summary(SHA_MIDDLE), summary(SHA_B)], totalCommits: 2, hasMoreCommits: false,
      htmlUrl: `${REPOSITORY_WEB}/compare/${SHA_A}...${SHA_B}`,
    });
    expect(view.commit).toBeNull();
    expect(dependencies.github.compareCommits).toHaveBeenCalledWith(REPOSITORY, SHA_A, SHA_B);
    expect(dependencies.github.listPullRequestsForCommit).toHaveBeenCalledWith(REPOSITORY, SHA_B);
    expect(dependencies.github.getCommit).not.toHaveBeenCalled();
  });

  it("commit 이 목록에 있으면 그 커밋의 파일 · diff", async () => {
    const dependencies = fakes();
    const view = viewOf(await buildDeployDetail(dependencies, query({ commitSha: SHA_MIDDLE })));
    expect(okValue(view.commit!)).toEqual(detail(SHA_MIDDLE));
    expect(dependencies.github.getCommit).toHaveBeenCalledWith(REPOSITORY, SHA_MIDDLE);
  });

  it("commit 은 대소문자 무관 완전 일치 — 목록의 SHA 로 부른다", async () => {
    const dependencies = fakes();
    const view = viewOf(await buildDeployDetail(dependencies, query({ commitSha: SHA_MIDDLE.toUpperCase() })));
    expect(view.commit?.ok).toBe(true);
    expect(dependencies.github.getCommit).toHaveBeenCalledWith(REPOSITORY, SHA_MIDDLE);
  });

  it.each([
    ["목록 밖의 임의 커밋", fakeSha(99)],
    ["A 자신(비교 목록에는 없다)", SHA_A],
    ["목록 커밋의 앞 7자(완전 일치 아님)", SHA_MIDDLE.slice(0, 7)],
  ])("목록 밖 commit(%s) → invalid_input(commit), 그 커밋은 부르지 않는다", async (_label, commitSha) => {
    const dependencies = fakes();
    expect(await buildDeployDetail(dependencies, query({ commitSha }))).toEqual({ kind: "invalid_input", field: "commit" });
    expect(dependencies.github.getCommit).not.toHaveBeenCalled();
  });

  it("갈라진 이력 — diverged 표시 칸", async () => {
    const dependencies = fakes({ compare: { ok: true, value: comparison([summary(SHA_B)], { status: "diverged", behindBy: 2 }) } });
    const commits = okValue(viewOf(await buildDeployDetail(dependencies, query())).commits!);
    expect(commits.comparisonStatus).toBe("diverged");
    expect(commits.diverged).toBe(true);
    expect(commits.commits).toEqual([summary(SHA_B)]);
  });

  it("커밋 상한을 넘은 비교 — 더 있음과 전체 수를 그대로", async () => {
    const dependencies = fakes({ compare: { ok: true, value: comparison([summary(SHA_B)], { totalCommits: 150, hasMoreCommits: true }) } });
    const commits = okValue(viewOf(await buildDeployDetail(dependencies, query())).commits!);
    expect(commits.hasMoreCommits).toBe(true);
    expect(commits.totalCommits).toBe(150);
    expect(commits.htmlUrl).toBe(`${REPOSITORY_WEB}/compare/${SHA_A}...${SHA_B}`);
  });
});

describe("buildDeployDetail — PR", () => {
  it("PR 없음 → ok:null", async () => {
    const view = viewOf(await buildDeployDetail(fakes({ pulls: { ok: true, value: [] } }), query()));
    expect(view.pullRequest).toEqual({ ok: true, value: null });
  });

  it("PR 여럿 — 병합된 것 우선", async () => {
    const pulls = [pullRequest(20, null), pullRequest(15, "2026-11-22T00:00:00Z"), pullRequest(16, "2026-11-22T00:30:00Z")];
    const view = viewOf(await buildDeployDetail(fakes({ pulls: { ok: true, value: pulls } }), query()));
    expect(okValue(view.pullRequest!)?.number).toBe(15);
  });
});

describe("buildDeployDetail — A 없음 · A==B · 선택한 배포 없음", () => {
  it("A 없음 — B 커밋 하나(getCommit(B))만, 비교는 부르지 않는다", async () => {
    const dependencies = fakes({ deployments: { ok: true, value: [deployment("selected", SHA_B)] } });
    const view = viewOf(await buildDeployDetail(dependencies, query()));
    expect(view.range).toEqual({ status: "no_previous", baseRequestId: null, baseCommitSha: null, headCommitSha: SHA_B });
    expect(okValue(view.commits!)).toEqual({
      comparisonStatus: null, diverged: false, commits: [summary(SHA_B)], totalCommits: 1, hasMoreCommits: false, htmlUrl: `${REPOSITORY_WEB}/commit/${SHA_B}`,
    });
    expect(dependencies.github.compareCommits).not.toHaveBeenCalled();
    expect(dependencies.github.getCommit).toHaveBeenCalledWith(REPOSITORY, SHA_B);
  });

  it("A 없음 + commit=B → 그 커밋의 파일 · diff", async () => {
    const dependencies = fakes({ deployments: { ok: true, value: [deployment("selected", SHA_B)] } });
    const view = viewOf(await buildDeployDetail(dependencies, query({ commitSha: SHA_B })));
    expect(okValue(view.commit!)).toEqual(detail(SHA_B));
  });

  it("A 없음 + B 커밋 조회 실패 → commits 칸만 실패, 요약 · PR 은 그대로", async () => {
    const dependencies = fakes({ deployments: { ok: true, value: [deployment("selected", SHA_B)] }, commit: () => upstreamFailure("not_found", { status: 422 }) });
    const view = viewOf(await buildDeployDetail(dependencies, query()));
    expectFailure(view.commits!, "not_found", 422);
    expect(view.deployment.ok).toBe(true);
    expect(view.pullRequest?.ok).toBe(true);
  });

  it("A==B — 변경 없음: 커밋 목록은 비어 있고 GitHub 비교 · 커밋 조회를 부르지 않는다(PR 은 B 기준으로 그대로)", async () => {
    const dependencies = fakes({ deployments: { ok: true, value: [deployment("selected", SHA_B), deployment("previous", SHA_B)] } });
    const view = viewOf(await buildDeployDetail(dependencies, query()));
    expect(view.range?.status).toBe("same_commit");
    expect(okValue(view.commits!)).toEqual({ comparisonStatus: null, diverged: false, commits: [], totalCommits: 0, hasMoreCommits: false, htmlUrl: null });
    expect(dependencies.github.compareCommits).not.toHaveBeenCalled();
    expect(dependencies.github.getCommit).not.toHaveBeenCalled();
    expect(okValue(view.pullRequest!)?.number).toBe(12);
  });

  it("A==B + commit → 목록이 비어 있으므로 invalid_input(commit)", async () => {
    const dependencies = fakes({ deployments: { ok: true, value: [deployment("selected", SHA_B), deployment("previous", SHA_B)] } });
    expect(await buildDeployDetail(dependencies, query({ commitSha: SHA_B }))).toEqual({ kind: "invalid_input", field: "commit" });
    expect(dependencies.github.getCommit).not.toHaveBeenCalled();
  });

  it("선택한 배포 없음 → not_found, GitHub 를 부르지 않는다", async () => {
    const dependencies = fakes();
    expect(await buildDeployDetail(dependencies, query({ selectedRequestId: "missing" }))).toEqual({ kind: "not_found" });
    expect(dependencies.github.compareCommits).not.toHaveBeenCalled();
    expect(dependencies.github.getCommit).not.toHaveBeenCalled();
    expect(dependencies.github.listPullRequestsForCommit).not.toHaveBeenCalled();
  });

  it("진행 중인 배포 선택 — A 는 앞선 성공, 요약의 상태는 진행 중 그대로", async () => {
    const list = [deployment("selected", SHA_B, { state: "cd_running", finishedAt: null }), deployment("previous", SHA_A)];
    const view = viewOf(await buildDeployDetail(fakes({ deployments: { ok: true, value: list } }), query()));
    expect(okValue(view.deployment).state).toBe("cd_running");
    expect(view.range?.baseRequestId).toBe("previous");
  });

  it("실패한 배포 선택 — A 는 사이의 실패를 건너뛴 직전 성공", async () => {
    const list = [
      deployment("selected", SHA_B, { state: "failed", failedStage: "ci_test" }),
      deployment("failed-between", SHA_MIDDLE, { state: "failed", failedStage: "cd_health" }),
      deployment("previous", SHA_A),
    ];
    const dependencies = fakes({ deployments: { ok: true, value: list } });
    const view = viewOf(await buildDeployDetail(dependencies, query()));
    expect(okValue(view.deployment).failedStage).toBe("ci_test");
    expect(view.range).toEqual({ status: "range", baseRequestId: "previous", baseCommitSha: SHA_A, headCommitSha: SHA_B });
    expect(dependencies.github.compareCommits).toHaveBeenCalledWith(REPOSITORY, SHA_A, SHA_B);
  });
});

describe("buildDeployDetail — 실패는 칸의 결과로", () => {
  it("master 실패 → deployment = 그 실패, 나머지 칸 null, GitHub 를 부르지 않는다", async () => {
    const dependencies = fakes({ deployments: upstreamFailure("timeout") });
    const view = viewOf(await buildDeployDetail(dependencies, query({ commitSha: SHA_B })));
    expectFailure(view.deployment, "timeout");
    expect(view.range).toBeNull();
    expect(view.repository).toBeNull();
    expect(view.pullRequest).toBeNull();
    expect(view.commits).toBeNull();
    expect(view.commit).toBeNull();
    expect(dependencies.github.compareCommits).not.toHaveBeenCalled();
    expect(dependencies.github.listPullRequestsForCommit).not.toHaveBeenCalled();
  });

  it("비교가 한도 초과 → commits 만 실패, 요약 · 범위 · PR 은 그대로", async () => {
    const view = viewOf(await buildDeployDetail(fakes({ compare: upstreamFailure("rate_limited", { status: 403 }) }), query()));
    expectFailure(view.commits!, "rate_limited", 403);
    expect(view.deployment.ok).toBe(true);
    expect(view.range?.status).toBe("range");
    expect(view.pullRequest?.ok).toBe(true);
  });

  it("PR 조회 실패 → pullRequest 만 실패, 커밋 목록은 그대로", async () => {
    const view = viewOf(await buildDeployDetail(fakes({ pulls: upstreamFailure("unavailable", { status: 503 }) }), query()));
    expectFailure(view.pullRequest!, "unavailable", 503);
    expect(view.commits?.ok).toBe(true);
  });

  it("비교 실패 + commit → 목록을 확인할 수 없으므로 commit 도 같은 이유로 실패, 커밋 조회는 부르지 않는다", async () => {
    const dependencies = fakes({ compare: upstreamFailure("timeout") });
    const view = viewOf(await buildDeployDetail(dependencies, query({ commitSha: SHA_B })));
    expectFailure(view.commits!, "timeout");
    expectFailure(view.commit!, "timeout");
    expect(dependencies.github.getCommit).not.toHaveBeenCalled();
  });

  it("고른 커밋 조회 실패 → commit 만 실패, 목록은 그대로", async () => {
    const view = viewOf(await buildDeployDetail(fakes({ commit: () => upstreamFailure("bad_status", { status: 500 }) }), query({ commitSha: SHA_B })));
    expectFailure(view.commit!, "bad_status", 500);
    expect(view.commits?.ok).toBe(true);
  });

  it.each([
    ["B 가 16진수가 아님", [deployment("selected", "not-a-sha-value"), deployment("previous", SHA_A)]],
    ["A 가 너무 짧음", [deployment("selected", SHA_B), deployment("previous", "abc")]],
  ])("master 가 준 SHA 가 형식 밖(%s) → GitHub 칸 = unparseable, GitHub 를 부르지 않는다(요약은 그대로)", async (_label, list) => {
    const dependencies = fakes({ deployments: { ok: true, value: list } });
    const view = viewOf(await buildDeployDetail(dependencies, query()));
    expect(view.deployment.ok).toBe(true);
    expectFailure(view.pullRequest!, "unparseable");
    expectFailure(view.commits!, "unparseable");
    expect(dependencies.github.compareCommits).not.toHaveBeenCalled();
    expect(dependencies.github.getCommit).not.toHaveBeenCalled();
    expect(dependencies.github.listPullRequestsForCommit).not.toHaveBeenCalled();
  });
});
