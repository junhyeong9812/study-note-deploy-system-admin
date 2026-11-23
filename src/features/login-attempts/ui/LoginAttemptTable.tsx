/** 로그인 시도 표 — 시각(KST, 원본 UTC 는 title) · 결과(색 + 기호 + 글자, 뜻은 title) · IP · 브라우저(User-Agent) · 나중에 보낸 기록(replayed).
 * IP · User-Agent 는 남이 정할 수 있는 글자다 — React 의 글자 출력으로만 낸다(HTML 로 해석하지 않는다). User-Agent 가 길면 앞부분만 보이고
 * <details> 로 전체를 편다(브라우저 스크립트 없음). 좁은 화면에서는 표만 가로로 스크롤된다. */
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import type { LoginAttemptOutcome, LoginAttemptView } from "@/features/login-attempts/lib/login-attempts-query";
import { OUTCOME_DESCRIPTIONS, REPLAYED_DESCRIPTION, shortUserAgent, type AttemptTone } from "@/features/login-attempts/ui/login-attempts-view";
import styles from "@/features/login-attempts/ui/LoginAttemptsScreen.module.css";
import logStyles from "@/features/logs/ui/LogSearchScreen.module.css";

const TONE_CLASS: Readonly<Record<AttemptTone, string>> = {
  success: styles.toneSuccess, failure: styles.toneFailure, locked: styles.toneLocked, rejected: styles.toneRejected,
};
const ROW_CLASS: Readonly<Record<AttemptTone, string | undefined>> = {
  success: undefined, failure: styles.rowFailure, locked: styles.rowLocked, rejected: undefined,
};

export function OutcomeBadge({ outcome }: { outcome: LoginAttemptOutcome }) {
  const description = OUTCOME_DESCRIPTIONS[outcome];
  return (
    <span className={`${styles.badge} ${TONE_CLASS[description.tone]}`} title={description.meaning}>
      <span aria-hidden="true" className={styles.badgeMark}>{description.mark}</span>
      {description.label}
    </span>
  );
}

function UserAgent({ userAgent }: { userAgent: string }) {
  if (userAgent === "") return <span className={styles.none}>—</span>;
  const shortened = shortUserAgent(userAgent);
  if (!shortened.truncated) return <span className={styles.userAgentText}>{userAgent}</span>;
  return (
    <details className={styles.userAgentFold}>
      <summary className={styles.userAgentSummary}>
        <span className={styles.userAgentText}>{shortened.text}</span>
        <span className={styles.userAgentMore}>전체 보기</span>
      </summary>
      <p className={styles.userAgentFull}>{userAgent}</p>
    </details>
  );
}

export function LoginAttemptTable({ attempts }: { attempts: LoginAttemptView[] }) {
  return (
    <div className={logStyles.scroller} tabIndex={0} role="region" aria-label="로그인 시도 표">
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">시각(KST)</th>
            <th scope="col">결과</th>
            <th scope="col">IP</th>
            <th scope="col">브라우저(User-Agent)</th>
            <th scope="col">전송</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((attempt) => (
            <tr key={attempt.id} className={ROW_CLASS[OUTCOME_DESCRIPTIONS[attempt.outcome].tone]}>
              <td className={styles.time}>
                <time dateTime={attempt.at} title={`UTC ${attempt.at}`}>{formatKoreanTime(attempt.at)}</time>
              </td>
              <td><OutcomeBadge outcome={attempt.outcome} /></td>
              <td className={styles.ip}>{attempt.ip === "" ? <span className={styles.none}>—</span> : <code className={styles.code}>{attempt.ip}</code>}</td>
              <td className={styles.userAgent}><UserAgent userAgent={attempt.userAgent} /></td>
              <td>
                {attempt.replayed ? (
                  <span className={`${styles.badge} ${styles.toneReplayed}`} title={REPLAYED_DESCRIPTION.meaning}>
                    <span aria-hidden="true" className={styles.badgeMark}>{REPLAYED_DESCRIPTION.mark}</span>
                    {REPLAYED_DESCRIPTION.label}
                  </span>
                ) : <span className={styles.none} title="그때 바로 기록됨">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
