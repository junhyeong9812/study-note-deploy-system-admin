/** 요청 추적 화면의 주소(순수) — `/trace?request_id=<요청 ID>`. 로그 화면(연관 로그)에서 이 화면으로 오는 링크도 이 함수를 쓴다. */
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const REQUEST_TRACE_PATH = "/trace";

export function requestTraceHref(requestId: string): string {
  return `${REQUEST_TRACE_PATH}?${new URLSearchParams({ request_id: requestId }).toString()}`;
}

/** 폼에 다시 채울 글자 — 입력이 틀렸어도 넣은 글자 그대로(하나의 글자일 때만, 배열 · 없음은 빈 글자). */
export function typedRequestIdOf(input: SearchParamsInput): string {
  return typeof input.request_id === "string" ? input.request_id : "";
}
