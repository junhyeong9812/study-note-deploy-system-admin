/** 배포 상세 조립(순수 — master 배포 이력 · master git 조회 · GitHub 클라이언트는 주입). 명세 §10.2 · §10.3 · §12.2 어드민 항 · 12.11.
 * 커밋 목록 · diff 는 master git 조회(deployGit), PR 만 GitHub(github.listPullRequestsForCommit).
 * 순서:
 * 1. master `GET /deploys?service=<query.service>&limit=200`(DEPLOY_DETAIL_HISTORY_LIMIT). 실패하면 view 의 deployment = 그 실패, 나머지 칸 = null(다른 곳을 부르지 않는다).
 * 2. findDeployRange 로 선택한 배포 · A · B. 선택한 요청 ID 가 목록에 없으면 { kind: "not_found" }(다른 곳을 부르지 않는다).
 * 3. 저장소 = githubRepositoryFor(선택한 배포의 service). A · B 의 SHA 가 16진수 7~40자가 아니거나 저장소가 없으면 PR · 커밋 칸 = unparseable(부르지 않는다).
 * 4. pullRequest = B 의 PR 목록 → choosePullRequest(없으면 ok:null). 범위와 무관하게 언제나 B 기준.
 * 5. commits(CommitListView):
 *    - range: listCommits(서비스, A, B). relation ancestor → 커밋을 오래된 것 먼저로(master 는 B 먼저) · hasMoreCommits = truncated · 비교 주소.
 *      범위로 B 를 보일 수 없으면 B 하나로 물러선다(12.11) — not_ancestor · unknown 이면 getCommit(B) 를 붙이고(실패면 빈 목록 + headFailure),
 *      범위 조회가 실패하면 getCommit(B) 를 붙이고 rangeFailure 에 그 실패(B 도 실패면 commits 칸 = 범위의 실패).
 *    - no_previous: getCommit(B) 하나(실패면 commits 칸 = 그 실패). htmlUrl = B 의 커밋 주소.
 *    - same_commit: 부르지 않는다 → 빈 목록 · htmlUrl null.
 * 6. commit(query.commitSha 가 있을 때만, 없으면 null):
 *    - commits 칸이 실패면 commit 도 같은 실패(목록을 확인할 수 없으므로 부르지 않는다).
 *    - commits 칸의 목록에 든 SHA 와 대소문자 무관 **완전 일치**가 없으면 { kind: "invalid_input", field: "commit" }(임의 커밋 조회 통로 차단)
 *      — 단 B 하나로 물러섰는데 B 조회가 실패했고 commit 이 B 면 commit = 그 실패.
 *    - 있으면 이미 받은 B 를 쓰거나 getCommit(서비스, 목록의 SHA).
 * 한 칸이 실패해도 다른 칸과 deployment 는 그대로 낸다. */
