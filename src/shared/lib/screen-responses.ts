/** 화면 넷의 데이터 경로가 함께 쓰는 응답과 기록(순수 — 로거는 부르는 쪽이 준다).
 * 입력이 틀리면 422 `{success:false,error:{code:"invalid_input",field}}`, 그 밖은 200 `{success:true,data}`(다른 서버의 실패는 칸의 결과로 — 이 경로의 상태로 옮기지 않는다). 언제나 no-store. */
import { errorResponse, jsonResponse } from "@/shared/lib/responses";
import type { UpstreamFailure, UpstreamResult } from "@/shared/lib/upstream-result";

export function screenDataResponse(data: unknown, invalid: UpstreamFailure | null): Response {
  if (invalid !== null) return errorResponse(422, "invalid_input", { field: invalid.field ?? "" });
  return jsonResponse({ success: true, data });
}

/** 입력 검증의 거절이면 그 실패, 아니면 null. */
export function invalidInputOf(result: UpstreamResult<unknown>): UpstreamFailure | null {
  return !result.ok && result.reason === "invalid_input" ? result : null;
}

/** 다른 서버 호출의 실패를 앱 로그 1줄로 — 이유 낱말과 상태 코드만(주소 · 비밀값 · 원문은 결과에 없으므로 여기에도 없다). 입력 거절은 남기지 않는다. */
export function upstreamFailureLogLine(screen: string, cell: string, result: UpstreamResult<unknown>): string | null {
  if (result.ok || result.reason === "invalid_input") return null;
  return `screen:${screen} cell=${cell} upstream=${result.reason}${result.status !== undefined ? ` status=${result.status}` : ""}`;
}
