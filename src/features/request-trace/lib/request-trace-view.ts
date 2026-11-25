/** 요청 추적의 화면 모델(순수) — 요청 ID 하나의 로그 줄 → 서비스별 시간 줄 · 거친 차례 · 가장 긴 틈.
 * 관측 서버 조회: `GET /logs?request_id&from=지금−30일&to=지금&limit=500` 한 번 → 꽉 찼으면(next_before) 더 있는지 확인 1회(limit 1) → 있으면 truncated.
 * 확인이 실패하면 전체가 그 실패(잘리지 않았다고 두지 않는다). 이어 받기는 하지 않는다 — 보이는 것은 최근 500줄. */
import { LOG_ID_PATTERN } from "@/features/log-trace/lib/log-trace-query";
import { hasLinesBefore } from "@/features/log-trace/lib/log-trace-view";
import type { LogClient } from "@/features/logs/lib/log-client";
import type { LogEntryView, LogQuery } from "@/features/logs/lib/log-query";
import type { RequestTraceQuery } from "@/features/request-trace/lib/request-trace-query";
import { parseIsoUtc } from "@/shared/lib/query-input";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

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
  /** 이 구간의 error 줄 수(막대의 모양으로 구분한다) */
  errorCount: number;
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
  /** 첫 줄부터 마지막 줄까지(밀리초). 줄이 하나뿐이면 잴 수 없어 null(0 으로 두지 않는다) */
  durationMilliseconds: number | null;
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

/** 로그 id(`밀리초-순번`)의 순번 — 같은 밀리초 안의 차례(관측 서버의 정렬 열쇠). */
function sequenceOf(logId: string): number {
  return Number(logId.slice(logId.indexOf("-") + 1));
}

function fractionOf(milliseconds: number, totalMilliseconds: number): number {
  return totalMilliseconds === 0 ? 0 : milliseconds / totalMilliseconds;
}

/** 줄(어떤 순서든) → 시간 줄. 줄이 없으면 null. 시각(at)은 parseIsoUtc 로 읽히고 id 는 `밀리초-순번` 꼴인 줄만 넘긴다(buildRequestTrace 가 먼저 거른다). */
export function buildRequestTimeline(lines: readonly LogEntryView[]): RequestTimeline | null {
  if (lines.length === 0) return null;
  const ordered = lines
    .map((entry) => ({ entry, milliseconds: parseIsoUtc(entry.at) ?? 0, sequence: sequenceOf(entry.id) }))
    .sort((left, right) => left.milliseconds - right.milliseconds || left.sequence - right.sequence);
  const startMilliseconds = ordered[0].milliseconds;
  const totalMilliseconds = ordered[ordered.length - 1].milliseconds - startMilliseconds;
  const timelineLines: RequestTimelineLine[] = ordered.map(({ entry, milliseconds }) => ({ ...entry, offsetMilliseconds: milliseconds - startMilliseconds }));

  const lanes: ServiceLane[] = [];
  const visits: string[] = [];
  const gaps: TimelineGap[] = [];
  let previous: RequestTimelineLine | null = null;
  for (const line of timelineLines) {
    let lane = lanes.find((candidate) => candidate.service === line.service);
    if (lane === undefined) {
      lane = {
        service: line.service, firstAt: line.at, lastAt: line.at, startOffsetMilliseconds: line.offsetMilliseconds, durationMilliseconds: 0,
        lineCount: 0, errorCount: 0, warningCount: 0, startFraction: 0, lengthFraction: 0, segments: [],
      };
      lanes.push(lane);
    }
    const isError = line.level === "error";
    lane.lastAt = line.at;
    lane.durationMilliseconds = line.offsetMilliseconds - lane.startOffsetMilliseconds;
    lane.lineCount += 1;
    if (isError) lane.errorCount += 1;
    if (line.level === "warning") lane.warningCount += 1;
    if (previous === null || previous.service !== line.service) {
      // 다른 서비스의 줄 뒤에 다시 나타나면 새 구간 — 사이의 빈 곳을 한 구간으로 메우지 않는다
      visits.push(line.service);
      lane.segments.push({
        firstAt: line.at, lastAt: line.at, startOffsetMilliseconds: line.offsetMilliseconds, durationMilliseconds: 0,
        lineCount: 0, errorCount: 0, startFraction: 0, lengthFraction: 0,
      });
    }
    const segment = lane.segments[lane.segments.length - 1];
    segment.lastAt = line.at;
    segment.durationMilliseconds = line.offsetMilliseconds - segment.startOffsetMilliseconds;
    segment.lineCount += 1;
    if (isError) segment.errorCount += 1;
    if (previous !== null && line.offsetMilliseconds > previous.offsetMilliseconds) {
      gaps.push({
        beforeService: previous.service, afterService: line.service, beforeAt: previous.at, afterAt: line.at,
        startOffsetMilliseconds: previous.offsetMilliseconds, durationMilliseconds: line.offsetMilliseconds - previous.offsetMilliseconds,
      });
    }
    previous = line;
  }
  for (const lane of lanes) {
    lane.startFraction = fractionOf(lane.startOffsetMilliseconds, totalMilliseconds);
    lane.lengthFraction = fractionOf(lane.durationMilliseconds, totalMilliseconds);
    for (const segment of lane.segments) {
      segment.startFraction = fractionOf(segment.startOffsetMilliseconds, totalMilliseconds);
      segment.lengthFraction = fractionOf(segment.durationMilliseconds, totalMilliseconds);
    }
  }
  const longestGaps = gaps
    .sort((left, right) => right.durationMilliseconds - left.durationMilliseconds || left.startOffsetMilliseconds - right.startOffsetMilliseconds)
    .slice(0, TIMELINE_LONGEST_GAP_COUNT);
  return {
    startAt: timelineLines[0].at, endAt: timelineLines[timelineLines.length - 1].at, durationMilliseconds: timelineLines.length === 1 ? null : totalMilliseconds,
    lineCount: timelineLines.length, lanes, visits, lines: timelineLines, longestGaps,
  };
}

/** 관측 서버 조회 + 시간 줄. logs 가 null 이면 not_configured(호출 없음). 거부(reject)하지 않는다. */
export async function buildRequestTrace(logs: LogClient | null, query: RequestTraceQuery, now: number): Promise<UpstreamResult<RequestTrace>> {
  if (logs === null) return upstreamFailure("not_configured");
  const traceQuery: LogQuery = {
    from: new Date(now - REQUEST_TRACE_LOOKBACK_MILLISECONDS).toISOString(), to: new Date(now).toISOString(),
    service: null, level: null, requestId: query.requestId, text: null, before: null, limit: REQUEST_TRACE_MAXIMUM_LINES,
  };
  const page = await logs.searchLogs(traceQuery);
  if (!page.ok) return page;
  // 시각 · id(정렬 열쇠)가 읽히지 않는 줄이 하나라도 있으면 시간 차 · 차례를 잴 수 없다 — 0 으로 숨기지 않는다
  if (page.value.logs.some((entry) => parseIsoUtc(entry.at) === null || !LOG_ID_PATTERN.test(entry.id))) return upstreamFailure("unparseable");
  const truncated = await hasLinesBefore(logs, traceQuery, page.value);
  if (!truncated.ok) return truncated;   // 조용히 "잘리지 않음"으로 두지 않는다
  return { ok: true, value: { from: page.value.from, to: page.value.to, truncated: truncated.value, timeline: buildRequestTimeline(page.value.logs) } };
}
