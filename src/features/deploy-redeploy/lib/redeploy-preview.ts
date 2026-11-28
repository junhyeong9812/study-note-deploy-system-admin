/** 재배포 확인 화면의 조립(순수 — master 배포 이력 · git 조회 클라이언트는 주입).
 * 버전 목록은 buildDeployVersionList 를 다시 쓴다(이력 조회 한 번 · 제목 조회 많아야 두 번). 고른 커밋이 그 서비스의 성공한 버전에 없으면
 * not_deployable — 그 커밋으로 git 을 부르지 않는다. 지금 버전과 같으면 same — 범위 조회를 하지 않는다.
 * 그 밖이면 방향 · 사이의 커밋을 deploy-git-client 의 listCommits(범위 A..B — A 제외 · B 포함)로, 많아야 두 번(findDirection).
 * 두 버전의 제목은 버전 목록의 것을 쓰고, 비어 있으면 범위 조회가 그 커밋을 돌려준 때만 채운다(제목을 얻으려고 더 부르지 않는다). */
import type { DeployGitClient, GitCommitRange } from "@/features/deploy-detail/lib/deploy-git-client";
import { isSameCommit } from "@/features/deploy-detail/lib/deploy-range";
import {
  buildDeployVersionList, type DeployVersion, type DeployVersionsDependencies, type InProgressDeployment,
} from "@/features/deploy-versions/lib/deploy-versions-view";
import type { RedeployPreviewQuery } from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import type { DeployService } from "@/features/deploys/lib/deploy-history-query";
import type { UpstreamFailure, UpstreamResult } from "@/shared/lib/upstream-result";

/** 사이의 커밋 한 줄. */
export interface BetweenCommit {
  /** 전체 SHA(master 가 준 그대로) */
  sha: string;
  /** subject */
  title: string;
}

/** 사이의 커밋 목록 — 최신순(master 순서 그대로: 범위의 B 쪽이 먼저). */
export interface BetweenCommits {
  commits: BetweenCommit[];
  /** 100개 상한에 걸려 일부만 받았다(master 의 truncated 또는 어드민이 잘랐다) */
  truncated: boolean;
  /** false = 목록에 서버의 얕은 이력 경계가 들어 있다 — 그 너머의 커밋이 빠졌을 수 있다(master 의 range_complete) */
  complete: boolean;
}

/** 지금 버전 → 고른 버전의 방향.
 * - same: 같은 커밋(git 범위 조회를 하지 않는다)
 * - rollback: 고른 버전이 지금 버전의 조상 — between = 사라지게 되는 커밋(고른 버전 뒤 ~ 지금 버전)
 * - forward: 고른 버전이 지금 버전의 자손 — between = 더해지는 커밋(지금 버전 뒤 ~ 고른 버전)
 * - unknown: 방향을 꾸며 내지 않는다 — diverged(양쪽 다 not_ancestor) · shallow_history(relation unknown) · lookup_failed(조회 실패 — failure 에 그 이유) */
export type RedeployDirection =
  | { kind: "same" }
  | { kind: "rollback"; between: BetweenCommits }
  | { kind: "forward"; between: BetweenCommits }
  | { kind: "unknown"; reason: "diverged" | "shallow_history" | "lookup_failed"; failure: UpstreamFailure | null };

export type RedeployPreview =
  /** 고른 커밋이 그 서비스의 성공한 버전 목록에 없다 — 비교하지 않는다(방향 git 조회 없음) */
  | { kind: "not_deployable"; service: DeployService; commitSha: string }
  | {
      kind: "comparison";
      service: DeployService;
      /** 지금 떠 있는 버전(버전 목록의 versions[0]) */
      current: DeployVersion;
      /** 고른 버전(버전 목록의 그 줄) */
      chosen: DeployVersion;
      direction: RedeployDirection;
      /** 그 서비스에 지금 진행 중인 배포(버전 목록의 inProgress) */
      inProgress: InProgressDeployment | null;
    };

