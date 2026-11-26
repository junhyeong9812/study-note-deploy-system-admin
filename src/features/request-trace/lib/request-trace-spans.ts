/** 요청 추적의 구간 칸(순수) — 로그 조회가 끝난 뒤: 구간 조회 한 번 → 성공하면 수신 상태 조회 한 번(창은 receiptWindow).
 * 구간 조회가 실패하면 그 실패(수신 상태는 부르지 않는다 — 빈 목록으로 두지 않는다). 수신 상태 조회가 실패해도 구간은 그대로 — receipt 칸만 실패.
 * 관측 서버가 막아도 받은 글자를 그대로 믿지 않는다: 서버 이름은 maskUpstreamReason(주소 꼴 → `(주소)`)으로, 경로는 sanitizeSpanPath 로 다듬어 싣는다.
 * 수신 상태는 조회할 때마다 새로 받는다(읽기 진도는 뒤로 갈 수 있다 — 규약 4.5). */
import type { LogEntryView } from "@/features/logs/lib/log-query";
import type { TrafficServerReceipt, TrafficSpan, TrafficSpanClient } from "@/features/request-trace/lib/traffic-span-client";
import { parseIsoUtc } from "@/shared/lib/query-input";
import { maskUpstreamReason } from "@/shared/lib/upstream-reason";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

/** 읽기 진도가 기준 시각 + 이만큼에 닿아야 "다 들어왔다"고 본다(관측 서버의 FILLING_MARGIN 30초와 같다). */
export const RECEIPT_FILLING_MARGIN_MILLISECONDS = 30_000;
/** 수신 상태 창 — 마지막 시각 뒤로 이만큼(그 사이에 받은 항목의 버린 수를 본다). */
export const RECEIPT_WINDOW_AFTER_MILLISECONDS = 5 * 60_000;
/** 시각이 하나도 없을 때의 창(지금부터 거꾸로). */
export const RECEIPT_WINDOW_DEFAULT_MILLISECONDS = 5 * 60_000;
/** 관측 서버 `/traffic/map` 의 최대 기간(24시간). */
export const RECEIPT_WINDOW_MAXIMUM_MILLISECONDS = 24 * 60 * 60_000;

export interface RequestSpans {
  spans: TrafficSpan[];
  truncated: boolean;
  /** "다 들어왔는가"를 재는 기준 시각(ISO) — 로그 · 구간의 마지막 시각, 둘 다 없으면 지금 */
  referenceAt: string;
  /** 수신 상태 — 실패하면 그 실패(구간은 그대로) */
  receipt: UpstreamResult<TrafficServerReceipt[]>;
}

export interface ReceiptWindow {
  from: string;
  to: string;
  referenceMilliseconds: number;
}

/** 수신 상태를 물을 창 — 기준 = 가장 늦은 시각(없으면 지금). 창 = 가장 이른 시각 ~ 가장 늦은 시각 + 5분, 끝은 지금을 넘지 않고
 * 시작은 끝보다 늦지 않으며(관측 서버가 거꾸로를 422 로 거절한다), 24시간보다 넓으면 끝에서 거꾸로 24시간. */
export function receiptWindow(pointsMilliseconds: readonly number[], now: number): ReceiptWindow {
  if (pointsMilliseconds.length === 0) {
    return { from: new Date(now - RECEIPT_WINDOW_DEFAULT_MILLISECONDS).toISOString(), to: new Date(now).toISOString(), referenceMilliseconds: now };
  }
  const earliest = Math.min(...pointsMilliseconds);
  const latest = Math.max(...pointsMilliseconds);
  const to = Math.min(latest + RECEIPT_WINDOW_AFTER_MILLISECONDS, now);
  const from = Math.max(Math.min(earliest, to), to - RECEIPT_WINDOW_MAXIMUM_MILLISECONDS);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), referenceMilliseconds: latest };
}

/** 쿼리의 시작(날것 `?` · `%3F`)부터 뒤를 버리는 자리. */
const QUERY_START_PATTERN = /\?|%3[Ff]/;
/** C0 · DEL · C1 제어 문자(줄바꿈 포함). */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

/** 경로 다듬기 — `?` · `%3F`(대소문자) 뒤를 버리고 제어 문자를 U+FFFD 로 바꾼다. 길이는 자르지 않는다(화면이 자른다). 태그는 글자 그대로(React 가 이스케이프한다). */
export function sanitizeSpanPath(path: string): string {
  const queryAt = path.search(QUERY_START_PATTERN);
  return (queryAt === -1 ? path : path.slice(0, queryAt)).replace(CONTROL_CHARACTER_PATTERN, "�");
}

/** 축 위의 시각들 — 로그 줄의 시각 · 구간의 시작(끝 − 걸린 시간)과 끝. */
function timePointsOf(logLines: readonly LogEntryView[] | null, spans: readonly TrafficSpan[]): number[] {
  const points: number[] = [];
  for (const line of logLines ?? []) {
    const milliseconds = parseIsoUtc(line.at);
    if (milliseconds !== null) points.push(milliseconds);
  }
  for (const span of spans) {
    const endMilliseconds = parseIsoUtc(span.endAt);
    if (endMilliseconds !== null) points.push(endMilliseconds - span.durationMilliseconds, endMilliseconds);
  }
  return points;
}

/** 구간 조회 → 수신 상태 조회. client 가 null 이면 not_configured(부르지 않는다). logLines 가 null 이면(로그를 읽지 못함) 창은 구간만으로. 거부(reject)하지 않는다. */
export async function buildRequestSpans(
  client: TrafficSpanClient | null, requestId: string, logLines: readonly LogEntryView[] | null, now: number,
): Promise<UpstreamResult<RequestSpans>> {
  if (client === null) return upstreamFailure("not_configured");
  const page = await client.requestSpans(requestId);
  if (!page.ok) return page;
  const spans = page.value.spans.map((span) => ({ ...span, server: maskUpstreamReason(span.server), path: sanitizeSpanPath(span.path) }));
  const window = receiptWindow(timePointsOf(logLines, spans), now);
  const receipts = await client.serverReceipts(window.from, window.to);
  const receipt: UpstreamResult<TrafficServerReceipt[]> = receipts.ok
    ? { ok: true, value: receipts.value.map((item) => ({ ...item, server: maskUpstreamReason(item.server) })) }
    : receipts;
  return { ok: true, value: { spans, truncated: page.value.truncated, referenceAt: new Date(window.referenceMilliseconds).toISOString(), receipt } };
}