import type { DeployHistoryClient, DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import type { DeployService } from "@/features/deploys/lib/deploy-history-query";
import { isCommitSha, type DeployDetailQuery } from "@/features/deploy-detail/lib/deploy-detail-query";
import type { DeployGitClient, GitCommit, GitCommitDetail, GitFileChange, GitRelation } from "@/features/deploy-detail/lib/deploy-git-client";
import { findDeployRange, isSameCommit, type DeployRange } from "@/features/deploy-detail/lib/deploy-range";
import { githubCommitUrl, githubCompareUrl, githubRepositoryFor, type GitHubRepository } from "@/features/deploy-detail/lib/github-repository";
import { choosePullRequest, type GitHubClient, type PullRequestSummary } from "@/features/deploy-detail/lib/github-client";
import { upstreamFailure, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

/** A 를 찾으려고 master 에서 읽는 건수(master 의 상한과 같다 — 그 밖은 "이력 밖" = A 없음). */
export const DEPLOY_DETAIL_HISTORY_LIMIT = 200;

/** 화면의 파일 상태 낱말(git 의 deleted 는 removed 로 옮긴다). */
export type FileChangeStatus = "added" | "removed" | "modified" | "renamed";

/** 커밋 한 줄(목록용). */
export interface CommitSummary {
  /** 전체 SHA(master 가 준 그대로) */
  sha: string;
  /** subject */
  title: string;
  /** 본문이 비면 subject, 아니면 subject + 빈 줄 + 본문(글자 그대로) */
  message: string;
  /** 본문을 master 가 잘랐다 */
  messageTruncated: boolean;
  /** 빈 글자면 null */
  authorName: string | null;
  authoredAt: string;
  /** GitHub 의 커밋 주소(링크만) */
  htmlUrl: string;
}

export type FilePatch =
  | { kind: "text"; text: string; truncated: boolean; /** null = 전체 줄 수를 모름(master 가 잘랐다) */ totalLines: number | null }
  /** binary: 바이너리 · omitted: 크기 상한으로 생략(더 있음) · empty: 내용 없는 바뀜(이름만 바뀜 · 빈 파일 등) */
  | { kind: "unavailable"; reason: "binary" | "omitted" | "empty" };

export interface CommitFileChange {
  filename: string;
  /** 이름 바뀜일 때 이전 경로 — 없으면 null */
  previousFilename: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  patch: FilePatch;
}

export interface CommitDetail extends CommitSummary {
  files: CommitFileChange[];
  hasMoreFiles: boolean;
}

export interface CommitListView {
  /** range 일 때 master 의 relation(범위 조회가 실패했으면 null), 그 밖은 null */
  relation: GitRelation | null;
  /** 오래된 것 먼저(B 가 마지막) */
  commits: CommitSummary[];
  hasMoreCommits: boolean;
  /** false 면 목록이 서버의 얕은 이력 경계에서 끝났거나 범위를 알 수 없다 */
  rangeComplete: boolean;
  /** GitHub 에서 보기 — range 는 비교 주소, no_previous 는 B 의 커밋 주소, same_commit 은 null */
  htmlUrl: string | null;
  /** 범위 조회의 실패 — B 하나를 대신 보일 때 */
  rangeFailure: UpstreamFailure | null;
  /** 대신 부른 B 조회의 실패(relation 이 not_ancestor · unknown 일 때) */
  headFailure: UpstreamFailure | null;
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
  deployGit: DeployGitClient;
  github: GitHubClient;
}

function commitSummaryOf(repository: GitHubRepository, commit: GitCommit): CommitSummary {
  return {
    sha: commit.sha,
    title: commit.subject,
    message: commit.body.length === 0 ? commit.subject : `${commit.subject}\n\n${commit.body}`,
    messageTruncated: commit.bodyTruncated,
    authorName: commit.authorName.length === 0 ? null : commit.authorName,
    authoredAt: commit.authoredAt,
    htmlUrl: githubCommitUrl(repository, commit.sha),
  };
}

function filePatchOf(file: GitFileChange): FilePatch {
  if (file.binary) return { kind: "unavailable", reason: "binary" };
  if (file.patch === null || file.patch.length === 0) return { kind: "unavailable", reason: file.patchTruncated ? "omitted" : "empty" };
  return { kind: "text", text: file.patch, truncated: file.patchTruncated, totalLines: file.patchTotalLines };
}

function fileChangeOf(file: GitFileChange): CommitFileChange {
  return {
    filename: file.path,
    previousFilename: file.previousPath,
    status: file.status === "deleted" ? "removed" : file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: filePatchOf(file),
  };
}

function commitDetailOf(repository: GitHubRepository, detail: GitCommitDetail): CommitDetail {
  return { ...commitSummaryOf(repository, detail), files: detail.files.map(fileChangeOf), hasMoreFiles: detail.filesTruncated };
}

/** 목록 한 줄 — 상세에서 요약 칸만. */
function summaryOf(detail: CommitDetail): CommitSummary {
  const { sha, title, message, messageTruncated, authorName, authoredAt, htmlUrl } = detail;
  return { sha, title, message, messageTruncated, authorName, authoredAt, htmlUrl };
}

async function loadCommit(deployGit: DeployGitClient, service: DeployService, repository: GitHubRepository, sha: string): Promise<UpstreamResult<CommitDetail>> {
  const result = await deployGit.getCommit(service, sha);
  return result.ok ? { ok: true, value: commitDetailOf(repository, result.value) } : result;
}

async function loadPullRequest(github: GitHubClient, repository: GitHubRepository, headSha: string): Promise<UpstreamResult<PullRequestSummary | null>> {
  const result = await github.listPullRequestsForCommit(repository, headSha);
  return result.ok ? { ok: true, value: choosePullRequest(result.value) } : result;
}

interface LoadedCommits {
  commits: UpstreamResult<CommitListView>;
  /** 이미 받은 B — 고른 커밋이 B 면 다시 부르지 않는다 */
  headDetail: CommitDetail | null;
  /** B 하나로 물러섰는데 B 조회가 실패했다(commit=B 면 이 실패) */
  headFailure: UpstreamFailure | null;
}

function listView(fields: Partial<CommitListView> & Pick<CommitListView, "commits" | "htmlUrl">): UpstreamResult<CommitListView> {
  return { ok: true, value: { relation: null, hasMoreCommits: false, rangeComplete: true, rangeFailure: null, headFailure: null, ...fields } };
}

async function loadCommits(deployGit: DeployGitClient, service: DeployService, repository: GitHubRepository, range: DeployRange): Promise<LoadedCommits> {
  if (range.status === "same_commit") return { commits: listView({ commits: [], htmlUrl: null }), headDetail: null, headFailure: null };
  if (range.status === "no_previous") {
    const head = await loadCommit(deployGit, service, repository, range.headCommitSha);
    if (!head.ok) return { commits: head, headDetail: null, headFailure: null };
    return { commits: listView({ commits: [summaryOf(head.value)], htmlUrl: head.value.htmlUrl }), headDetail: head.value, headFailure: null };
  }
  const baseSha = range.baseCommitSha as string;
  const compareUrl = githubCompareUrl(repository, baseSha, range.headCommitSha);
  const listed = await deployGit.listCommits(service, baseSha, range.headCommitSha);
  if (listed.ok && listed.value.relation === "ancestor") {
    const { commits, truncated, rangeComplete } = listed.value;
    const oldestFirst = commits.map((commit) => commitSummaryOf(repository, commit)).reverse();
    return {
      commits: listView({ relation: "ancestor", commits: oldestFirst, hasMoreCommits: truncated, rangeComplete, htmlUrl: compareUrl }),
      headDetail: null, headFailure: null,
    };
  }
  // 범위로 B 를 보일 수 없다(not_ancestor · unknown · 범위 조회 실패) — "이번 배포가 무엇인가"는 보이도록 B 하나를 읽는다(12.11)
  const head = await loadCommit(deployGit, service, repository, range.headCommitSha);
  if (listed.ok) {
    const { relation, rangeComplete } = listed.value;
    if (!head.ok) return { commits: listView({ relation, commits: [], rangeComplete, htmlUrl: compareUrl, headFailure: head }), headDetail: null, headFailure: head };
    return { commits: listView({ relation, commits: [summaryOf(head.value)], rangeComplete, htmlUrl: compareUrl }), headDetail: head.value, headFailure: null };
  }
  if (!head.ok) return { commits: listed, headDetail: null, headFailure: null };   // 범위 실패 문구만
  return {
    commits: listView({ commits: [summaryOf(head.value)], rangeComplete: false, htmlUrl: compareUrl, rangeFailure: listed }),
    headDetail: head.value, headFailure: null,
  };
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
  const service = selected.service as DeployService;   // 저장소 표(키 = DeployService)에 있는 서비스다

  const [pullRequest, { commits, headDetail, headFailure }] = await Promise.all([
    loadPullRequest(dependencies.github, repository, range.headCommitSha),
    loadCommits(dependencies.deployGit, service, repository, range),
  ]);

  let commit: UpstreamResult<CommitDetail> | null = null;
  if (query.commitSha !== null) {
    const chosenSha = query.commitSha;
    if (!commits.ok) {
      commit = commits;   // 목록을 확인할 수 없으므로 부르지 않는다
    } else {
      const listedCommit = commits.value.commits.find((summary) => isSameCommit(summary.sha, chosenSha));
      if (listedCommit === undefined) {
        if (headFailure === null || !isSameCommit(chosenSha, range.headCommitSha)) return { kind: "invalid_input", field: "commit" };   // 임의 커밋 조회 통로 차단
        commit = headFailure;   // 물러서 읽은 B 가 실패했다 — 다시 부르지 않는다
      } else {
        commit = headDetail !== null && headDetail.sha === listedCommit.sha
          ? { ok: true, value: headDetail }
          : await loadCommit(dependencies.deployGit, service, repository, listedCommit.sha);
      }
    }
  }
  return { kind: "view", view: { query, deployment, range, repository, pullRequest, commits, commit } };
}