/** git 조회의 수 상한 — 방향 · 사이의 커밋을 위한 범위 조회. 버전 목록의 제목 조회(많아야 2)와 합쳐 많아야 4. */
export const REDEPLOY_DIRECTION_GIT_CALL_LIMIT = 2;

function betweenOf(range: GitCommitRange): BetweenCommits {
  return {
    commits: range.commits.map((commit) => ({ sha: commit.sha, title: commit.subject })),
    truncated: range.truncated,
    complete: range.rangeComplete,
  };
}

/** 방향을 묻는 순서: ① (고른 버전 → 지금 버전) — 고른 것이 지금의 조상이면 되돌리기(가장 흔한 경우), 여기서 판정되면 ②를 부르지 않는다.
 * ② (지금 버전 → 고른 버전) — ①이 not_ancestor 일 때만. 고른 것이 지금의 자손이면 앞으로.
 * | ① 결과                 | ② 결과                 | 방향                          |
 * | ancestor               | (부르지 않음)          | rollback(between = ①)         |
 * | relation unknown       | (부르지 않음)          | unknown · shallow_history     |
 * | 실패                   | (부르지 않음)          | unknown · lookup_failed(①)    |
 * | not_ancestor           | ancestor               | forward(between = ②)          |
 * | not_ancestor           | not_ancestor           | unknown · diverged            |
 * | not_ancestor           | relation unknown       | unknown · shallow_history     |
 * | not_ancestor           | 실패                   | unknown · lookup_failed(②)    |
 * 돌려주는 range = 방향을 정한 범위(제목 채우기에 쓴다 — 그 범위의 B 가 들어 있다). */
async function findDirection(deployGit: DeployGitClient, service: DeployService, currentSha: string, chosenSha: string): Promise<{ direction: RedeployDirection; range: GitCommitRange | null }> {
  const steps = [
    { fromSha: chosenSha, toSha: currentSha, kind: "rollback" as const },
    { fromSha: currentSha, toSha: chosenSha, kind: "forward" as const },
  ];
  for (const step of steps) {
    const range = await deployGit.listCommits(service, step.fromSha, step.toSha);
    if (!range.ok) return { direction: { kind: "unknown", reason: "lookup_failed", failure: range }, range: null };
    if (range.value.relation === "ancestor") return { direction: { kind: step.kind, between: betweenOf(range.value) }, range: range.value };
    if (range.value.relation === "unknown") return { direction: { kind: "unknown", reason: "shallow_history", failure: null }, range: null };
  }
  return { direction: { kind: "unknown", reason: "diverged", failure: null }, range: null };
}

/** 제목이 비어 있고 범위가 그 커밋을 돌려줬으면 채운다(SHA 로 맞춘다). */
function withTitleFrom(version: DeployVersion, range: GitCommitRange | null): DeployVersion {
  if (version.title !== null || range === null) return version;
  const found = range.commits.find((commit) => isSameCommit(commit.sha, version.commitSha));
  return found === undefined ? version : { ...version, title: found.subject };
}

export async function buildRedeployPreview(dependencies: DeployVersionsDependencies, query: RedeployPreviewQuery): Promise<UpstreamResult<RedeployPreview>> {
  const list = await buildDeployVersionList(dependencies, query.service);
  if (!list.ok) return list;
  const { versions, inProgress } = list.value;
  const chosen = versions.find((version) => isSameCommit(version.commitSha, query.commitSha));
  if (chosen === undefined) return { ok: true, value: { kind: "not_deployable", service: query.service, commitSha: query.commitSha } };
  const current = versions[0];
  if (chosen === current) {
    return { ok: true, value: { kind: "comparison", service: query.service, current, chosen, direction: { kind: "same" }, inProgress } };
  }
  const { direction, range } = await findDirection(dependencies.deployGit, query.service, current.commitSha, chosen.commitSha);
  return {
    ok: true,
    value: {
      kind: "comparison", service: query.service,
      current: withTitleFrom(current, range), chosen: withTitleFrom(chosen, range),
      direction, inProgress,
    },
  };
}
