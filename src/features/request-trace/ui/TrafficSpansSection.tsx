/** 요청 추적 화면의 "접속 기록의 구간" 절(서버 컴포넌트) — 서비스별 구간(로그와 구간을 합친 한 축) · 구간의 목록 · 칸마다의 실패 · 빈 상태 ·
 * 구간이 덜 들어왔을 수 있다는 알림(읽기 진도 · 수신 지연 · 읽지 못한 범위 · 버린 줄 · 수신 상태 실패)과 잘림 · 따로 한 줄로 최근에 잃은 항목(순번의 틈 — 기간과 무관한 누적).
 * nginx 안이 음수(시계 어긋남)면 "—"(upstream 없음)와 다른 글.
 * 받은 값만 그린다 — 계산은 request-trace-overlay(순수)가 한다. 막대는 꾸밈(aria-hidden) — 같은 정보가 표의 글에 있다. 5xx 는 막대의 줄무늬와 함께 글("서버 오류")로도.
 * 경로 · 이름은 React 가 이스케이프하고, 경로는 앞 120자만 보인다(나머지는 HTML 에 싣지 않는다). */
import { formatElapsed, formatGap } from "@/features/log-trace/ui/LogTracePanel";
import type { LogEntryView } from "@/features/logs/lib/log-query";
import logStyles from "@/features/logs/ui/LogSearchScreen.module.css";
import {
  buildSpanOverlay, displaySpanPath, logServicesNote, spanReceiptNotes, type OverlayLane, type OverlaySpan, type SpanOverlay,
} from "@/features/request-trace/lib/request-trace-overlay";
import type { RequestSpans } from "@/features/request-trace/lib/request-trace-spans";
import styles from "@/features/request-trace/ui/RequestTraceScreen.module.css";
import parts from "@/shared/ui/screen-parts.module.css";
import type { UpstreamFailure, UpstreamResult } from "@/shared/lib/upstream-result";

const SECTION_TITLE_ID = "request-trace-spans";

function percentOf(fraction: number): string {
  return `${(fraction * 100).toFixed(3)}%`;
}

function failureText(failure: UpstreamFailure): string {
  return `관측 서버: ${failure.message}${failure.status !== undefined ? ` · HTTP ${failure.status}` : ""}`;
}

function LaneBars({ lane }: { lane: OverlayLane }) {
  return (
    <div className={styles.track} aria-hidden="true">
      {lane.spans.map((span, index) => (
        <span key={index} className={`${styles.spanBar} ${span.serverError ? styles.spanBarServerError : ""}`}
          style={{ left: `min(${percentOf(span.startFraction)}, calc(100% - 2px))`, width: `max(2px, ${percentOf(span.lengthFraction)})` }} />
      ))}
      {lane.logMarks.map((mark) => (
        <span key={mark.id} className={`${styles.logMark} ${mark.level === "error" ? styles.logMarkError : ""}`}
          style={{ left: `min(${percentOf(mark.fraction)}, calc(100% - 2px))` }} />
      ))}
    </div>
  );
}

