/** 요청 추적의 구간 칸(순수) — 뼈대(T7 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * 로그 조회가 끝난 뒤: 구간 조회 한 번 → 성공하면 수신 상태 조회 한 번(창은 receiptWindow). 구간 조회가 실패하면 그 실패(수신 상태는 부르지 않는다).
 * 수신 상태 조회가 실패해도 구간은 그대로 — receipt 칸만 실패. 서버 이름은 maskUpstreamReason 으로, 경로는 sanitizeSpanPath 로 다듬어 싣는다. */
import type { LogEntryView } from "@/features/logs/lib/log-query";
import type { TrafficServerReceipt, TrafficSpan, TrafficSpanClient } from "@/features/request-trace/lib/traffic-span-client";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

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

export function receiptWindow(pointsMilliseconds: readonly number[], now: number): ReceiptWindow {
  void pointsMilliseconds; void now;
  throw new Error("T7: 구현 전");
}

export function sanitizeSpanPath(path: string): string {
  void path;
  throw new Error("T7: 구현 전");
}

export async function buildRequestSpans(
  client: TrafficSpanClient | null, requestId: string, logLines: readonly LogEntryView[] | null, now: number,
): Promise<UpstreamResult<RequestSpans>> {
  void client; void requestId; void logLines; void now;
  throw new Error("T7: 구현 전");
}
