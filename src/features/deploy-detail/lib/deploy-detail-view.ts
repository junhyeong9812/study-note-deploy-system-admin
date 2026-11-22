/** 배포 상세 조립(순수 — master 클라이언트와 GitHub 클라이언트는 주입). 명세 §10.2.
 * 순서:
 * 1. master `GET /deploys?service=<query.service>&limit=200`(DEPLOY_DETAIL_HISTORY_LIMIT). 실패하면 view 의 deployment = 그 실패, 나머지 칸 = null(GitHub 를 부르지 않는다).
 * 2. findDeployRange 로 선택한 배포 · A · B. 선택한 요청 ID 가 목록에 없으면 { kind: "not_found" }(GitHub 를 부르지 않는다).
 * 3. 저장소 = githubRepositoryFor(선택한 배포의 service). A · B 의 SHA 가 16진수 7~40자가 아니거나 저장소가 없으면 GitHub 칸 셋 = unparseable(부르지 않는다).
 * 4. pullRequest = B 의 PR 목록 → choosePullRequest(없으면 ok:null). 범위와 무관하게 언제나 B 기준.
 * 5. commits:
 *    - range: compareCommits(A, B) → { comparisonStatus, diverged: status==="diverged", commits, totalCommits, hasMoreCommits, htmlUrl }
 *    - no_previous: getCommit(B) 의 요약 하나 → { comparisonStatus:null, diverged:false, commits:[B], totalCommits:1, hasMoreCommits:false, htmlUrl: B 의 htmlUrl }
 *    - same_commit: 부르지 않는다 → { comparisonStatus:null, diverged:false, commits:[], totalCommits:0, hasMoreCommits:false, htmlUrl:null }
 * 6. commit(query.commitSha 가 있을 때만, 없으면 null):
 *    - commits 칸이 실패면 commit 도 같은 이유의 실패(목록을 확인할 수 없으므로 부르지 않는다).
 *    - commits 칸의 목록에 든 SHA 와 대소문자 무관 **완전 일치**가 없으면 { kind: "invalid_input", field: "commit" }(그 커밋은 부르지 않는다 — 임의 커밋 조회 통로 차단).
 *    - 있으면 getCommit(목록의 SHA).
 * GitHub 칸 하나가 실패해도 다른 칸과 deployment 는 그대로 낸다. */
