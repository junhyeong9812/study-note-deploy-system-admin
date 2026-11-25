/** 요청 추적의 입력 검증(순수) — 관측 서버를 부르기 **전에** 거절한다.
 * 입력 이름: request_id(하나). 꼴은 관측 서버가 저장 · 검색하는 요청 ID 와 같다(observe api/LogController.kt REQUEST_ID `^[A-Za-z0-9_.-]{1,80}$`).
 * 빈 값 · 없음 · 배열(같은 이름 여러 번) · 꼴 밖은 invalid_input(field "request_id").
 * 뼈대 — 구현 전. */
import type { SearchParamsInput, UpstreamFailure } from "@/shared/lib/upstream-result";

export interface RequestTraceQuery {
  /** 받은 글자 그대로 */
  requestId: string;
}

export function parseRequestTraceQuery(input: SearchParamsInput): { ok: true; query: RequestTraceQuery } | UpstreamFailure {
  void input;
  throw new Error("구현 전");
}
