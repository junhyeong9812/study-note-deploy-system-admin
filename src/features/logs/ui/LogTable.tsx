/** 로그 결과 표 — 시각(KST, 밀리초까지 · 원본 UTC 는 title) · 서비스 · 수준(기호 + 낱말 + 색) · 요청 ID(누르면 그 요청의 흐름을 다시 조회) · 메시지.
 * 메시지는 받은 글자 그대로(React 의 글자 출력 — HTML 로 해석하지 않는다), 고정폭. 여러 줄이거나 길면 첫 줄만 보이고 <details> 로 전체를 편다
 * (줄바꿈 · 공백 유지). 좁은 화면에서는 표만 가로로 스크롤된다. */
import { formatKoreanTime, shortPrefix } from "@/features/deploys/lib/deploy-format";
import type { LogEntryView, LogLevel } from "@/features/logs/lib/log-query";
import styles from "@/features/logs/ui/LogSearchScreen.module.css";

const REQUEST_ID_PREFIX_LENGTH = 8;
/** 한 줄이어도 이 글자 수를 넘으면 접는다. */
const FOLD_MESSAGE_LENGTH = 160;

const LEVEL_MARKS: Readonly<Record<LogLevel, string>> = { debug: "·", info: "i", warning: "!", error: "✕" };
const LEVEL_CLASS: Readonly<Record<LogLevel, string>> = {
  debug: styles.levelDebug, info: styles.levelInfo, warning: styles.levelWarning, error: styles.levelError,
};

/** ISO → KST `YYYY-MM-DD HH:MM:SS.mmm`(로그는 같은 초 안의 순서가 보여야 한다). */
export function formatKoreanLogTime(isoText: string): string {
  const epoch = Date.parse(isoText);
  if (Number.isNaN(epoch)) return isoText;
  return `${formatKoreanTime(isoText)}.${String(((epoch % 1000) + 1000) % 1000).padStart(3, "0")}`;
}

export function LevelBadge({ level }: { level: LogLevel }) {
  return (
    <span className={`${styles.level} ${LEVEL_CLASS[level]}`}>
      <span aria-hidden="true" className={styles.levelMark}>{LEVEL_MARKS[level]}</span>
      {level}
    </span>
  );
}

function LogMessage({ message }: { message: string }) {
  const lines = message.split("\n");
  if (lines.length === 1 && message.length <= FOLD_MESSAGE_LENGTH) return <span className={styles.messageText}>{message}</span>;
  return (
    <details className={styles.messageFold}>
      <summary className={styles.messageSummary}>
        <span className={styles.messageFirstLine}>{lines[0]}</span>
        <span className={styles.messageMore}>{lines.length > 1 ? `${lines.length}줄` : `${message.length}자`} · 전체 보기</span>
      </summary>
      <pre className={styles.messageFull}>{message}</pre>
    </details>
  );
}

export interface LogTableProps {
  logs: LogEntryView[];
  /** 요청 ID 를 누르면 가는 주소(그 요청 ID 로 다시 조회) */
  requestHref: (requestId: string) => string;
  /** 지금 조건의 요청 ID(그 줄의 링크에 aria-current) — 없으면 null */
  currentRequestId: string | null;
}

export function LogTable({ logs, requestHref, currentRequestId }: LogTableProps) {
  return (
    <div className={styles.scroller} tabIndex={0} role="region" aria-label="로그 결과 표">
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">시각(KST)</th>
            <th scope="col">서비스</th>
            <th scope="col">수준</th>
            <th scope="col">요청 ID</th>
            <th scope="col">메시지</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((entry) => (
            <tr key={entry.id} className={entry.level === "error" ? styles.rowError : entry.level === "warning" ? styles.rowWarning : undefined}>
              <td className={styles.time}>
                <time dateTime={entry.at} title={`UTC ${entry.at}`}>{formatKoreanLogTime(entry.at)}</time>
              </td>
              <td>{entry.service}</td>
              <td><LevelBadge level={entry.level} /></td>
              <td>
                {entry.requestId === "" ? <span className={styles.none}>—</span> : (
                  <a className={styles.requestLink} href={requestHref(entry.requestId)} title={entry.requestId}
                    aria-label={`요청 ID ${entry.requestId} 의 로그만 보기`}
                    aria-current={entry.requestId === currentRequestId ? "true" : undefined}>
                    <code>{shortPrefix(entry.requestId, REQUEST_ID_PREFIX_LENGTH)}</code>
                  </a>
                )}
              </td>
              <td className={styles.message}><LogMessage message={entry.message} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