import type { DeployHistoryClient, DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import { isCommitSha, type DeployDetailQuery } from "@/features/deploy-detail/lib/deploy-detail-query";
import { findDeployRange, isSameCommit, type DeployRange } from "@/features/deploy-detail/lib/deploy-range";
import { githubRepositoryFor, type GitHubRepository } from "@/features/deploy-detail/lib/github-repository";
import {
  choosePullRequest, type CommitDetail, type CommitSummary, type ComparisonStatus, type GitHubClient, type PullRequestSummary,
} from "@/features/deploy-detail/lib/github-client";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

/** A 를 찾으려고 master 에서 읽는 건수(master 의 상한과 같다 — 그 밖은 "이력 밖" = A 없음). */
export const DEPLOY_DETAIL_HISTORY_LIMIT = 200;

export interface CommitListView {
  /** range 일 때 compare 의 status, 그 밖은 null */
  comparisonStatus: ComparisonStatus | null;
  /** 갈라진 이력(compare status "diverged") */
  diverged: boolean;
  commits: CommitSummary[];
  totalCommits: number;
  hasMoreCommits: boolean;
  /** GitHub 에서 보기 — same_commit 이면 null */
  htmlUrl: string | null;
}

export interface DeployDetailView {
  query: DeployDetailQuery;
  /** 선택한 배포의 요약(master 실패면 그 이유) */
  deployment: UpstreamResult<DeploymentSummary>;
  /** master 실패면 null */
  range: DeployRange | null;
  /** master 실패면 null */
  repository: GitHubRepository | null;
  /** master 실패면 null. ok 의 value 가 null = PR 없음 */
  pullRequest: UpstreamResult<PullRequestSummary | null> | null;
  /** master 실패면 null */
  commits: UpstreamResult<CommitListView> | null;
  /** commit 인자가 없거나 master 실패면 null */
  commit: UpstreamResult<CommitDetail> | null;
}

export type DeployDetailOutcome =
  | { kind: "view"; view: DeployDetailView }
  | { kind: "not_found" }
  | { kind: "invalid_input"; field: string };

export interface DeployDetailDependencies {
  deployHistory: DeployHistoryClient;
  github: GitHubClient;
}

function summaryOf(detail: CommitDetail): CommitSummary {
  const { sha, title, message, authorName, authoredAt, htmlUrl } = detail;
  return { sha, title, message, authorName, authoredAt, htmlUrl };
}

async function loadPullRequest(github: GitHubClient, repository: GitHubRepository, headSha: string): Promise<UpstreamResult<PullRequestSummary | null>> {
  const result = await github.listPullRequestsForCommit(repository, headSha);
  return result.ok ? { ok: true, value: choosePullRequest(result.value) } : result;
}

/** commits 칸과(no_previous 일 때) 이미 받은 B 커밋 — 고른 커밋이 B 면 다시 부르지 않는다. */
async function loadCommits(github: GitHubClient, repository: GitHubRepository, range: DeployRange): Promise<{ commits: UpstreamResult<CommitListView>; headDetail: CommitDetail | null }> {
  if (range.status === "same_commit") {
    return { commits: { ok: true, value: { comparisonStatus: null, diverged: false, commits: [], totalCommits: 0, hasMoreCommits: false, htmlUrl: null } }, headDetail: null };
  }
  if (range.status === "no_previous") {
    const head = await github.getCommit(repository, range.headCommitSha);
    if (!head.ok) return { commits: head, headDetail: null };
    return {
      commits: { ok: true, value: { comparisonStatus: null, diverged: false, commits: [summaryOf(head.value)], totalCommits: 1, hasMoreCommits: false, htmlUrl: head.value.htmlUrl } },
      headDetail: head.value,
    };
  }
  const comparison = await github.compareCommits(repository, range.baseCommitSha as string, range.headCommitSha);
  if (!comparison.ok) return { commits: comparison, headDetail: null };
  const { status, commits, totalCommits, hasMoreCommits, htmlUrl } = comparison.value;
  return { commits: { ok: true, value: { comparisonStatus: status, diverged: status === "diverged", commits, totalCommits, hasMoreCommits, htmlUrl } }, headDetail: null };
}

export async function buildDeployDetail(dependencies: DeployDetailDependencies, query: DeployDetailQuery): Promise<DeployDetailOutcome> {
  const listed = await dependencies.deployHistory.listDeployments({ service: query.service, limit: DEPLOY_DETAIL_HISTORY_LIMIT });
  if (!listed.ok) {
    return { kind: "view", view: { query, deployment: listed, range: null, repository: null, pullRequest: null, commits: null, commit: null } };
  }
  const found = findDeployRange(listed.value, query.selectedRequestId);
  if (found === null) return { kind: "not_found" };
  const { selected, range } = found;
  const deployment: UpstreamResult<DeploymentSummary> = { ok: true, value: selected };
  const repository = githubRepositoryFor(selected.service);
  const shasReadable = isCommitSha(range.headCommitSha) && (range.baseCommitSha === null || isCommitSha(range.baseCommitSha));
  if (repository === null || !shasReadable) {
    const unparseable = upstreamFailure("unparseable");
    return {
      kind: "view",
      view: { query, deployment, range, repository, pullRequest: unparseable, commits: unparseable, commit: query.commitSha === null ? null : unparseable },
    };
  }

  const [pullRequest, { commits, headDetail }] = await Promise.all([
    loadPullRequest(dependencies.github, repository, range.headCommitSha),
    loadCommits(dependencies.github, repository, range),
  ]);

  let commit: UpstreamResult<CommitDetail> | null = null;
  if (query.commitSha !== null) {
    const chosenSha = query.commitSha;
    if (!commits.ok) {
      commit = commits;   // 목록을 확인할 수 없으므로 부르지 않는다
    } else {
      const listedCommit = commits.value.commits.find((summary) => isSameCommit(summary.sha, chosenSha));
      if (listedCommit === undefined) return { kind: "invalid_input", field: "commit" };   // 임의 커밋 조회 통로 차단
      commit = headDetail !== null && headDetail.sha === listedCommit.sha
        ? { ok: true, value: headDetail }
        : await dependencies.github.getCommit(repository, listedCommit.sha);
    }
  }
  return { kind: "view", view: { query, deployment, range, repository, pullRequest, commits, commit } };
}
