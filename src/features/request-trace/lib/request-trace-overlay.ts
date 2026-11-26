/** 요청 추적의 겹친 시간 줄(순수) — 로그 줄과 구간을 한 시간 축(둘을 합친 범위)에 놓고, 서비스(규약 이름)마다 한 줄로 묶는다.
 * 구간의 시작 = 끝 − 걸린 시간 · nginx 안 = 걸린 시간 − upstream(upstream 이 없으면 null — 0 으로 메우지 않는다) · 5xx 는 serverError.
 * 시계가 어긋나 구간과 로그가 앞뒤로 엇갈려도 꾸미지 않는다 — 축이 둘을 다 품으므로 위치는 0 이상, 비율은 0~1.
 * 수신 상태의 알림(spanReceiptNotes)은 구간이 덜 들어왔을 수 있음을 드러낸다 — 버린 줄의 수는 조회 기간에 그 서버들이 버린 전체 수다(이 요청의 줄만 센 값이 아니다).
 * 순번의 틈(sequence_gaps)은 기간과 무관한 누적이라 그 까닭에 넣지 않고 lostItems 로 따로 낸다. */
import type { LogEntryView, LogLevel } from "@/features/logs/lib/log-query";
import { RECEIPT_FILLING_MARGIN_MILLISECONDS, type RequestSpans } from "@/features/request-trace/lib/request-trace-spans";
import type { TrafficSpan } from "@/features/request-trace/lib/traffic-span-client";
import { parseIsoUtc } from "@/shared/lib/query-input";
import type { UpstreamFailure } from "@/shared/lib/upstream-result";

/** 화면에 보이는 경로의 최대 글자 수(코드 포인트). */
export const SPAN_PATH_DISPLAY_LENGTH = 120;

export interface OverlaySpan extends TrafficSpan {
  /** 끝 − 걸린 시간 */
  startAt: string;
  startOffsetMilliseconds: number;
  endOffsetMilliseconds: number;
  /** 걸린 시간 − upstream(upstream 이 없으면 null) — 시계가 어긋나면 음수 그대로(화면이 글로 가른다) */
  nginxMilliseconds: number | null;
  startFraction: number;
  lengthFraction: number;
  /** 5xx */
  serverError: boolean;
  /** 같은 서비스(규약 이름)의 로그 줄 가운데 [시작, 끝] 안(양끝 포함)의 수 — 로그를 읽지 못했으면 null */
  logLinesInside: number | null;
}

export interface OverlayLogMark {
  id: string;
  offsetMilliseconds: number;
  fraction: number;
  level: LogLevel;
}

export interface OverlayLane {
  /** 규약 이름(protocolServiceName) */
  service: string;
  /** 이 줄로 모인 로그의 서비스 이름(이름순, 겹치지 않게) — 로그가 없으면 빈 목록 */
  logServices: string[];
  spans: OverlaySpan[];
  /** 로그를 읽지 못했으면 null */
  logLineCount: number | null;
  logLinesOutsideSpans: number | null;
  logMarks: OverlayLogMark[];
}

export interface SpanOverlay {
  startAt: string;
  endAt: string;
  durationMilliseconds: number;
  lanes: OverlayLane[];
  /** 모든 구간 — 표의 차례(시작 · 끝 · 서비스 · 서버) */
  spans: OverlaySpan[];
}

export interface SpanReceiptNotes {
  truncated: boolean;
  receiptFailure: UpstreamFailure | null;
  behindServers: string[];
  /** 수신 지연이면서 진도가 못 미친 서버(behindServers 의 부분) */
  delayedServers: string[];
  /** 조회 기간에 받은 항목에 읽지 못한 범위(missing)가 있는 서버 */
  missingServers: string[];
  /** 순번의 틈이 있는 서버와 그 수 — 기간과 무관한 누적이라 mayBeIncomplete 의 까닭이 아니다 */
  lostItems: { server: string; sequenceGaps: number }[];
  requestsDropped: number;
  requestsRejected: number;
  /** truncated · lostItems 를 뺀 나머지 가운데 하나라도 있으면 */
  mayBeIncomplete: boolean;
}

/** 에이전트의 로그 이름 `ci-agent-<서버>` — 규약 이름은 `ci-agent`(규약 2.1). */
const AGENT_LOG_NAME_PREFIX = "ci-agent-";
const AGENT_PROTOCOL_NAME = "ci-agent";

