/** 상한 바꾸기의 서버 쪽 진입(POST /api/claude-usage/limits) — 폼은 스크립트 없이 보낸다(urlencoded).
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 몸은 구현 워커가 채운다.
 * route 안의 차례(앞 단계가 거절하면 뒤 단계의 호출이 없다):
 *   출처(isAllowedOrigin — 403 JSON origin_rejected) → 세션(requireApiSession — 401 JSON)
 *   → 본문의 꼴(Content-Type 이 정확히 urlencoded · 4KB · UTF-8 — 아니면 400 HTML, 실행 자리를 부르지 않는다)
 *   → 계정 이름(changed_by = requestedByFor(ADMIN_USER) — null 이면 422 HTML)
 *   → 설정(CLAUDE_RUNNER_URL · CLAUDE_RUNNER_SETTINGS_SECRET — 없으면 503 HTML)
 *   → 지금 상한을 서버가 다시 읽는다(GET /limits 한 번) — 읽지 못하면 바꾸지 않는다: 503 HTML "지금 상한을 읽지 못해 바꿀 수 없습니다"
 *     (용도를 모르면 PUT 의 몸을 만들 수 없다 — 닫힌 쪽. 로그인 흐름 · PUT 0)
 *   → 폼의 칸(parseClaudeLimitsForm(칸, 지금 상한의 용도) — malformed 400 HTML / invalid_value 422 HTML. 로그인 흐름 · PUT 0)
 *   → 올림이면(isRaisingChange(지금, 바꿀 값)) 비밀번호 재확인: 비었으면 401 HTML(로그인 흐름 · 실행 자리 PUT 0), 있으면 재배포 접수와 같은 로그인 흐름
 *     (틀림 401 · 잠김 423 · 잦음 429 — 세션 쿠키를 놓지 않는다). 올림이 아니면 비밀번호를 보지 않는다(로그인 흐름 0)
 *   → 실행 자리 PUT /limits 한 번(다시 보내지 않는다).
 * 응답(HTML · no-store · 스크립트 없음): 바뀜 200(실행 자리가 돌려준 값) · 실행 자리의 거절 422(code) · 실행 자리가 설정 비밀값 거절 502 ·
 *   바뀌지 않음 502 · 모름 504("다시 읽어 확인"). 로그: 한 번에 한 줄 `claude-limits:<결과> account=<계정> raise=<true|false>`. */
import "server-only";

/** 본문(application/x-www-form-urlencoded) 상한. */
export const CLAUDE_LIMITS_BODY_MAX_BYTES = 4_096;

export async function claudeLimitsChangeResponse(_request: Request): Promise<Response> {
  throw new Error("not implemented: claudeLimitsChangeResponse");
}
