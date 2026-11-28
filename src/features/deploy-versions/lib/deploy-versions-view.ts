/** 버전 목록 조립(순수 — master 배포 이력 · master git 조회 클라이언트는 주입).
 * 이력: master `GET /deploys?service=<s>&limit=200` 한 번. 그 서비스의 줄 가운데 성공(succeeded)한 배포의 커밋만, 같은 커밋은 한 줄
 * (가장 최근 성공 배포의 시각 · 성공 횟수), 순서는 master 가 준 순서(최신순)에서 처음 나온 자리 — versions[0] 이 지금 버전.
 * 진행 중(accepted · ci_running · cd_running)인 배포는 목록에 넣지 않고 가장 최근 하나만 inProgress 로.
 * 커밋 제목: master git 조회를 많아야 두 번(gitCallsForTitles) — 제목은 SHA 가 같은 커밋의 것만 붙인다(얻지 못하면 null).
 * 이력 조회가 실패하거나 성공한 버전이 없으면 git 을 부르지 않는다. git 조회의 실패는 titleFailure 로 드러내고 목록은 그대로 둔다. */
import type { DeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import { isSameCommit } from "@/features/deploy-detail/lib/deploy-range";
import type { DeployHistoryClient, DeployState, DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import type { DeployService } from "@/features/deploys/lib/deploy-history-query";
import type { UpstreamFailure, UpstreamResult } from "@/shared/lib/upstream-result";

/** master 에서 읽는 이력 건수(master 의 상한과 같다). */
export const DEPLOY_VERSIONS_HISTORY_LIMIT = 200;

/** 버전 한 줄 — 그 서비스에서 배포에 성공한 적 있는 커밋 하나. */
export interface DeployVersion {
  /** master 가 준 커밋 SHA 그대로(전체) */
  commitSha: string;
  /** 커밋 제목(master git 조회의 subject) — 얻지 못하면 null("제목 없음") */
  title: string | null;
  /** 지금 떠 있는 버전(가장 최근에 성공한 배포의 커밋) — 목록에서 하나만 true */
  current: boolean;
  /** 이 커밋의 가장 최근 성공 배포의 finished_at(없으면 accepted_at) — ISO 글자 그대로 */
  lastDeployedAt: string;
  /** 이 커밋의 성공한 배포 횟수(읽은 이력 안에서) */
  deployCount: number;
}

/** 지금 진행 중인 배포(accepted · ci_running · cd_running) 가운데 가장 최근 하나. */
export interface InProgressDeployment {
  requestId: string;
  commitSha: string;
  state: DeployState;
  acceptedAt: string;
}

export interface DeployVersionList {
  service: DeployService;
  /** 최신순(가장 최근 성공 배포가 앞 — master 의 순서) · versions[0] 이 지금 버전 */
  versions: DeployVersion[];
  inProgress: InProgressDeployment | null;
  /** master 에서 받은 이력 건수(그 서비스의 줄만) */
  scannedDeployments: number;
  /** 물은 건수(DEPLOY_VERSIONS_HISTORY_LIMIT) */
  historyLimit: number;
  /** 받은 건수가 물은 건수에 닿았다 — 더 오래된 배포(와 그 버전)가 있을 수 있다 */
  reachedHistoryLimit: boolean;
  /** 커밋 제목 조회의 실패(첫 실패) — 없으면 null. 실패해도 versions 는 그대로(title = null) */
  titleFailure: UpstreamFailure | null;
}

export interface DeployVersionsDependencies {
  deployHistory: DeployHistoryClient;
  deployGit: DeployGitClient;
}

const IN_PROGRESS_STATES: readonly DeployState[] = ["accepted", "ci_running", "cd_running"];

/** 버전 한 줄과, 그 커밋이 처음 성공한 배포의 자리(master 순서의 index — 클수록 먼저 배포됐다). */
interface CollectedVersion {
  version: DeployVersion;
  firstDeployIndex: number;
}

function collectVersions(deployments: readonly DeploymentSummary[]): CollectedVersion[] {
  const collected: CollectedVersion[] = [];
  deployments.forEach((deployment, index) => {
    if (deployment.state !== "succeeded") return;
    const existing = collected.find((each) => isSameCommit(each.version.commitSha, deployment.commitSha));
    if (existing !== undefined) {
      existing.version.deployCount += 1;
      existing.firstDeployIndex = index;   // master 순서는 최신순 — 뒤에 나올수록 먼저 배포됐다
      return;
    }
    collected.push({
      version: { commitSha: deployment.commitSha, title: null, current: collected.length === 0, lastDeployedAt: deployment.finishedAt ?? deployment.acceptedAt, deployCount: 1 },
      firstDeployIndex: index,
    });
  });
  return collected;
}

/** 커밋 제목을 git 조회 많아야 두 번으로 모은다(열쇠 = 소문자 SHA).
 * 범위의 양 끝 = 처음 배포된 때가 가장 이른 버전(from) · 가장 늦은 버전(to) — 커밋은 대개 git 순서대로 처음 배포되므로
 * 되돌린 버전을 다시 올려 목록의 순서가 git 순서와 달라도 범위가 버전들을 덮는다.
 * 1) 범위 from..to(from 제외) 2) from 의 커밋 하나 — 범위가 이력 밖(not_in_history — 대개 오래된 from 이 얕은 이력 밖)이면 대신 to 의 커밋 하나.
 * 버전이 하나면 커밋 하나만. 범위 조회가 그 밖의 이유로 실패하면 두 번째는 부르지 않는다(같은 서버가 같은 이유로 실패한다).
 * 단순화: 범위 밖의 버전(갈라진 이력 · from 보다 오래된 커밋 · not_ancestor)은 제목이 null 로 남는다 — 버전 줄마다 부르지 않는다는 상한을 지키는 값. 버전마다 제목이 필요해지면 master 에 SHA 여러 개를 한 번에 묻는 조회를 더한다. */
async function gitCallsForTitles(deployGit: DeployGitClient, service: DeployService, collected: readonly CollectedVersion[]): Promise<{ titles: Map<string, string>; failure: UpstreamFailure | null }> {
  const titles = new Map<string, string>();
  const byFirstDeploy = [...collected].sort((left, right) => right.firstDeployIndex - left.firstDeployIndex);
  const fromSha = byFirstDeploy[0].version.commitSha;
  const toSha = byFirstDeploy[byFirstDeploy.length - 1].version.commitSha;
  const results: UpstreamResult<unknown>[] = [];
  let singleCommitSha: string | null = fromSha;
  if (collected.length > 1) {
    const range = await deployGit.listCommits(service, fromSha, toSha);
    results.push(range);
    if (range.ok) for (const commit of range.value.commits) titles.set(commit.sha.toLowerCase(), commit.subject);
    else singleCommitSha = range.reason === "not_in_history" ? toSha : null;
  }
  if (singleCommitSha !== null) {
    const commit = await deployGit.getCommit(service, singleCommitSha);
    results.push(commit);
    if (commit.ok) titles.set(commit.value.sha.toLowerCase(), commit.value.subject);
  }
  const failure = results.find((result): result is UpstreamFailure => !result.ok) ?? null;
  return { titles, failure };
}

export async function buildDeployVersionList(dependencies: DeployVersionsDependencies, service: DeployService): Promise<UpstreamResult<DeployVersionList>> {
  const received = await dependencies.deployHistory.listDeployments({ service, limit: DEPLOY_VERSIONS_HISTORY_LIMIT });
  if (!received.ok) return received;
  const deployments = received.value.filter((deployment) => deployment.service === service);
  const inProgressDeployment = deployments.find((deployment) => IN_PROGRESS_STATES.includes(deployment.state));
  const collected = collectVersions(deployments);
  let titleFailure: UpstreamFailure | null = null;
  if (collected.length > 0) {
    const { titles, failure } = await gitCallsForTitles(dependencies.deployGit, service, collected);
    for (const { version } of collected) version.title = titles.get(version.commitSha.toLowerCase()) ?? null;
    titleFailure = failure;
  }
  return {
    ok: true,
    value: {
      service,
      versions: collected.map(({ version }) => version),
      inProgress: inProgressDeployment === undefined ? null : {
        requestId: inProgressDeployment.requestId, commitSha: inProgressDeployment.commitSha,
        state: inProgressDeployment.state, acceptedAt: inProgressDeployment.acceptedAt,
      },
      scannedDeployments: deployments.length,
      historyLimit: DEPLOY_VERSIONS_HISTORY_LIMIT,
      reachedHistoryLimit: received.value.length >= DEPLOY_VERSIONS_HISTORY_LIMIT,
      titleFailure,
    },
  };
}
