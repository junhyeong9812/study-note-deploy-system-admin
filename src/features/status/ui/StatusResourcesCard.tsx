/** 상태 한눈에의 "서버 자원" 카드(서버 컴포넌트) — 명세 §2.6 · §17 "기존 카드들 아래에 '서버 자원' 카드 하나 — 서버마다 한 줄의 표
 * (서버 · CPU · 메모리 · 디스크 · 받은 때 · 임계값). 임계값 칸은 가장 심한 것 하나와 나머지 개수. 서버 이름은 '서버 자원' 화면의 그 서버로 가는 링크".
 * 받은 값(진입 함수의 자원 요약)만 그린다 — 다른 서버를 부르지 않는다. 요약 조회가 실패하면 이 카드만 "확인하지 못함 — <고정 글>".
 * 상태는 색 + 기호 + 글자(색만으로 전하지 않는다). */
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import { resourceIncidentId } from "@/features/incidents/lib/incident-id";
import { incidentHref } from "@/features/incidents/lib/incidents-query";
import { formatAge } from "@/features/resources/lib/resource-format";
import { resourcesHref } from "@/features/resources/lib/resources-query";
import type { StatusResourceRow, StatusResourcesSummary, StatusResourceValue } from "@/features/status/lib/status-resources";
import { ToneBadge } from "@/features/status/ui/StatusScreen";
import type { UpstreamResult } from "@/shared/lib/upstream-result";
import styles from "@/features/status/ui/StatusScreen.module.css";

const SEVERITY_MARKS: Readonly<Record<string, string>> = { warning: "!", critical: "‼" };
const CARD_TITLE = "서버 자원";
export const STATUS_RESOURCES_HEADING_ID = "status-card-resources";

function ValueCell({ value }: { value: StatusResourceValue }) {
  return <td className={styles.time}>{value.state === "value" ? value.text : <span className={styles.none}>{value.text}</span>}</td>;
}

/** 받은 때 — 정상이면 "1분 안"(마지막 수신 시각 KST), 오래됨 · 수신 없음 · 확인하지 못함은 표식 + 글. */
function FreshnessCell({ row }: { row: StatusResourceRow }) {
  const freshness = row.freshness;
  const mark = freshness.kind === "fresh" ? null : freshness.kind === "never" ? "✕" : freshness.kind === "stale" ? "!" : "?";
  return (
    <td className={styles.time}>
      {mark !== null && <span aria-hidden="true" className={styles.badgeMark}>{mark} </span>}
      {freshness.kind === "fresh" ? formatAge(freshness.ageMilliseconds) : <strong>{freshness.label}</strong>}
      {row.receivedAt !== null && (
        <span className={styles.elapsed}>
          마지막 수신 <time dateTime={row.receivedAt} title={`UTC ${row.receivedAt}`}>{formatKoreanTime(row.receivedAt)}</time>
        </span>
      )}
    </td>
  );
}

/** 임계값 — 가장 심한 것 하나 + 나머지 개수("! 디스크 경고(경고) 외 1건"). 없으면 "없음", 모르면 "확인하지 못함".
 * 가장 심한 것은 그 문제로 가는 링크 — 이름(aria-label)은 `<서버> <규칙 이름>[ <대상>] 문제 보기`. */
function FiringCell({ row, firingKnown }: { row: StatusResourceRow; firingKnown: boolean }) {
  if (!firingKnown) return <td><span className={styles.none}>확인하지 못함</span></td>;
  const worst = row.worstFiring;
  if (worst === null) return <td><span className={styles.none}>없음</span></td>;
  return (
    <td className={worst.severity === "critical" ? styles.undelivered : undefined}>
      <span aria-hidden="true" className={styles.badgeMark}>{SEVERITY_MARKS[worst.severity] ?? "?"} </span>
      <a href={incidentHref(resourceIncidentId(row.server, worst.rule, worst.target))} aria-label={`${row.server} ${worst.ruleLabel}${worst.target === null ? "" : ` ${worst.target}`} 문제 보기`}><strong>{worst.ruleLabel}{worst.target !== null && <> {worst.target}</>}({worst.severityLabel})</strong></a>
      {row.firingCount > 1 && <> 외 {row.firingCount - 1}건</>}
    </td>
  );
}

function SummaryTable({ summary }: { summary: StatusResourcesSummary }) {
  return (
    <div className={styles.scroller} tabIndex={0} role="region" aria-label="서버 자원 표">
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">서버</th>
            <th scope="col">CPU</th>
            <th scope="col">메모리</th>
            <th scope="col">디스크</th>
            <th scope="col">받은 때</th>
            <th scope="col">임계값</th>
          </tr>
        </thead>
        <tbody>
          {summary.rows.map((row) => (
            <tr key={row.server} className={row.worstFiring !== null || row.freshness.kind !== "fresh" ? styles.rowProblem : undefined}>
              <td className={styles.monitorName}><a href={row.href}>{row.server}</a></td>
              <ValueCell value={row.cpu} />
              <ValueCell value={row.memory} />
              <ValueCell value={row.disk} />
              <FreshnessCell row={row} />
              <FiringCell row={row} firingKnown={summary.firingKnown} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatusResourcesCard({ resources }: { resources: UpstreamResult<StatusResourcesSummary> }) {
  // 울리는 알림 → 문제 · 알림을 모르거나 오래된 값 · 수신 없음인 줄이 있으면 확인 못 함(§18 — 알림이 아직 울리지 않은 동안에도 정상이 아니다) · 그 밖 정상
  const tone = !resources.ok ? "unknown"
    : resources.value.rows.some((row) => row.firingCount > 0) || resources.value.elsewhereFiringCount > 0 ? "problem"
    : !resources.value.firingKnown || resources.value.rows.some((row) => row.freshness.kind !== "fresh") ? "unknown" : "healthy";
  return (
    <section className={styles.card} aria-labelledby={STATUS_RESOURCES_HEADING_ID}>
      <div className={styles.cardHeading}>
        <h2 id={STATUS_RESOURCES_HEADING_ID} className={styles.cardTitle}>{CARD_TITLE}</h2>
        <ToneBadge tone={tone} />
      </div>
      {!resources.ok ? (
        <p className={styles.failure}>확인하지 못함 — {resources.message}{resources.status !== undefined && <> · HTTP {resources.status}</>}</p>
      ) : (
        <>
          {resources.value.rows.length === 0 ? <p className={styles.meta}>지표를 보낸 서버가 없습니다.</p> : <SummaryTable summary={resources.value} />}
          {!resources.value.firingKnown && <p className={styles.meta}>임계값: 확인하지 못함</p>}
          {resources.value.elsewhereFiringCount > 0 && <p className={styles.meta}><strong className={styles.undelivered}>표 밖 서버의 알림 {resources.value.elsewhereFiringCount}건</strong></p>}
          {resources.value.hiddenServerCount > 0 && <p className={styles.meta}>서버 {resources.value.hiddenServerCount}대는 표에 보이지 않습니다(앞 10대만).</p>}
          {resources.value.unreadableServerNameCount > 0 && <p className={styles.meta}>이름을 읽지 못한 서버 {resources.value.unreadableServerNameCount}대는 표에 없습니다.</p>}
        </>
      )}
      <p className={styles.meta}><a className={styles.refresh} href={resources.ok ? resources.value.screenHref : resourcesHref({ range: "1h", container: null })}>서버 자원 화면으로</a></p>
    </section>
  );
}
