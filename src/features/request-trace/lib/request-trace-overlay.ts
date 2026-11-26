/** 요청 추적의 겹친 시간 줄(순수) — 뼈대(T7 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * 로그 줄과 구간을 한 시간 축(둘을 합친 범위)에 놓고, 서비스(규약 이름)마다 한 줄로 묶는다. */
import type { LogEntryView, LogLevel } from "@/features/logs/lib/log-query";
import type { RequestSpans } from "@/features/request-trace/lib/request-trace-spans";
import type { TrafficSpan } from "@/features/request-trace/lib/traffic-span-client";
import type { UpstreamFailure } from "@/shared/lib/upstream-result";

/** 화면에 보이는 경로의 최대 글자 수(코드 포인트). */
export const SPAN_PATH_DISPLAY_LENGTH = 120;

export interface OverlaySpan extends TrafficSpan {
  /** 끝 − 걸린 시간 */
  startAt: string;
  startOffsetMilliseconds: number;
  endOffsetMilliseconds: number;
  /** 걸린 시간 − upstream(upstream 이 없으면 null) */
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
  delayedServers: string[];
  gapServers: string[];
  requestsDropped: number;
  requestsRejected: number;
  /** truncated 를 뺀 나머지 가운데 하나라도 있으면 */
  mayBeIncomplete: boolean;
}

export function protocolServiceName(logService: string): string {
  void logService;
  throw new Error("T7: 구현 전");
}

export function displaySpanPath(path: string, pathTruncated: boolean): { text: string; shortened: boolean } {
  void path; void pathTruncated;
  throw new Error("T7: 구현 전");
}

export function buildSpanOverlay(logLines: readonly LogEntryView[] | null, spans: readonly TrafficSpan[]): SpanOverlay | null {
  void logLines; void spans;
  throw new Error("T7: 구현 전");
}

export function spanReceiptNotes(spans: RequestSpans): SpanReceiptNotes {
  void spans;
  throw new Error("T7: 구현 전");
}
