/** 연관 로그(서버 컴포넌트) — 고른 로그 · 이 요청 요약 · 연관 로그 · 그때 서버 상태. 명세 §11.2.
 * 받은 값(진입 함수가 칸을 고른 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 줄 고르기 · 요청 ID 로 조회 · 배포 상세 · 닫기는 링크(GET)라 브라우저 스크립트 없이 동작한다.
 * 메시지는 React 의 글자 출력으로만 그린다(HTML 로 해석하지 않는다). 구역마다 실패하면 그 구역에만 "<출처>: <가린 이유>". */
import type { ReactNode } from "react";
import { formatDuration, formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import { StateBadge } from "@/features/deploys/ui/DeployHistoryTable";
import { deploysHref } from "@/features/deploys/ui/deploys-address";
import { DEPLOY_HISTORY_DEFAULT_LIMIT } from "@/features/deploys/lib/deploy-history-query";
import type {
  DeploymentsAround, IncidentsAround, LevelCounts, LogTraceOutcome, LogTraceView, RelatedLogs, RequestSummary,
} from "@/features/log-trace/lib/log-trace-view";
import type { LogEntryView } from "@/features/logs/lib/log-query";
import { LevelBadge, formatKoreanLogTime } from "@/features/logs/ui/LogTable";
import type { UpstreamFailure, UpstreamResult } from "@/shared/lib/upstream-result";
import styles from "@/features/log-trace/ui/LogTracePanel.module.css";

export interface LogTracePanelProps {
  outcome: LogTraceOutcome;
  /** 상세를 닫은 목록 주소(selected 만 뺀다) */
  closeHref: string;
  /** 지금 목록 조건 그대로 로그 하나를 고른 주소 */
  selectHref: (logId: string) => string;
  /** 그 요청 ID 로 목록을 다시 조회하는 주소(범위 = 연관 로그의 창) */
  requestHref: (requestId: string, range: { from: string; to: string }) => string;
}

/** 출처 → 화면 이름(실패 표시 "<출처>: <가린 이유>"). */
type SourceName = "관측 서버" | "배포 서버" | "알림 서버";

/** 알림 기록 종류 → 화면 글자(모르는 낱말은 그대로). */
const INCIDENT_KIND_LABELS: Readonly<Record<string, string>> = {
  monitor_down: "감시 DOWN", monitor_up: "감시 복구", monitor_still_down: "계속 DOWN", event: "이벤트", summary: "요약",
};

/** 밀리초 → `120ms` · `1.5초` · `2분 5초`(1초 미만은 ms 로). 읽을 수 없으면 "—". */
export function formatElapsed(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return formatDuration(milliseconds);
}

/** 앞줄과의 시간 차 — 첫 줄은 "—", 그 밖은 `+120ms`. */
export function formatGap(milliseconds: number | null): string {
  return milliseconds === null ? "—" : `+${formatElapsed(milliseconds)}`;
}

/** ISO → KST `HH:MM:SS.mmm`(같은 요청 안에서는 날짜를 되풀이하지 않는다). */
function clockTime(isoText: string): string {
  const full = formatKoreanLogTime(isoText);
  return /^\d{4}-\d{2}-\d{2} /.test(full) ? full.slice(11) : full;
}

function SourceProblem({ source, failure }: { source: SourceName; failure: UpstreamFailure }) {
  return (
    <p className={styles.problem} role="status">
      {source}: {failure.message}{failure.status !== undefined && <> · HTTP {failure.status}</>}
    </p>
  );
}

function KoreanTime({ value, milliseconds = false }: { value: string; milliseconds?: boolean }) {
  return <time dateTime={value} title={`UTC ${value}`}>{milliseconds ? formatKoreanLogTime(value) : formatKoreanTime(value)}</time>;
}

function RangeNote({ from, to }: { from: string; to: string }) {
  return <p className={styles.rangeNote}>조회 범위(KST) <KoreanTime value={from} /> ~ <KoreanTime value={to} /></p>;
}

function Section({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

function SelectedLogSection({ selected, requestHref, relatedRange }: {
  selected: UpstreamResult<LogEntryView>; requestHref: LogTracePanelProps["requestHref"]; relatedRange: { from: string; to: string } | null;
}) {
  return (
    <Section id="log-trace-selected" title="고른 로그">
      {!selected.ok ? <SourceProblem source="관측 서버" failure={selected} /> : (
        <>
          <dl className={styles.summary}>
            <dt>시각(KST)</dt><dd><KoreanTime value={selected.value.at} milliseconds /></dd>
            <dt>서비스</dt><dd>{selected.value.service}</dd>
            <dt>수준</dt><dd><LevelBadge level={selected.value.level} /></dd>
            <dt>요청 ID</dt>
            <dd>
              {selected.value.requestId === "" ? <span className={styles.muted}>없음</span> : relatedRange === null
                ? <code className={styles.code}>{selected.value.requestId}</code>
                : (
                  <a href={requestHref(selected.value.requestId, relatedRange)} aria-label={`요청 ID ${selected.value.requestId} 로 목록 조회`}>
                    <code className={styles.code}>{selected.value.requestId}</code>
                  </a>
                )}
            </dd>
          </dl>
          <pre className={styles.message}>{selected.value.message}</pre>
        </>
      )}
    </Section>
  );
}

function RequestSummarySection({ summary }: { summary: UpstreamResult<RequestSummary> }) {
  return (
    <Section id="log-trace-request-summary" title="이 요청 요약">
      {!summary.ok ? (
        summary.reason === "not_found"
          ? <p className={styles.muted}>이 요청의 로그를 찾지 못했습니다(그 사이 보관 기간이 지났을 수 있음).</p>
          : <SourceProblem source="관측 서버" failure={summary} />
      ) : (
        <dl className={styles.summary}>
          <dt>거친 서비스</dt><dd>{summary.value.services.join(" → ")}</dd>
          <dt>처음 ~ 마지막(KST)</dt>
          <dd><KoreanTime value={summary.value.firstAt} milliseconds /> ~ <KoreanTime value={summary.value.lastAt} milliseconds /></dd>
          <dt>걸린 시간</dt><dd>{formatElapsed(summary.value.durationMilliseconds)}</dd>
          <dt>줄 수</dt><dd>{summary.value.hasMore ? `${summary.value.lineCount}줄 이상` : `${summary.value.lineCount}줄`}</dd>
          <dt>가장 높은 수준</dt><dd><LevelBadge level={summary.value.highestLevel} /></dd>
          <dt>이 요청의 첫 로그</dt><dd><pre className={styles.messageInline}>{summary.value.firstMessage}</pre></dd>
        </dl>
      )}
    </Section>
  );
}

function RelatedLogsSection({ related, scope, selectHref }: {
  related: UpstreamResult<RelatedLogs>; scope: RelatedLogs["scope"]; selectHref: LogTracePanelProps["selectHref"];
}) {
  const title = scope === "service" ? "같은 서비스의 앞뒤 30초" : "연관 로그";
  return (
    <Section id="log-trace-related" title={<>{title}{related.ok && <span className={styles.muted}> {related.value.lines.length}줄{related.value.hasMore && " 이상"}</span>}</>}>
      {scope === "service" && <p className={styles.note} role="note">요청 ID 가 없는 로그입니다 — 같은 서비스에서 앞뒤 30초 안에 남은 로그를 보여 줍니다.</p>}
      {!related.ok ? <SourceProblem source="관측 서버" failure={related} /> : (
        <>
          <RangeNote from={related.value.from} to={related.value.to} />
          {related.value.hasMore && (
            <p className={styles.note} role="note">더 있음 — 최신 {related.value.lines.length}줄만 보입니다(이 범위의 더 오래된 줄은 빠짐).</p>
          )}
          {related.value.lines.length > 0 && !related.value.lines.some((line) => line.selected) && (
            <p className={styles.note} role="note">고른 로그가 이 목록에 없습니다(보이는 {related.value.lines.length}줄 밖).</p>
          )}
          {related.value.lines.length === 0 ? <p className={styles.muted}>이 범위에 로그가 없습니다.</p> : (
            <ol className={styles.traceList}>
              {related.value.lines.map((line) => (
                <li key={line.id}>
                  <a className={`${styles.traceLink} ${line.selected ? styles.traceLinkSelected : ""}`} href={selectHref(line.id)}
                    aria-current={line.selected ? "true" : undefined} aria-label={`${formatKoreanLogTime(line.at)} ${line.service} ${line.level} 이 로그 고르기`}>
                    <time className={styles.traceTime} dateTime={line.at} title={`UTC ${line.at}`}>{clockTime(line.at)}</time>
                    <span className={styles.traceGap}>{formatGap(line.gapMilliseconds)}</span>
                    <span className={styles.traceService}>{line.service}</span>
                    <LevelBadge level={line.level} />
                    <span className={styles.traceMessage}>{line.message}</span>
                  </a>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Section>
  );
}

function LevelCountsBlock({ counts }: { counts: UpstreamResult<LevelCounts> }) {
  return (
    <div className={styles.stateBlock}>
      <h4 className={styles.stateTitle}>앞뒤 5분 서비스별 warning · error</h4>
      {!counts.ok ? <SourceProblem source="관측 서버" failure={counts} /> : (
        <>
          <RangeNote from={counts.value.from} to={counts.value.to} />
          {counts.value.services.length === 0 ? <p className={styles.muted}>이 시간대에 warning · error 없음</p> : (
            <table className={styles.countTable}>
              <thead>
                <tr><th scope="col">서비스</th><th scope="col">warning</th><th scope="col">error</th></tr>
              </thead>
              <tbody>
                {counts.value.services.map((count) => (
                  <tr key={count.service}>
                    <th scope="row">{count.service}</th>
                    <td>{counts.value.warningAtLimit ? `${count.warning}건 이상` : `${count.warning}건`}</td>
                    <td>{counts.value.errorAtLimit ? `${count.error}건 이상` : `${count.error}건`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(counts.value.warningAtLimit || counts.value.errorAtLimit) && (
            <p className={styles.note} role="note">
              {[counts.value.warningAtLimit && "warning", counts.value.errorAtLimit && "error"].filter(Boolean).join(" · ")} 이 조회 상한(500줄)에 닿았습니다 — 실제는 더 많습니다.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function DeploymentsBlock({ deployments }: { deployments: UpstreamResult<DeploymentsAround> }) {
  return (
    <div className={styles.stateBlock}>
      <h4 className={styles.stateTitle}>앞뒤 30분의 배포</h4>
      {!deployments.ok ? <SourceProblem source="배포 서버" failure={deployments} /> : (
        <>
          <RangeNote from={deployments.value.from} to={deployments.value.to} />
          {deployments.value.deployments.length === 0 ? <p className={styles.muted}>이 시간대에 배포 없음</p> : (
            <ul className={styles.stateList}>
              {deployments.value.deployments.map((deployment) => (
                <li key={deployment.requestId}>
                  <a className={styles.stateLink}
                    href={deploysHref({ service: null, limit: DEPLOY_HISTORY_DEFAULT_LIMIT }, { requestId: deployment.requestId, service: deployment.service })}
                    aria-label={`${formatKoreanTime(deployment.acceptedAt)} ${deployment.service} 배포 상세 보기`}>
                    <KoreanTime value={deployment.acceptedAt} />
                    <span>{deployment.service}</span>
                    <StateBadge deployment={deployment} />
                  </a>
                </li>
              ))}
            </ul>
          )}
          {!deployments.value.coversWindow && <p className={styles.note} role="note">배포 이력 200건이 이 시간대의 앞쪽까지 닿지 못했습니다 — 더 오래된 기록은 확인하지 못함.</p>}
        </>
      )}
    </div>
  );
}

function IncidentsBlock({ incidents }: { incidents: UpstreamResult<IncidentsAround> }) {
  return (
    <div className={styles.stateBlock}>
      <h4 className={styles.stateTitle}>앞뒤 30분의 알림 기록</h4>
      {!incidents.ok ? <SourceProblem source="알림 서버" failure={incidents} /> : (
        <>
          <RangeNote from={incidents.value.from} to={incidents.value.to} />
          {incidents.value.incidents.length === 0 ? <p className={styles.muted}>이 시간대에 알림 없음</p> : (
            <ul className={styles.stateList}>
              {incidents.value.incidents.map((incident, index) => (
                <li key={`${incident.at}-${incident.key}-${index}`} className={styles.incident}>
                  <KoreanTime value={incident.at} />
                  <span className={styles.incidentTitle}>{incident.title}</span>
                  <span className={styles.incidentKind} title={incident.kind}>{INCIDENT_KIND_LABELS[incident.kind] ?? incident.kind}</span>
                </li>
              ))}
            </ul>
          )}
          {!incidents.value.coversWindow && <p className={styles.note} role="note">알림 기록 200건이 이 시간대의 앞쪽까지 닿지 못했습니다 — 더 오래된 기록은 확인하지 못함.</p>}
        </>
      )}
    </div>
  );
}

function TraceBody({ view, selectHref, requestHref }: { view: LogTraceView } & Pick<LogTracePanelProps, "selectHref" | "requestHref">) {
  const relatedRange = view.relatedLogs.ok ? { from: view.relatedLogs.value.from, to: view.relatedLogs.value.to } : null;
  const scope: RelatedLogs["scope"] = view.relatedLogs.ok
    ? view.relatedLogs.value.scope
    : view.selected.ok && view.selected.value.requestId === "" ? "service" : "request";
  return (
    <>
      <SelectedLogSection selected={view.selected} requestHref={requestHref} relatedRange={relatedRange} />
      {view.requestSummary !== null && <RequestSummarySection summary={view.requestSummary} />}
      <RelatedLogsSection related={view.relatedLogs} scope={scope} selectHref={selectHref} />
      <Section id="log-trace-server-state" title="그때 서버 상태">
        <LevelCountsBlock counts={view.serverState.levelCounts} />
        <DeploymentsBlock deployments={view.serverState.deployments} />
        <IncidentsBlock incidents={view.serverState.incidents} />
      </Section>
    </>
  );
}

function TraceOutcome({ outcome, closeHref, selectHref, requestHref }: LogTracePanelProps) {
  if (outcome.kind === "invalid_input") {
    return (
      <div className={styles.problemBox} role="alert">
        <p className={styles.problemTitle}>선택한 로그의 주소가 맞지 않습니다</p>
        <p>selected 값은 로그 id 꼴(<code className={styles.code}>밀리초-순번</code>)이어야 합니다. 목록에서 줄을 다시 누르세요.</p>
      </div>
    );
  }
  if (outcome.kind === "not_found") {
    return (
      <div className={styles.problemBox} role="alert">
        <p className={styles.problemTitle}>이 로그를 찾을 수 없습니다(보관 기간이 지났거나 주소가 잘못됨)</p>
        <p><a href={closeHref}>닫기</a></p>
      </div>
    );
  }
  return <TraceBody view={outcome.view} selectHref={selectHref} requestHref={requestHref} />;
}

export function LogTracePanel(props: LogTracePanelProps) {
  return (
    <section className={styles.panel} aria-labelledby="log-trace-title">
      <div className={styles.panelHeader}>
        <a className={styles.backLink} href={props.closeHref}>← 목록으로</a>
        <h2 id="log-trace-title" className={styles.panelTitle}>연관 로그</h2>
        <a className={styles.closeLink} href={props.closeHref} aria-label="연관 로그 닫기">닫기 ✕</a>
      </div>
      <TraceOutcome {...props} />
    </section>
  );
}