/** 로그의 서비스 이름 → 규약 이름. `ci-agent-<서버>` 만 `ci-agent` 로 읽고 나머지는 그대로(`llm` 을 `llm-wrapper` 로 짐작해 잇지 않는다). */
export function protocolServiceName(logService: string): string {
  return logService.startsWith(AGENT_LOG_NAME_PREFIX) && logService.length > AGENT_LOG_NAME_PREFIX.length ? AGENT_PROTOCOL_NAME : logService;
}

/** 줄 수 곁에 붙이는 원래 로그 이름 — 규약 이름과 다른 이름으로 모였을 때만(`(ci-agent-158, ci-agent-9)`), 아니면 빈 글자. */
export function logServicesNote(service: string, logServices: readonly string[]): string {
  return logServices.length === 0 || (logServices.length === 1 && logServices[0] === service) ? "" : `(${logServices.join(", ")})`;
}

/** 경로의 표시 — 앞 120자(코드 포인트)까지, 넘거나 관측 서버가 이미 잘랐으면 끝에 `…`. 빈 경로는 "(경로 없음)". */
export function displaySpanPath(path: string, pathTruncated: boolean): { text: string; shortened: boolean } {
  if (path === "") return { text: "(경로 없음)", shortened: false };
  const codePoints = Array.from(path);
  if (codePoints.length > SPAN_PATH_DISPLAY_LENGTH) return { text: `${codePoints.slice(0, SPAN_PATH_DISPLAY_LENGTH).join("")}…`, shortened: true };
  return pathTruncated ? { text: `${path}…`, shortened: true } : { text: path, shortened: false };
}

/** 관측 서버(Java Instant)와 같은 꼴의 시각 글자 — 밀리초가 0 이면 소수를 적지 않는다. */
function instantText(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(".000Z", "Z");
}

