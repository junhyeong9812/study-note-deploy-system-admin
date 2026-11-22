/** 배포 이력 표 — 접수 시각(KST, 원본 UTC 는 title) · 서비스 · 상태(색 + 글자) · 커밋(앞 7자) · 실패 단계 · 걸린 시간(CI · CD) · 요청 ID(앞 8자).
 * 좁은 화면에서는 표만 가로로 스크롤된다. */
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import { describeDeployState, failedStageLabel, formatDuration, formatKoreanTime, shortPrefix } from "@/features/deploys/lib/deploy-format";
import styles from "@/features/deploys/ui/DeployHistoryTable.module.css";

const COMMIT_PREFIX_LENGTH = 7;
const REQUEST_ID_PREFIX_LENGTH = 8;

const TONE_CLASS = { success: styles.badgeSuccess, failure: styles.badgeFailure, progress: styles.badgeProgress } as const;

function StateBadge({ deployment }: { deployment: DeploymentSummary }) {
  const described = describeDeployState(deployment.state);
  return (
    <span className={`${styles.badge} ${TONE_CLASS[described.tone]}`} title={deployment.state}>
      <span aria-hidden="true" className={styles.badgeMark}>{described.tone === "success" ? "✓" : described.tone === "failure" ? "✕" : "…"}</span>
      {described.label}{described.detail !== null && <span className={styles.badgeDetail}>{described.detail}</span>}
    </span>
  );
}

function FailedStage({ stage }: { stage: string | null }) {
  if (stage === null) return <span className={styles.none}>—</span>;
  const label = failedStageLabel(stage);
  return (
    <span className={styles.stage}>
      {label !== null && <span>{label}</span>}
      <code className={styles.code}>{stage}</code>
    </span>
  );
}

function Duration({ deployment }: { deployment: DeploymentSummary }) {
  return (
    <span className={styles.duration}>
      <span><span className={styles.durationLabel}>CI</span> {formatDuration(deployment.integrationMilliseconds)}</span>
      <span><span className={styles.durationLabel}>CD</span> {formatDuration(deployment.deliveryMilliseconds)}</span>
    </span>
  );
}

export function DeployHistoryTable({ deployments }: { deployments: DeploymentSummary[] }) {
  return (
    <div className={styles.scroller} tabIndex={0} role="region" aria-label="배포 이력 표">
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">접수 시각(KST)</th>
            <th scope="col">서비스</th>
            <th scope="col">상태</th>
            <th scope="col">커밋</th>
            <th scope="col">실패 단계</th>
            <th scope="col">걸린 시간</th>
            <th scope="col">요청 ID</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((deployment) => (
            <tr key={deployment.requestId}>
              <td className={styles.time}>
                <time dateTime={deployment.acceptedAt} title={`UTC ${deployment.acceptedAt}`}>{formatKoreanTime(deployment.acceptedAt)}</time>
              </td>
              <td>{deployment.service}</td>
              <td><StateBadge deployment={deployment} /></td>
              <td><code className={styles.code} title={deployment.commitSha}>{shortPrefix(deployment.commitSha, COMMIT_PREFIX_LENGTH)}</code></td>
              <td><FailedStage stage={deployment.failedStage} /></td>
              <td><Duration deployment={deployment} /></td>
              <td><code className={styles.code} title={deployment.requestId}>{shortPrefix(deployment.requestId, REQUEST_ID_PREFIX_LENGTH)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
