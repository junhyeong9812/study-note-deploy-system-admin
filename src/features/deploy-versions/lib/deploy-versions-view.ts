/** 버전 목록 조립(순수 — master 배포 이력 · master git 조회 클라이언트는 주입) — 뼈대: 타입과 시그니처만. 구현 워커가 채운다. */
import type { DeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import type { DeployHistoryClient, DeployState } from "@/features/deploys/lib/deploy-history-client";
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

export async function buildDeployVersionList(dependencies: DeployVersionsDependencies, service: DeployService): Promise<UpstreamResult<DeployVersionList>> {
  void dependencies; void service;
  throw new Error("not implemented: buildDeployVersionList");
}
