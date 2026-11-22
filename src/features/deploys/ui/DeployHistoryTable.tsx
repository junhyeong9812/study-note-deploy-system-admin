/** 배포 이력 표 — 접수 시각(KST, 원본 UTC 는 title) · 서비스 · 상태(색 + 글자) · 커밋(앞 7자) · 실패 단계 · 걸린 시간(CI · CD) · 요청 ID(앞 8자).
 * 좁은 화면에서는 표만 가로로 스크롤된다. 줄마다 상세를 여는 링크(접수 시각 칸 — 줄 전체가 눌린다)가 있다(배포 상세 §10.2).
 * compact(상세를 연 분할 화면) = 칸을 접수 시각 · 서비스 · 상태 · 커밋 넷으로 줄인다(나머지는 상세의 요약에 있다). */
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import { describeDeployState, failedStageLabel, formatDuration, formatKoreanTime, shortPrefix } from "@/features/deploys/lib/deploy-format";
import styles from "@/features/deploys/ui/DeployHistoryTable.module.css";

const COMMIT_PREFIX_LENGTH = 7;
const REQUEST_ID_PREFIX_LENGTH = 8;

const TONE_CLASS = { success: styles.badgeSuccess, failure: styles.badgeFailure, progress: styles.badgeProgress } as const;

export function StateBadge({ deployment }: { deployment: DeploymentSummary }) {
  const described = describeDeployState(deployment.state);
  return (
    <span className={`${styles.badge} ${TONE_CLASS[described.tone]}`} title={deployment.state}>
      <span aria-hidden="true" className={styles.badgeMark}>{described.tone === "success" ? "✓" : described.tone === "failure" ? "✕" : "…"}</span>
      {described.label}{described.detail !== null && <span className={styles.badgeDetail}>{described.detail}</span>}
    </span>
  );
}

export function FailedStage({ stage }: { stage: string | null }) {
  if (stage === null) return <span className={styles.none}>—</span>;
  const label = failedStageLabel(stage);
  return (
    <span className={styles.stage}>
      {label !== null && <span>{label}</span>}
      <code className={styles.code}>{stage}</code>
    </span>
  );
}

export function Duration({ deployment }: { deployment: DeploymentSummary }) {
  return (
    <span className={styles.duration}>
      <span><span className={styles.durationLabel}>CI</span> {formatDuration(deployment.integrationMilliseconds)}</span>
      <span><span className={styles.durationLabel}>CD</span> {formatDuration(deployment.deliveryMilliseconds)}</span>
    </span>
  );
}

export interface DeployHistoryTableProps {
  deployments: DeploymentSummary[];
  /** 줄을 누르면 가는 주소(상세 열기) */
  rowHref: (deployment: DeploymentSummary) => string;
  /** 상세를 연 배포의 요청 ID(강조 · aria-current) — 없으면 null */
  selectedRequestId: string | null;
  compact: boolean;
}

export function DeployHistoryTable({ deployments, rowHref, selectedRequestId, compact }: DeployHistoryTableProps) {
  return (
    <div className={styles.scroller} tabIndex={0} role="region" aria-label="배포 이력 표">
      <table className={`${styles.table} ${compact ? styles.tableCompact : ""}`}>
        <thead>
          <tr>
            <th scope="col">접수 시각(KST)</th>
            <th scope="col">서비스</th>
            <th scope="col">상태</th>
            <th scope="col">커밋</th>
            {!compact && <th scope="col">실패 단계</th>}
            {!compact && <th scope="col">걸린 시간</th>}
            {!compact && <th scope="col">요청 ID</th>}
          </tr>
        </thead>
        <tbody>
          {deployments.map((deployment) => {
            const selected = deployment.requestId === selectedRequestId;
            return (
              <tr key={deployment.requestId} className={`${styles.row} ${selected ? styles.rowSelected : ""}`}>
                <td className={styles.time}>
                  <a className={styles.rowLink} href={rowHref(deployment)} aria-current={selected ? "true" : undefined}
                    aria-label={`${formatKoreanTime(deployment.acceptedAt)} ${deployment.service} 배포 상세 보기`}>
                    <time dateTime={deployment.acceptedAt} title={`UTC ${deployment.acceptedAt}`}>{formatKoreanTime(deployment.acceptedAt)}</time>
                  </a>
                </td>
                <td>{deployment.service}</td>
                <td><StateBadge deployment={deployment} /></td>
                <td><code className={styles.code} title={deployment.commitSha}>{shortPrefix(deployment.commitSha, COMMIT_PREFIX_LENGTH)}</code></td>
                {!compact && <td><FailedStage stage={deployment.failedStage} /></td>}
                {!compact && <td><Duration deployment={deployment} /></td>}
                {!compact && <td><code className={styles.code} title={deployment.requestId}>{shortPrefix(deployment.requestId, REQUEST_ID_PREFIX_LENGTH)}</code></td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