function LaneTable({ overlay }: { overlay: SpanOverlay }) {
  return (
    <div className={logStyles.scroller} tabIndex={0} role="region" aria-label="서비스별 구간 표">
      <table className={`${logStyles.table} ${styles.laneTable}`} aria-label="서비스별 구간">
        <thead>
          <tr>
            <th scope="col">서비스</th>
            <th scope="col">구간</th>
            <th scope="col">로그</th>
            <th scope="col">구간 밖 로그</th>
            <th scope="col" className={styles.barHeader}>{`시간 줄(0 ~ ${formatElapsed(overlay.durationMilliseconds)})`}</th>
          </tr>
        </thead>
        <tbody>
          {overlay.lanes.map((lane) => (
            <tr key={lane.service}>
              <th scope="row">{lane.service}</th>
              <td>{lane.spans.length === 0 ? "구간 없음" : `${lane.spans.length}개`}</td>
              <td>{lane.logLineCount === null ? "읽지 못함" : `${lane.logLineCount}줄${logServicesNote(lane.service, lane.logServices)}`}</td>
              <td>{lane.logLinesOutsideSpans === null ? "—" : `${lane.logLinesOutsideSpans}줄`}</td>
              <td className={styles.barCell}><LaneBars lane={lane} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function optionalElapsed(milliseconds: number | null): string {
  return milliseconds === null ? "—" : formatElapsed(milliseconds);
}

/** nginx 안 — upstream 이 없으면 "—", 음수(upstream 이 걸린 시간보다 김 — 시계 어긋남)면 그 값을 글로. */
function nginxElapsed(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  return milliseconds < 0 ? `-${formatElapsed(-milliseconds)}(시계 어긋남)` : formatElapsed(milliseconds);
}

function SpanRow({ span }: { span: OverlaySpan }) {
  const path = displaySpanPath(span.path, span.pathTruncated);
  return (
    <tr>
      <th scope="row">{span.service}</th>
      <td>{span.server}</td>
      <td>{span.caller}</td>
      <td className={styles.spanRequest}>{span.method === "" ? path.text : `${span.method} ${path.text}`}</td>
      <td><time dateTime={span.startAt}>{formatGap(span.startOffsetMilliseconds)}</time></td>
      <td><time dateTime={span.endAt}>{formatGap(span.endOffsetMilliseconds)}</time></td>
      <td>{formatElapsed(span.durationMilliseconds)}</td>
      <td>{optionalElapsed(span.upstreamMilliseconds)}</td>
      <td>{nginxElapsed(span.nginxMilliseconds)}</td>
      <td>{span.serverError ? <strong>{`${span.status} 서버 오류`}</strong> : String(span.status)}</td>
      <td>{`${span.bytesSent}바이트`}</td>
      <td>{span.logLinesInside === null ? "—" : `${span.logLinesInside}줄`}</td>
    </tr>
  );
}

function SpanTable({ overlay }: { overlay: SpanOverlay }) {
  return (
    <div className={logStyles.scroller} tabIndex={0} role="region" aria-label="접속 기록의 구간 표">
      <table className={`${logStyles.table} ${styles.laneTable}`} aria-label="접속 기록의 구간">
        <thead>
          <tr>
            <th scope="col">서비스</th>
            <th scope="col">서버</th>
            <th scope="col">부른 쪽</th>
            <th scope="col">요청</th>
            <th scope="col">시작</th>
            <th scope="col">끝</th>
            <th scope="col">걸린 시간</th>
            <th scope="col">뒤(upstream)</th>
            <th scope="col">nginx 안</th>
            <th scope="col">상태</th>
            <th scope="col">보낸 바이트</th>
            <th scope="col">구간 안 로그</th>
          </tr>
        </thead>
        <tbody>
          {overlay.spans.map((span, index) => <SpanRow key={index} span={span} />)}
        </tbody>
      </table>
    </div>
  );
}

/** 구간이 덜 들어왔을 수 있다는 알림 — 까닭마다 한 줄. 버린 줄의 수는 조회 기간에 그 서버들이 버린 전체 수다(이 요청의 줄만이 아니다).
 * 순번의 틈은 그 알림의 까닭이 아니라 머리 밖에 따로 한 줄(누적이라 이 요청과 무관할 수 있다). */
function ReceiptNotes({ spans }: { spans: RequestSpans }) {
  const notes = spanReceiptNotes(spans);
  return (
    <>
      {notes.truncated && (
        <p className={styles.note} role="note">구간이 500개보다 많아 앞의 500개만 보입니다 — 축 · 서비스별 구간은 보이는 구간 기준입니다.</p>
      )}
      {notes.mayBeIncomplete && (
        <div className={styles.note} role="note">
          <p>구간이 아직 다 들어오지 않았을 수 있습니다 — 아래 까닭으로 이 요청의 구간이 빠졌거나 늦게 들어올 수 있습니다.</p>
          <ul className={styles.noteReasons}>
            {notes.receiptFailure !== null && <li>{`수신 상태를 확인하지 못했습니다 — ${failureText(notes.receiptFailure)}`}</li>}
            {notes.behindServers.length > 0 && (
              <li>{`읽기 진도가 이 요청의 마지막 시각에 못 미친 서버: ${notes.behindServers.join(", ")}`} (마지막 시각 + 30초까지 읽지 않음 · 진도 없음)</li>
            )}
            {notes.delayedServers.length > 0 && <li>{`수신 지연: ${notes.delayedServers.join(", ")}`} (읽기 진도가 2분 넘게 멈춤)</li>}
            {notes.missingServers.length > 0 && <li>{`읽지 못한 범위가 있는 서버: ${notes.missingServers.join(", ")}`}</li>}
            {notes.requestsDropped > 0 && (
              <li>{`상한으로 싣지 못한 요청별 줄: ${notes.requestsDropped}줄`} (조회 기간에 그 서버들이 버린 전체 수 — 이 요청의 줄인지는 알 수 없음)</li>
            )}
            {notes.requestsRejected > 0 && (
              <li>{`경로 때문에 버린 요청별 줄: ${notes.requestsRejected}줄`} (조회 기간에 그 서버들이 버린 전체 수 — 이 요청의 줄인지는 알 수 없음)</li>
            )}
          </ul>
        </div>
      )}
      {notes.lostItems.length > 0 && (
        <p className={styles.note} role="note">
          {`최근에 잃은 항목: ${notes.lostItems.map((item) => `${item.server} ${item.sequenceGaps}개`).join(", ")} — 이 요청의 것인지는 알 수 없습니다`}
        </p>
      )}
    </>
  );
}

export interface TrafficSpansSectionProps {
  spans: UpstreamResult<RequestSpans>;
  /** 로그 줄 — 로그를 읽지 못했으면 null(구간 안 로그를 "—"로) */
  logLines: readonly LogEntryView[] | null;
}

export function TrafficSpansSection({ spans, logLines }: TrafficSpansSectionProps) {
  const overlay = spans.ok ? buildSpanOverlay(logLines, spans.value.spans) : null;
  return (
    <section className={styles.section} aria-labelledby={SECTION_TITLE_ID}>
      <h2 id={SECTION_TITLE_ID} className={styles.sectionTitle}>접속 기록의 구간</h2>
      {!spans.ok ? (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>{`구간을 읽지 못했습니다 — ${failureText(spans)}`}</p>
        </div>
      ) : (
        <>
          <ReceiptNotes spans={spans.value} />
          {overlay === null
            ? <p className={parts.empty}>{logLines !== null && logLines.length === 0 ? "이 요청 ID 의 로그도 구간도 없습니다" : "이 요청 ID 의 구간이 없습니다"}</p>
            : <><LaneTable overlay={overlay} /><SpanTable overlay={overlay} /></>}
        </>
      )}
      <ul className={styles.notes}>
        <li>구간은 nginx 접속 기록의 한 줄입니다 — 끝은 nginx 가 응답을 마친 시각, 시작은 끝 − 걸린 시간, nginx 안은 걸린 시간 − 뒤(upstream)입니다. 축은 로그와 구간을 합친 범위입니다.</li>
        <li>요청마다의 구간은 일반 요청만 저장됩니다 — 헬스 확인 · 스트림의 구간은 나오지 않습니다.</li>
      </ul>
    </section>
  );
}
