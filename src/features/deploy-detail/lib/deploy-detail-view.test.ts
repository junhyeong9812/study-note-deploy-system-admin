/** 배포 상세 조립 — 명세 §10.2 "상세에 담는 것: 배포 요약 · PR · A→B 커밋 목록 · 고른 커밋의 파일과 diff" ·
 * "실패해도 배포 요약과 목록은 그대로 보이고 상세 자리에 이유만" · "A 와 B 가 같으면 변경 없음" · 임의 커밋 조회 통로가 되지 않게(목록 밖 commit 거절).
 * master 배포 이력 · master git · GitHub(PR) 클라이언트는 가짜 객체(이 층은 조립만 본다 — 응답 해석은 deploy-git-client.test · github-client.test · deploy-history.test 가 본다).
 * 커밋 목록 · diff 의 출처 교체(master git)와 relation · B 로 물러서기는 deploy-detail-view-git.test 가 본다. */
import { describe, expect, it, vi } from "vitest";
import type { DeployHistoryClient, DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import type { DeployDetailQuery } from "@/features/deploy-detail/lib/deploy-detail-query";
import { DEPLOY_DETAIL_HISTORY_LIMIT, buildDeployDetail, type DeployDetailOutcome, type DeployDetailView } from "@/features/deploy-detail/lib/deploy-detail-view";
import type { DeployGitClient, GitCommit, GitCommitDetail, GitCommitRange } from "@/features/deploy-detail/lib/deploy-git-client";
import type { GitHubClient, PullRequestSummary } from "@/features/deploy-detail/lib/github-client";
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

function gitCommit(sha: string): GitCommit {
  return { sha, authorName: "Jun", authoredAt: "2026-11-22T01:00:00Z", subject: `commit ${sha.slice(0, 7)}`, body: "", bodyTruncated: false };
}

function gitRange(commits: GitCommit[]): GitCommitRange {
  return { commits, truncated: false, rangeComplete: true, relation: "ancestor" };
}

function gitDetail(sha: string): GitCommitDetail {
  return {
    ...gitCommit(sha), filesTruncated: false,
    files: [{ path: "a.ts", previousPath: null, status: "modified", additions: 1, deletions: 1, binary: false, patch: "@@\n-a\n+b", patchTruncated: false, patchTotalLines: 3 }],
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
  const github = {
    listPullRequestsForCommit: vi.fn(async () => options.pulls ?? { ok: true as const, value: [pullRequest(12, "2026-11-22T00:00:00Z")] }),
  } satisfies GitHubClient;
  return { deployHistory, deployGit, github };
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
  it("master 를 service · limit 200 으로 한 번 부르고, query · 요약 · 범위 · 저장소 · PR 을 낸다(commit 없으면 null)", async () => {
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
    expect(okValue(view.commits!).commits.map((commit) => commit.sha)).toEqual([SHA_MIDDLE, SHA_B]);
    expect(view.commit).toBeNull();
    expect(dependencies.deployGit.listCommits).toHaveBeenCalledWith("backend", SHA_A, SHA_B);
    expect(dependencies.github.listPullRequestsForCommit).toHaveBeenCalledWith(REPOSITORY, SHA_B);
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalled();
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

describe("buildDeployDetail — A==B · 진행 중 · 실패한 배포", () => {
  it("A==B + commit → 목록이 비어 있으므로 invalid_input(commit), 커밋 조회는 부르지 않는다", async () => {
    const dependencies = fakes({ deployments: { ok: true, value: [deployment("selected", SHA_B), deployment("previous", SHA_B)] } });
    expect(await buildDeployDetail(dependencies, query({ commitSha: SHA_B }))).toEqual({ kind: "invalid_input", field: "commit" });
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalled();
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
    expect(dependencies.deployGit.listCommits).toHaveBeenCalledWith("backend", SHA_A, SHA_B);
  });
});

describe("buildDeployDetail — 실패는 칸의 결과로", () => {
  it("master 실패 → deployment = 그 실패, 나머지 칸 null, master git · GitHub 를 부르지 않는다", async () => {
    const dependencies = fakes({ deployments: upstreamFailure("timeout") });
    const view = viewOf(await buildDeployDetail(dependencies, query({ commitSha: SHA_B })));
    expectFailure(view.deployment, "timeout");
    expect(view.range).toBeNull();
    expect(view.repository).toBeNull();
    expect(view.pullRequest).toBeNull();
    expect(view.commits).toBeNull();
    expect(view.commit).toBeNull();
    expect(dependencies.deployGit.listCommits).not.toHaveBeenCalled();
    expect(dependencies.deployGit.getCommit).not.toHaveBeenCalled();
    expect(dependencies.github.listPullRequestsForCommit).not.toHaveBeenCalled();
  });

  it("PR 조회 실패 → pullRequest 만 실패, 커밋 목록은 그대로", async () => {
    const view = viewOf(await buildDeployDetail(fakes({ pulls: upstreamFailure("unavailable", { status: 503 }) }), query()));
    expectFailure(view.pullRequest!, "unavailable", 503);
    expect(view.commits?.ok).toBe(true);
  });
});
