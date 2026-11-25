/** 요청 추적의 화면 모델(순수) — 요청 ID 하나의 로그 줄 → 서비스별 시간 줄 · 거친 차례 · 가장 긴 틈. 뼈대 — 구현 전(꼴과 이름만). */
import type { LogClient } from "@/features/logs/lib/log-client";
import type { LogEntryView } from "@/features/logs/lib/log-query";
import type { RequestTraceQuery } from "@/features/request-trace/lib/request-trace-query";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

/** 한 번에 받는 줄 수 = 관측 서버의 상한(LogController.kt MAX_LIMIT 500). */
export const REQUEST_TRACE_MAXIMUM_LINES = 500;
/** 조회 창 — 지금부터 거꾸로 30일(관측 서버의 로그 보관 기간 ObserveSchedule.kt RETENTION 30일). */
export const REQUEST_TRACE_LOOKBACK_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
/** 가장 긴 틈을 몇 개까지 보이는가. */
export const TIMELINE_LONGEST_GAP_COUNT = 3;

/** 시간순 한 줄 — 로그의 칸 그대로 + 전체 시작에서 이 줄까지의 밀리초. */
export interface RequestTimelineLine extends LogEntryView {
  offsetMilliseconds: number;
}

/** 한 서비스가 이어서 남긴 줄의 묶음(사이에 다른 서비스의 줄이 끼면 끊긴다). */
export interface ServiceSegment {
  firstAt: string;
  lastAt: string;
  startOffsetMilliseconds: number;
  durationMilliseconds: number;
  lineCount: number;
  /** 전체 기간 대비 시작 위치 · 길이(0~1, 전체 기간이 0 이면 둘 다 0) */
  startFraction: number;
  lengthFraction: number;
}

/** 서비스 하나의 시간 줄. */
export interface ServiceLane {
  service: string;
  firstAt: string;
  lastAt: string;
  startOffsetMilliseconds: number;
  /** 이 서비스의 마지막 줄 − 첫 줄 */
  durationMilliseconds: number;
  lineCount: number;
  errorCount: number;
  warningCount: number;
  startFraction: number;
  lengthFraction: number;
  /** 시간순, 다시 나타날 때마다 하나씩 */
  segments: ServiceSegment[];
}

/** 이웃한 두 줄 사이에 로그가 없는 구간. */
export interface TimelineGap {
  beforeService: string;
  afterService: string;
  beforeAt: string;
  afterAt: string;
  startOffsetMilliseconds: number;
  durationMilliseconds: number;
}

export interface RequestTimeline {
  startAt: string;
  endAt: string;
  durationMilliseconds: number;
  lineCount: number;
  /** 처음 나타난 차례 */
  lanes: ServiceLane[];
  /** 거친 차례 — 이웃한 같은 서비스는 하나로(front → backend → llm → backend → front) */
  visits: string[];
  /** 시간순(관측 서버의 정렬 열쇠 (밀리초, 순번)의 오름차순) */
  lines: RequestTimelineLine[];
  /** 긴 것부터 최대 TIMELINE_LONGEST_GAP_COUNT 개, 0ms 는 넣지 않는다, 길이가 같으면 이른 것부터 */
  longestGaps: TimelineGap[];
}

export interface RequestTrace {
  /** 관측 서버가 실제로 쓴 창(응답의 from · to) */
  from: string;
  to: string;
  /** 줄이 REQUEST_TRACE_MAXIMUM_LINES 보다 많아 최근 그만큼만 받았다 */
  truncated: boolean;
  /** 줄이 없으면 null */
  timeline: RequestTimeline | null;
}

export interface RequestTraceView {
  /** 입력이 없거나 거절이면 null */
  requestId: string | null;
  /** 입력 없음 = null(부르지 않는다) · 거절 = invalid_input(field "request_id") · 그 밖 = 관측 서버 조회의 결과 */
  trace: UpstreamResult<RequestTrace> | null;
}

/** 줄(어떤 순서든) → 시간 줄. 줄이 없으면 null. 시각(at)은 parseIsoUtc 로 읽히는 줄만 넘긴다. */
export function buildRequestTimeline(lines: readonly LogEntryView[]): RequestTimeline | null {
  void lines;
  throw new Error("구현 전");
}

/** 관측 서버 조회 + 시간 줄. logs 가 null 이면 not_configured(호출 없음). 거부(reject)하지 않는다. */
export async function buildRequestTrace(logs: LogClient | null, query: RequestTraceQuery, now: number): Promise<UpstreamResult<RequestTrace>> {
  void logs; void query; void now;
  throw new Error("구현 전");
}
