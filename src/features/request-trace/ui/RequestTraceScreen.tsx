/** 요청 추적 화면의 본문(서버 컴포넌트) — 폼 · 잘못된 입력 · 실패 · 요약(전체 걸린 시간 · 줄 수 · 거친 차례) · 서비스별 시간 줄 표 · 가장 긴 틈 · 그 요청의 로그 · 한계 안내.
 * 받은 값(진입 함수의 결과)과 주소의 글자만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 폼은 GET 제출, 로그 화면으로 가는 것은 링크라 브라우저 스크립트 없이 동작한다.
 * 막대는 꾸밈(aria-hidden) — 시작 · 걸린 시간 · 줄 수 · 오류 · 경고는 표의 글자로 다 있다. 구간마다 막대 조각 하나(다시 나타난 서비스는 줄 안에서 끊겨 보인다),
 * 위치 · 길이는 전체 기간 대비 비율, 길이가 0 에 가까워도 최소 2px. error 가 든 구간은 줄무늬 + 굵은 테두리(색만으로 구분하지 않는다). */
import { formatElapsed, formatGap } from "@/features/log-trace/ui/LogTracePanel";
import { LOG_QUERY_DEFAULT_LIMIT } from "@/features/logs/lib/log-query";
import { LevelBadge, formatKoreanLogTime } from "@/features/logs/ui/LogTable";
import { logsHref } from "@/features/logs/ui/logs-address";
import logStyles from "@/features/logs/ui/LogSearchScreen.module.css";
import { REQUEST_TRACE_MAXIMUM_LINES, type RequestTimeline, type RequestTraceView, type ServiceSegment } from "@/features/request-trace/lib/request-trace-view";
import { REQUEST_TRACE_PATH } from "@/features/request-trace/ui/request-trace-address";
import styles from "@/features/request-trace/ui/RequestTraceScreen.module.css";
import parts from "@/shared/ui/screen-parts.module.css";

const PROBLEM_ID = "request-trace-problem";
const INPUT_ID = "request-trace-request-id";

function KoreanTime({ value }: { value: string }) {
  return <time dateTime={value} title={`UTC ${value}`}>{formatKoreanLogTime(value)}</time>;
}

function percentOf(fraction: number): string {
  return `${(fraction * 100).toFixed(3)}%`;
}

function SegmentBar({ segment }: { segment: ServiceSegment }) {
  const left = percentOf(segment.startFraction);
  return (
    <span className={`${styles.segment} ${segment.errorCount > 0 ? styles.segmentError : ""}`}
      style={{ left: `min(${left}, calc(100% - 2px))`, width: `max(2px, ${percentOf(segment.lengthFraction)})` }} />
  );
}

function TraceForm({ typedRequestId, invalid }: { typedRequestId: string; invalid: boolean }) {
  return (
    <form className={logStyles.form} method="get" action={REQUEST_TRACE_PATH} role="search" aria-label="요청 추적 조건">
      <div className={`${logStyles.field} ${invalid ? logStyles.fieldInvalid : ""} ${styles.requestField}`}>
        <label htmlFor={INPUT_ID}>요청 ID</label>
        <input id={INPUT_ID} name="request_id" type="text" autoComplete="off" spellCheck={false} defaultValue={typedRequestId}
          {...(invalid ? { "aria-invalid": true, "aria-describedby": PROBLEM_ID } : {})} />
      </div>
      <p className={logStyles.formHint}>로그 화면의 요청 ID 를 넣으면 그 요청이 거친 서비스를 시간 순으로 보입니다(최근 30일).</p>
      <div className={logStyles.actions}>
        <button className={logStyles.submit} type="submit">추적</button>
      </div>
    </form>
  );
}

function LimitNotes() {
  return (
    <ul className={styles.notes}>
      <li>요청 ID 를 남기지 않는 서비스 · 구간은 여기에 나오지 않습니다 — 지금은 채팅의 front → backend 구간(backend 가 새 ID 를 만든다) · backend → llm 구간 · alert.</li>
      <li>시각은 각 줄이 관측 서버(중앙)에 닿은 시각입니다 — 서비스 사이의 차례 · 간격은 실제와 어긋날 수 있습니다.</li>
    </ul>
  );
}

