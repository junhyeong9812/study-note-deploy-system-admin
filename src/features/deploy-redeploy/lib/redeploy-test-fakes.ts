/** 테스트 전용 — 재배포 확인 화면의 가짜 master: 버전 목록의 가짜(createFakeMaster)에 **가지가 갈라지는 git 이력**을 얹는다.
 * 커밋마다 부모 하나(parentSha). 범위 조회 A..B(ci-cd internal/agent/git_read.go readCommitRange · relation):
 * - A 가 B 의 조상(같은 커밋 포함) → relation ancestor, commits = B 에서 부모를 따라 A 직전까지(B 쪽이 먼저), 101개 이상이면 앞 100개 + truncated
 * - 그 밖 → not_ancestor, commits [](이력이 온전한 가짜라 unknown 은 내지 않는다 — unknown 은 사례가 override 로 끼운다)
 * - A · B 가 이력에 없으면 404 commit_not_found. 커밋 하나 조회는 앞부분이 맞는 커밋, 없으면 404. */
import { gitCommitDetailJson, gitCommitJson, gitCommitRangeJson, masterGitFailure, masterGitSuccess } from "@/features/deploy-detail/lib/deploy-git-test-fakes";
import {
  MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH, uniqueSha, type FakeMaster,
} from "@/features/deploy-versions/lib/deploy-versions-test-fakes";

export interface GraphCommit {
  sha: string;
  subject: string;
  /** 첫 커밋이면 null */
  parentSha: string | null;
}

/** parent 뒤에 한 줄로 이어지는 커밋들(오래된 것 먼저). parent 가 null 이면 뿌리부터. */
export function branchFrom(parent: GraphCommit | null, subjects: string[]): GraphCommit[] {
  const commits: GraphCommit[] = [];
  let parentSha = parent?.sha ?? null;
  for (const subject of subjects) {
    const commit = { sha: uniqueSha(), subject, parentSha };
    commits.push(commit);
    parentSha = commit.sha;
  }
  return commits;
}

const GIT_COMMIT_LIST_LIMIT = 100;

/** master 의 두 git 경로를 이 이력으로 답하게 한다(이미 끼운 override 는 덮어쓴다). */
export function installCommitGraph(master: FakeMaster, graph: readonly GraphCommit[]): void {
  const bySha = new Map(graph.map((commit) => [commit.sha, commit]));
  master.override[MASTER_GIT_COMMITS_PATH] = (url) => {
    const from = bySha.get((url.searchParams.get("from") ?? "").toLowerCase());
    const to = bySha.get((url.searchParams.get("to") ?? "").toLowerCase());
    if (from === undefined || to === undefined) return masterGitFailure(404, "commit_not_found");
    const walk: GraphCommit[] = [];
    let cursor: GraphCommit | undefined = to;
    while (cursor !== undefined && cursor.sha !== from.sha) {
      walk.push(cursor);
      cursor = cursor.parentSha === null ? undefined : bySha.get(cursor.parentSha);
    }
    if (cursor === undefined) return masterGitSuccess(gitCommitRangeJson([], { relation: "not_ancestor" }));
    const truncated = walk.length > GIT_COMMIT_LIST_LIMIT;
    const commits = walk.slice(0, GIT_COMMIT_LIST_LIMIT).map((commit) => gitCommitJson(commit.sha, { subject: commit.subject }));
    return masterGitSuccess(gitCommitRangeJson(commits, { truncated }));
  };
  master.override[MASTER_GIT_COMMIT_PATH] = (url) => {
    const sha = (url.searchParams.get("sha") ?? "").toLowerCase();
    const commit = sha.length > 0 ? graph.find((each) => each.sha.startsWith(sha)) : undefined;
    if (commit === undefined) return masterGitFailure(404, "commit_not_found");
    return masterGitSuccess(gitCommitDetailJson(commit.sha, [], { subject: commit.subject }));
  };
}

/** 범위 조회 가운데 양 끝이 {첫째, 둘째}(순서 무관)인 것 — 방향을 알아내려는 조회. */
export function rangeRequestsBetween(master: FakeMaster, firstSha: string, secondSha: string): URL[] {
  const pair = [firstSha, secondSha].sort().join(" ");
  return master.gitRequests().filter((url) => url.pathname === MASTER_GIT_COMMITS_PATH
    && [url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? ""].sort().join(" ") === pair);
}
