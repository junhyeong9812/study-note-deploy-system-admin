/** 배포 상세의 범위 계산(순수) — 명세 §10.2 "B = 이 배포의 커밋. A = 같은 서비스에서 이 배포보다 앞서 성공한 가장 최근 배포의 커밋.
 * A 가 없으면(첫 배포 · 이력 밖) B 커밋 하나만. A 와 B 가 같으면 변경 없음(같은 커밋 재배포)".
 * 입력 목록은 master `GET /deploys` 가 준 순서(최신순 — accepted_at DESC, rowid DESC)다. "앞서" = 목록에서 선택한 배포보다 **뒤에** 있는 항목
 * (접수 시각이 같아도 master 의 순서를 따른다 — 시각 글자를 다시 해석하지 않는다).
 * 선택한 배포의 상태(진행 중 · 실패 · 성공)와 무관하게 A 는 그보다 앞선 **성공(succeeded)** 배포다(실패 · 진행 중은 건너뛴다). 다른 서비스의 항목은 보지 않는다. */
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";

/** range = A→B 비교 · no_previous = A 없음(B 하나만) · same_commit = A 와 B 가 같은 커밋. */
export type DeployRangeStatus = "range" | "no_previous" | "same_commit";

export interface DeployRange {
  status: DeployRangeStatus;
  /** A 가 된 배포의 요청 ID(no_previous 면 null) */
  baseRequestId: string | null;
  /** A 의 커밋(no_previous 면 null) */
  baseCommitSha: string | null;
  /** B — 선택한 배포의 커밋 */
  headCommitSha: string;
}

/** 같은 커밋인가 — 대소문자 무관 완전 일치(앞부분 일치는 다름). */
export function isSameCommit(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** 선택한 요청 ID 가 목록에 없으면 null. */
export function findDeployRange(deployments: readonly DeploymentSummary[], selectedRequestId: string): { selected: DeploymentSummary; range: DeployRange } | null {
  const selectedIndex = deployments.findIndex((deployment) => deployment.requestId === selectedRequestId);
  if (selectedIndex < 0) return null;
  const selected = deployments[selectedIndex];
  const base = deployments
    .slice(selectedIndex + 1)
    .find((deployment) => deployment.service === selected.service && deployment.state === "succeeded");
  if (base === undefined) {
    return { selected, range: { status: "no_previous", baseRequestId: null, baseCommitSha: null, headCommitSha: selected.commitSha } };
  }
  return {
    selected,
    range: {
      status: isSameCommit(base.commitSha, selected.commitSha) ? "same_commit" : "range",
      baseRequestId: base.requestId, baseCommitSha: base.commitSha, headCommitSha: selected.commitSha,
    },
  };
}
