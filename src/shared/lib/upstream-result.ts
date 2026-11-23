/** 다른 서버(master · 관측 · 알림 · backend) 호출의 결과 — 화면 넷의 서버 쪽 데이터 계층이 함께 쓰는 꼴.
 * 명세 ② "한 곳이 죽어도 나머지는 보인다": 실패에는 상태 코드와 **고정된 짧은 사유**만 담는다 —
 * 다른 서버의 오류 본문 원문 · 호출 주소 · 헤더 · 예외 문구는 넣지 않는다(message 는 언제나 아래 표의 글자 그대로).
 * 순수 모듈(설정·비밀값을 읽지 않는다). */

/** 호출마다의 제한 시간(명세 ② 세부 "각각 5초"). */
export const UPSTREAM_TIMEOUT_MILLISECONDS = 5_000;

/** 실패 이유.
 * - not_configured: 이 칸의 설정(주소·비밀값)이 비었거나 주소가 http(s) 로 해석되지 않는다 — 호출하지 않는다.
 * - invalid_input: 어드민 쪽 입력 검증에서 거절 — 호출하지 않는다(field 에 입력 이름).
 * - unreachable: 연결 실패. timeout: 5초 안에 응답(본문 포함)이 끝나지 않았다.
 * - unauthorized(401) · invalid_request(422) · unavailable(503) · server_timeout(504) · bad_status(그 밖의 2xx 아님, 3xx 포함).
 * - unparseable: 2xx 인데 본문이 JSON 이 아니거나 계약과 다른 꼴(칸 빠짐 · 형이 다름) — 원문은 넘기지 않는다.
 * - rate_limited: 호출 한도 초과(GitHub — 403 · 429 와 한도 머리글). not_found: 대상이 없다(GitHub — 없는 커밋 · 저장소, 404 · 422).
 *   (배포 상세 task 07 에서 더했다 — 위 열 가지의 뜻과 failureForHttpStatus 의 대응은 그대로다.)
 * - not_in_history: master git 조회의 404 `commit_not_found` · `parent_unavailable` — 그 커밋(또는 부모)이 서버의 얕은 git 이력에 없다(화면은 GitHub 링크로 넘긴다).
 * - history_changing: master git 조회의 503 `repository_changing` — 배포의 fetch 가 조회 도중 이력을 바꾸는 중.
 *   (배포 상세 출처 교체 task 05 에서 더했다 — 명세 §12.2 · 12.7 · 12.9. failureForHttpStatus 의 대응은 그대로다.) */
export type UpstreamFailureReason =
  | "not_configured"
  | "invalid_input"
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "invalid_request"
  | "unavailable"
  | "server_timeout"
  | "bad_status"
  | "unparseable"
  | "rate_limited"
  | "not_found"
  | "not_in_history"
  | "history_changing";

export interface UpstreamFailure {
  ok: false;
  reason: UpstreamFailureReason;
  /** 다른 서버가 준 HTTP 상태(응답을 받았을 때만). */
  status?: number;
  /** invalid_input 일 때 거절한 입력 이름(예: "service" · "q" · "before"). */
  field?: string;
  /** 화면용 짧은 사유 — 언제나 UPSTREAM_FAILURE_MESSAGES[reason] 그대로. */
  message: string;
}

export type UpstreamResult<Value> = { ok: true; value: Value } | UpstreamFailure;

/** 화면에 보이는 짧은 사유(고정 글자 — 다른 서버의 글자를 섞지 않는다). */
export const UPSTREAM_FAILURE_MESSAGES: Readonly<Record<UpstreamFailureReason, string>> = {
  not_configured: "설정 없음",
  invalid_input: "조건 형식이 맞지 않음",
  unreachable: "닿지 않음",
  timeout: "닿지 않음(5초 초과)",
  unauthorized: "비밀값 거절됨",
  invalid_request: "요청 조건 거절됨",
  unavailable: "서버 일시 장애",
  server_timeout: "서버 조회 시간 초과",
  bad_status: "예상하지 못한 응답",
  unparseable: "해석 불가",
  rate_limited: "한도 초과",
  not_found: "찾을 수 없음",
  not_in_history: "이 서버의 git 이력에 없음(최근 50개 밖일 수 있음)",
  history_changing: "배포가 이력을 바꾸는 중 — 잠시 뒤 새로 고침",
};

/** Next 의 searchParams 와 같은 꼴 — 같은 이름이 여러 번 오면 배열(어드민 입력 검증은 배열을 거절한다). */
export type SearchParamsInput = Readonly<Record<string, string | string[] | undefined>>;

/** 실패 결과를 만든다 — message 는 언제나 고정 표의 글자(다른 서버의 글자를 받지 않는다). 없는 칸(status · field)은 넣지 않는다. */
export function upstreamFailure(reason: UpstreamFailureReason, details: { status?: number; field?: string } = {}): UpstreamFailure {
  const failure: UpstreamFailure = { ok: false, reason, message: UPSTREAM_FAILURE_MESSAGES[reason] };
  if (details.status !== undefined) failure.status = details.status;
  if (details.field !== undefined) failure.field = details.field;
  return failure;
}

/** 2xx 가 아닌 응답의 상태 → 실패 이유(401 · 422 · 503 · 504 는 각자의 이유, 그 밖은 bad_status — 3xx 포함). */
export function failureForHttpStatus(status: number): UpstreamFailure {
  switch (status) {
    case 401: return upstreamFailure("unauthorized", { status });
    case 422: return upstreamFailure("invalid_request", { status });
    case 503: return upstreamFailure("unavailable", { status });
    case 504: return upstreamFailure("server_timeout", { status });
    default: return upstreamFailure("bad_status", { status });
  }
}

/** 입력 검증의 거절(호출하지 않는다). */
export function invalidInput(field: string): UpstreamFailure {
  return upstreamFailure("invalid_input", { field });
}
