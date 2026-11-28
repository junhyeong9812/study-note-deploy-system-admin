/** 방문 기록 화면(서버 컴포넌트 — 받은 화면 데이터만 그린다. server · *-client · 설정을 값으로 임포트하지 않는다).
 * 순서: 제목 → 안내(방문자가 보낸 값) → 기간 링크 셋(스크립트 없이 `?days=`) → 요약(날짜별 · 많이 본 경로 · 들어온 곳 · 기기 · 봇 비율).
 * 요약을 읽지 못하면 고정 글과 HTTP 상태만 — 표 · 0 · 빈 상태 글을 그리지 않는다. 모든 수는 글자로 있고, 막대는 꾸밈(aria-hidden)이다.
 * 경로 · 들어온 곳은 방문자가 보낸 글자다 — React 가 글자로 이스케이프한다(미리 이스케이프하지 않는다). 링크는 경로에만, 모델이 만든 href 로만. */
import type React from "react";
import { formatVisitCount, formatVisitRatio } from "@/features/visits/lib/visit-display";
import {
  VISITS_TEXT, type VisitSiteInternal, type VisitsScreen as VisitsScreenData, type VisitsSummaryView,
} from "@/features/visits/lib/visits-screen";
import type { UpstreamFailure } from "@/shared/lib/upstream-result";
import parts from "@/shared/ui/screen-parts.module.css";
import styles from "@/features/visits/ui/VisitsScreen.module.css";

function FailureLine({ failure }: { failure: UpstreamFailure }) {
  return (
    <p className={styles.failure}>
      방문 요약: {VISITS_TEXT.unknown} — 관측 서버: {failure.message}{failure.status !== undefined && <> · HTTP {failure.status}</>}
    </p>
  );
}

function DayOptions({ screen }: { screen: VisitsScreenData }) {
  return (
    <nav aria-label="기간">
      <ul className={styles.ranges}>
        {screen.dayOptions.map((option) => (
          <li key={option.days}>
            {option.selected
              ? <a className={`${styles.range} ${styles.rangeSelected}`} href={option.href} aria-current="page">{option.label}<span className={styles.visuallyHidden}> (고름)</span></a>
              : <a className={styles.range} href={option.href}>{option.label}</a>}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function DailyTable({ summary }: { summary: VisitsSummaryView }) {
  const largest = Math.max(0, ...summary.daily.map((day) => day.views));
  return (
    <div className={styles.scroller}>
      <table className={styles.table}>
        <caption className={styles.caption}>날짜별 조회 수 · 순방문자</caption>
        <thead>
          <tr>
            <th scope="col">날짜</th>
            <th scope="col">조회 수</th>
            <th scope="col">조회 수(봇 포함)</th>
            <th scope="col">순방문자</th>
            <th scope="col">순방문자(봇 포함)</th>
          </tr>
        </thead>
        <tbody>
          {summary.daily.map((day) => (
            <tr key={day.date}>
              <th scope="row" className={styles.number}>{day.date}</th>
              <td className={styles.number}>
                {largest > 0 && <span className={styles.bar} aria-hidden="true" style={{ width: `${(day.views / largest) * 100}%` }} />}
                {formatVisitCount(day.views)}
              </td>
              <td className={styles.number}>{formatVisitCount(day.viewsWithBots)}</td>
              <td className={styles.number}>{formatVisitCount(day.visitors)}</td>
              <td className={styles.number}>{formatVisitCount(day.visitorsWithBots)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">합</th>
            <td className={styles.number}>{formatVisitCount(summary.totals.views)}</td>
            <td className={styles.number}>{formatVisitCount(summary.totals.viewsWithBots)}</td>
            <td className={styles.number} title="순방문자는 날마다 따로 센 값이라 더하지 않습니다">—</td>
            <td className={styles.number} title="순방문자는 날마다 따로 센 값이라 더하지 않습니다">—</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function TopTable({ caption, label, rows, truncated }: {
  caption: string; label: string; rows: { key: string; name: React.ReactNode; views: number }[]; truncated: boolean;
}) {
  return (
    <div className={styles.block}>
      <div className={styles.scroller}>
        <table className={styles.table}>
          <caption className={styles.caption}>{caption}</caption>
          <thead>
            <tr><th scope="col">{label}</th><th scope="col">조회 수</th></tr>
          </thead>
          <tbody>
            {rows.length === 0
              ? <tr><td colSpan={2} className={styles.noItems}>{VISITS_TEXT.noItems}</td></tr>
              : rows.map((row) => (
                <tr key={row.key}>
                  <td className={styles.visitorText}>{row.name}</td>
                  <td className={styles.number}>{formatVisitCount(row.views)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {truncated && <p className={styles.meta}>{VISITS_TEXT.truncated}</p>}
    </div>
  );
}

function siteInternalText(siteInternal: VisitSiteInternal): string {
  switch (siteInternal.state) {
    case "not_configured": return VISITS_TEXT.siteInternalNotConfigured;
    case "absent": return VISITS_TEXT.siteInternalAbsent;
    case "excluded": return `${VISITS_TEXT.siteInternalExcludedPrefix} ${formatVisitCount(siteInternal.views)} ${VISITS_TEXT.siteInternalExcludedSuffix}`;
  }
}

function SummarySections({ summary }: { summary: VisitsSummaryView }) {
  return (
    <>
      {summary.empty && <p className={parts.empty}>{VISITS_TEXT.empty}</p>}
      <DailyTable summary={summary} />
      <div className={styles.columns}>
        <TopTable caption="많이 본 경로 상위 10 (봇 제외)" label="경로" truncated={summary.topPaths.truncated}
          rows={summary.topPaths.items.map((item, index) => ({
            key: `${index}`, views: item.views,
            name: item.href === null ? item.text : <a href={item.href} rel="noreferrer">{item.text}</a>,
          }))} />
        <div className={styles.block}>
          <TopTable caption="들어온 곳 상위 10 (봇 제외)" label="들어온 곳" truncated={summary.topReferrers.truncated}
            rows={summary.topReferrers.items.map((item, index) => ({ key: `${index}`, views: item.views, name: item.text }))} />
          <p className={styles.meta}>{siteInternalText(summary.siteInternal)}</p>
        </div>
      </div>
      <div className={styles.columns}>
        <TopTable caption="기기별 조회 수" label="기기" truncated={false}
          rows={[
            { key: "desktop", name: "데스크톱", views: summary.devices.desktop },
            { key: "mobile", name: "모바일", views: summary.devices.mobile },
            { key: "bot", name: "봇", views: summary.devices.bot },
          ]} />
        <dl className={styles.ratio}>
          <dt className={styles.ratioLabel}>봇 비율</dt>
          <dd className={styles.ratioValue}>{formatVisitRatio(summary.botRatio)}</dd>
        </dl>
      </div>
    </>
  );
}

export function VisitsScreen({ screen }: { screen: VisitsScreenData }): React.ReactNode {
  return (
    <main className={styles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>{VISITS_TEXT.title}</h1>
      </div>
      <p className={styles.notice}>{screen.notice}</p>
      <DayOptions screen={screen} />
      {screen.summary.ok ? <SummarySections summary={screen.summary.value} /> : <FailureLine failure={screen.summary} />}
    </main>
  );
}
