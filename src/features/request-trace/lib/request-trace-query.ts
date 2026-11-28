/** 요청 추적의 입력 검증(순수) — 관측 서버를 부르기 **전에** 거절한다.
 * 입력 이름: request_id(하나). 꼴은 로그 조회의 LOG_REQUEST_ID_PATTERN(관측 서버가 저장 · 검색하는 요청 ID 의 꼴)을 그대로 쓴다.
 * 빈 값 · 없음 · 배열(같은 이름 여러 번) · 꼴 밖은 invalid_input(field "request_id"). 앞뒤 공백도 다듬지 않고 꼴 밖으로 거절한다.
 * ("없음"을 빈 폼으로 보이는 것은 화면용 진입이 이 함수를 부르기 전에 가른다.) */
import { LOG_REQUEST_ID_PATTERN } from "@/features/logs/lib/log-query";
import { invalidInput, type SearchParamsInput, type UpstreamFailure } from "@/shared/lib/upstream-result";

export interface RequestTraceQuery {
  /** 받은 글자 그대로 */
  requestId: string;
}

export function parseRequestTraceQuery(input: SearchParamsInput): { ok: true; query: RequestTraceQuery } | UpstreamFailure {
  const requestId = input.request_id;
  if (typeof requestId !== "string" || !LOG_REQUEST_ID_PATTERN.test(requestId)) return invalidInput("request_id");
  return { ok: true, query: { requestId } };
}
