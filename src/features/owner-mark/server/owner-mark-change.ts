/** 주인 표시를 심고 지우는 서버 쪽 진입 — POST /api/owner-mark(심기) · POST /api/owner-mark/clear(지우기). 폼은 스크립트 없이 보낸다.
 * 차례(앞 단계가 거절하면 뒤 단계가 없다 — 배포된 서버에서는 세션이 없으면 middleware 가 먼저 401):
 *   출처(isAllowedOrigin — 403 JSON origin_rejected) → 세션(requireApiSession — 401 JSON) → 속도 제한(계정당 60초에 5번 · 심기와 지우기를 함께 센다 — 429 HTML)
 *   → 설정(checkOwnerMarkSettings — 심기는 ok 일 때만, 지우기는 clearableDomain 이 있을 때만. 아니면 503 HTML "설정 없음" + 문제의 이름 · Set-Cookie 없음)
 *   → 심기: 값 = ownerMarkValue(열쇠, Date.now()) · Set-Cookie = buildOwnerMarkCookieHeader(값, 도메인) / 지우기: buildClearedOwnerMarkCookieHeader(도메인)
 *   → 303 Location `/owner-mark` · Cache-Control: no-store · 몸 없음.
 * 요청의 몸 · 질의 · 머리(Host 포함)의 글자는 보지 않는다 — 도메인 · 시각 · 값은 설정과 서버의 시계에서만.
 * 로그: 한 번에 한 줄 `owner-mark:<결과> action=<set|clear> account=<계정>` — 결과 = set · cleared · origin_rejected · unauthenticated · rate_limited
 *   · not_configured(뒤에 ` problems=<낱말,…>`). 쿠키의 값 · 서명 · 열쇠는 로그 · 응답에 없다.
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 몸은 구현 워커가 채운다. */
import "server-only";

/** 계정당 60초(미끄러지는 창) 안의 시도 상한 — 심기와 지우기를 함께 센다. */
export const OWNER_MARK_RATE_LIMIT_PER_MINUTE = 5;

export async function ownerMarkSetResponse(_request: Request): Promise<Response> {
  throw new Error("not implemented: ownerMarkSetResponse");
}

export async function ownerMarkClearResponse(_request: Request): Promise<Response> {
  throw new Error("not implemented: ownerMarkClearResponse");
}