function fractionOf(milliseconds: number, totalMilliseconds: number): number {
  return totalMilliseconds === 0 ? 0 : milliseconds / totalMilliseconds;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface PlacedSpan { span: TrafficSpan; service: string; startMilliseconds: number; endMilliseconds: number }
interface PlacedLog { line: LogEntryView; service: string; milliseconds: number }

/** 로그(읽지 못했으면 null)와 구간 → 겹친 시간 줄. 구간이 없으면 null(겹칠 것이 없다).
 * 시각은 읽힌 것만 넘어온다(로그는 buildRequestTrace 가, 구간은 클라이언트가 parseIsoUtc 로 거른다). */
export function buildSpanOverlay(logLines: readonly LogEntryView[] | null, spans: readonly TrafficSpan[]): SpanOverlay | null {
  if (spans.length === 0) return null;
  const placedSpans: PlacedSpan[] = spans.map((span) => {
    const endMilliseconds = parseIsoUtc(span.endAt) ?? 0;
    return { span, service: protocolServiceName(span.service), startMilliseconds: endMilliseconds - span.durationMilliseconds, endMilliseconds };
  });
  // 같은 밀리초의 줄은 받은 차례 그대로(안정 정렬 — 시간 줄의 lines 는 이미 순번 차례다)
  const placedLogs: PlacedLog[] = (logLines ?? [])
    .map((line) => ({ line, service: protocolServiceName(line.service), milliseconds: parseIsoUtc(line.at) ?? 0 }))
    .sort((left, right) => left.milliseconds - right.milliseconds);

  const startMilliseconds = Math.min(...placedSpans.map((placed) => placed.startMilliseconds), ...placedLogs.map((placed) => placed.milliseconds));
  const endMilliseconds = Math.max(...placedSpans.map((placed) => placed.endMilliseconds), ...placedLogs.map((placed) => placed.milliseconds));
  const durationMilliseconds = endMilliseconds - startMilliseconds;
  const logsRead = logLines !== null;

  const placedOverlaySpans = placedSpans.map((placed) => {
    const { span } = placed;
    const inside = placedLogs.filter((log) => log.service === placed.service
      && log.milliseconds >= placed.startMilliseconds && log.milliseconds <= placed.endMilliseconds).length;
    const overlaySpan: OverlaySpan = {
      ...span,
      startAt: instantText(placed.startMilliseconds),
      startOffsetMilliseconds: placed.startMilliseconds - startMilliseconds,
      endOffsetMilliseconds: placed.endMilliseconds - startMilliseconds,
      nginxMilliseconds: span.upstreamMilliseconds === null ? null : span.durationMilliseconds - span.upstreamMilliseconds,
      startFraction: fractionOf(placed.startMilliseconds - startMilliseconds, durationMilliseconds),
      lengthFraction: fractionOf(span.durationMilliseconds, durationMilliseconds),
      serverError: Math.floor(span.status / 100) === 5,
      logLinesInside: logsRead ? inside : null,
    };
    return { placed, overlaySpan };
  }).sort((left, right) => left.overlaySpan.startOffsetMilliseconds - right.overlaySpan.startOffsetMilliseconds
    || left.overlaySpan.endOffsetMilliseconds - right.overlaySpan.endOffsetMilliseconds
    || compareText(left.overlaySpan.service, right.overlaySpan.service) || compareText(left.overlaySpan.server, right.overlaySpan.server));

  const laneNames = [...new Set([...placedSpans.map((placed) => placed.service), ...placedLogs.map((placed) => placed.service)])];
  const firstSeen = (service: string) => Math.min(
    ...placedSpans.filter((placed) => placed.service === service).map((placed) => placed.startMilliseconds),
    ...placedLogs.filter((placed) => placed.service === service).map((placed) => placed.milliseconds),
  );
  const lanes = laneNames
    .sort((left, right) => firstSeen(left) - firstSeen(right) || compareText(left, right))
    .map((service): OverlayLane => {
      const laneSpans = placedOverlaySpans.filter(({ placed }) => placed.service === service);
      const laneLogs = placedLogs.filter((placed) => placed.service === service);
      const outside = laneLogs.filter((log) => !laneSpans.some(({ placed }) =>
        log.milliseconds >= placed.startMilliseconds && log.milliseconds <= placed.endMilliseconds)).length;
      return {
        service,
        logServices: [...new Set(laneLogs.map((placed) => placed.line.service))].sort(compareText),
        spans: laneSpans.map(({ overlaySpan }) => overlaySpan),
        logLineCount: logsRead ? laneLogs.length : null,
        logLinesOutsideSpans: logsRead ? outside : null,
        logMarks: laneLogs.map((placed) => ({
          id: placed.line.id, offsetMilliseconds: placed.milliseconds - startMilliseconds,
          fraction: fractionOf(placed.milliseconds - startMilliseconds, durationMilliseconds), level: placed.line.level,
        })),
      };
    });
  return {
    startAt: instantText(startMilliseconds), endAt: instantText(endMilliseconds), durationMilliseconds, lanes,
    spans: placedOverlaySpans.map(({ overlaySpan }) => overlaySpan),
  };
}

/** 수신 상태 → 알림. 읽기 진도가 없거나 기준 + 30초에 못 미친 서버(정확히 30초는 따라잡음) · 그 가운데 수신 지연인 서버(지연은 "지금" 기준이라
 * 진도가 이미 이 요청을 지난 서버의 지연은 세지 않는다) · 읽지 못한 범위가 있는 서버(받은 차례) · 버린 줄의 합. 순번의 틈은 lostItems 로만. 수신 상태를 읽지 못했으면 그 실패 — "다 들어왔다"로 두지 않는다. 진도는 이번 조회의 값으로만 판정한다(앞선 조회를 기억하지 않는다). */
export function spanReceiptNotes(spans: RequestSpans): SpanReceiptNotes {
  const notes: SpanReceiptNotes = {
    truncated: spans.truncated, receiptFailure: null, behindServers: [], delayedServers: [], missingServers: [], lostItems: [],
    requestsDropped: 0, requestsRejected: 0, mayBeIncomplete: false,
  };
  if (!spans.receipt.ok) return { ...notes, receiptFailure: spans.receipt, mayBeIncomplete: true };
  const caughtUpAt = (parseIsoUtc(spans.referenceAt) ?? Number.POSITIVE_INFINITY) + RECEIPT_FILLING_MARGIN_MILLISECONDS;
  for (const receipt of spans.receipt.value) {
    const progress = receipt.readProgressAt === null ? null : parseIsoUtc(receipt.readProgressAt);
    const behind = progress === null || progress < caughtUpAt;
    if (behind) notes.behindServers.push(receipt.server);
    if (behind && receipt.receiveDelayed) notes.delayedServers.push(receipt.server);
    if (receipt.missing.length > 0) notes.missingServers.push(receipt.server);
    if (receipt.sequenceGaps > 0) notes.lostItems.push({ server: receipt.server, sequenceGaps: receipt.sequenceGaps });
    notes.requestsDropped += receipt.requestsDropped;
    notes.requestsRejected += receipt.requestsRejected;
  }
  notes.mayBeIncomplete = notes.behindServers.length > 0 || notes.missingServers.length > 0
    || notes.requestsDropped > 0 || notes.requestsRejected > 0;
  return notes;
}