function Timeline({ requestId, timeline, truncated }: { requestId: string; timeline: RequestTimeline; truncated: boolean }) {
  const lineHref = (logId: string) => logsHref({
    requestId, from: timeline.startAt, to: timeline.endAt, service: null, level: null, text: null, before: null, limit: LOG_QUERY_DEFAULT_LIMIT,
  }, logId);
  return (
    <>
      <dl className={styles.summary}>
        <dt>처음 ~ 마지막(KST)</dt><dd><KoreanTime value={timeline.startAt} /> ~ <KoreanTime value={timeline.endAt} /></dd>
        <dt>전체 걸린 시간</dt><dd>{formatElapsed(timeline.durationMilliseconds)}</dd>
        <dt>줄 수</dt><dd>{truncated ? `${timeline.lineCount}줄 이상` : `${timeline.lineCount}줄`}</dd>
        <dt>거친 차례</dt><dd>{timeline.visits.join(" → ")}</dd>
      </dl>

      <div className={logStyles.scroller} tabIndex={0} role="region" aria-label="서비스별 시간 줄 표">
        <table className={`${logStyles.table} ${styles.laneTable}`} aria-label="서비스별 시간 줄">
          <thead>
            <tr>
              <th scope="col">서비스</th>
              <th scope="col">시작</th>
              <th scope="col">걸린 시간</th>
              <th scope="col">줄 수</th>
              <th scope="col">오류</th>
              <th scope="col">경고</th>
              <th scope="col" className={styles.barHeader}>시간 줄(0 ~ {formatElapsed(timeline.durationMilliseconds)})</th>
            </tr>
          </thead>
          <tbody>
            {timeline.lanes.map((lane) => (
              <tr key={lane.service}>
                <th scope="row">{lane.service}</th>
                <td>{formatGap(lane.startOffsetMilliseconds)}</td>
                <td>{formatElapsed(lane.durationMilliseconds)}</td>
                <td>{`${lane.lineCount}줄`}</td>
                <td>{`${lane.errorCount}건`}</td>
                <td>{`${lane.warningCount}건`}</td>
                <td className={styles.barCell}>
                  <div className={styles.track} aria-hidden="true">
                    {lane.segments.map((segment, index) => <SegmentBar key={index} segment={segment} />)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className={styles.section} aria-labelledby="request-trace-gaps">
        <h2 id="request-trace-gaps" className={styles.sectionTitle}>가장 긴 틈</h2>
        {timeline.longestGaps.length === 0 ? <p className={styles.muted}>줄 사이에 시간 차가 없습니다.</p> : (
          <ol className={styles.gaps}>
            {timeline.longestGaps.map((gap) => (
              <li key={gap.startOffsetMilliseconds}>
                {`${gap.beforeService} 의 줄 뒤 ${formatElapsed(gap.durationMilliseconds)} 동안 로그 없음 → ${gap.afterService}`}
                <span className={styles.gapAt}> ({formatGap(gap.startOffsetMilliseconds)}부터)</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={styles.section} aria-labelledby="request-trace-lines">
        <h2 id="request-trace-lines" className={styles.sectionTitle}>이 요청의 로그</h2>
        <div className={logStyles.scroller} tabIndex={0} role="region" aria-label="이 요청의 로그 표">
          <table className={logStyles.table} aria-label="이 요청의 로그">
            <thead>
              <tr>
                <th scope="col">시각(KST)</th>
                <th scope="col">시작부터</th>
                <th scope="col">서비스</th>
                <th scope="col">수준</th>
                <th scope="col">메시지</th>
                <th scope="col">로그 화면</th>
              </tr>
            </thead>
            <tbody>
              {timeline.lines.map((line) => (
                <tr key={line.id}>
                  <td className={logStyles.time}><KoreanTime value={line.at} /></td>
                  <td className={logStyles.time}>{formatGap(line.offsetMilliseconds)}</td>
                  <td>{line.service}</td>
                  <td><LevelBadge level={line.level} /></td>
                  <td className={logStyles.message}><span className={logStyles.messageText}>{line.message}</span></td>
                  <td>
                    <a href={lineHref(line.id)} aria-label={`${formatKoreanLogTime(line.at)} ${line.service} ${line.level} 로그 화면에서 열기`}>열기</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export interface RequestTraceScreenProps {
  view: RequestTraceView;
  /** 폼에 다시 채울 글자(주소의 글자 — typedRequestIdOf) */
  typedRequestId: string;
}

export function RequestTraceScreen({ view, typedRequestId }: RequestTraceScreenProps) {
  const { trace, requestId } = view;
  const invalid = trace !== null && !trace.ok && trace.reason === "invalid_input";
  return (
    <main className={logStyles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>요청 추적</h1>
      </div>

      {invalid && (
        <div className={parts.problem} role="alert" id={PROBLEM_ID}>
          <p className={parts.problemTitle}>조회 조건이 맞지 않습니다</p>
          <p className={parts.problemDetail}><strong>요청 ID</strong>: 영문 · 숫자 · _ . - 로 80자 이하입니다.</p>
        </div>
      )}

      <TraceForm typedRequestId={typedRequestId} invalid={invalid} />

      {trace !== null && !trace.ok && !invalid && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>확인하지 못함 — 관측 서버: {trace.message}{trace.status !== undefined && <> · HTTP {trace.status}</>}</p>
        </div>
      )}

      {trace !== null && trace.ok && requestId !== null && (
        <section className={logStyles.results} aria-label="추적 결과">
          <p className={logStyles.range}>조회 범위(KST) <KoreanTime value={trace.value.from} /> ~ <KoreanTime value={trace.value.to} /></p>
          {trace.value.truncated && (
            <p className={styles.note} role="note">
              {`로그가 ${REQUEST_TRACE_MAXIMUM_LINES}줄보다 많아 최근 ${REQUEST_TRACE_MAXIMUM_LINES}줄만 보입니다 — 처음 시각 · 걸린 시간 · 거친 차례는 보이는 줄 기준입니다.`}
            </p>
          )}
          {trace.value.timeline === null
            ? <p className={parts.empty}>이 요청 ID 의 로그가 없습니다(보관 기간이 지났거나, 요청 ID 를 남기지 않는 구간)</p>
            : <Timeline requestId={requestId} timeline={trace.value.timeline} truncated={trace.value.truncated} />}
          <LimitNotes />
        </section>
      )}
    </main>
  );
}
