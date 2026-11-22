/** 세션 — 서명한 쿠키(HMAC-SHA256, Node 내장 crypto). 발급 뒤 12시간이 지나면 무효(연장 없음). */

export const SESSION_COOKIE_NAME = "admin_session";
export const SESSION_LIFETIME_MILLISECONDS = 12 * 60 * 60 * 1000;

export interface VerifiedSession {
  issuedAt: number;   // epoch 밀리초
}

/** 발급 시각을 담고 서명한 토큰을 만든다. 서명 키가 비어 있으면 예외(빈 키로 서명하지 않는다). */
export function issueSessionToken(signingKey: string, issuedAt: number): string {
  throw new Error("not implemented");
}

/** 서명 불일치 · 변조 · 만료(발급 뒤 12시간 이상) · 미래 발급 시각 · 형식 오류 · 빈 키 → null(세션 없음). */
export function verifySessionToken(token: string | undefined | null, signingKey: string, now: number): VerifiedSession | null {
  throw new Error("not implemented");
}

/** 로그인 성공 시 `Set-Cookie` 값 — HttpOnly · Secure · SameSite=Strict · Path=/ (Max-Age 는 12시간). */
export function buildSessionCookieHeader(token: string): string {
  throw new Error("not implemented");
}

/** 로그아웃 시 `Set-Cookie` 값 — 같은 이름 · 같은 경로 · 빈 값 · Max-Age=0. */
export function buildClearedSessionCookieHeader(): string {
  throw new Error("not implemented");
}
