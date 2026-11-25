/** 재배포 확인 화면의 조립(순수 — master 배포 이력 · git 조회 클라이언트는 주입) — 뼈대: 타입과 시그니처만. 구현 워커가 채운다.
 * 버전 목록은 buildDeployVersionList 를 다시 쓴다(새 조회를 만들지 않는다). 방향 · 사이의 커밋은 deploy-git-client 의 listCommits(범위 A..B — A 제외 · B 포함). */
import type { DeployVersion, DeployVersionsDependencies, InProgressDeployment } from "@/features/deploy-versions/lib/deploy-versions-view";
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

export async function buildRedeployPreview(dependencies: DeployVersionsDependencies, query: RedeployPreviewQuery): Promise<UpstreamResult<RedeployPreview>> {
  void dependencies; void query;
  throw new Error("not implemented: buildRedeployPreview");
}
