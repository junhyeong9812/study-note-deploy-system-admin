/** 세션 — 서명한 쿠키(HMAC-SHA256, Node 내장 crypto). 발급 뒤 12시간이 지나면 무효(연장 없음).
 * 토큰 형식: `v1.<발급 시각(epoch 밀리초, 10진)>.<서명(base64url)>` — 서명 대상은 앞의 두 조각. */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "admin_session";
export const SESSION_LIFETIME_MILLISECONDS = 12 * 60 * 60 * 1000;

const TOKEN_VERSION = "v1";
const TOKEN_PATTERN = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/;

export interface VerifiedSession {
  issuedAt: number;   // epoch 밀리초
}

function sign(signingKey: string, payload: string): string {
  return createHmac("sha256", signingKey).update(payload).digest("base64url");
}

/** 발급 시각을 담고 서명한 토큰을 만든다. 서명 키가 비어 있으면 예외(빈 키로 서명하지 않는다). */
export function issueSessionToken(signingKey: string, issuedAt: number): string {
  if (signingKey.trim().length === 0) throw new Error("session signing key is empty");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("invalid issuedAt");
  const payload = `${TOKEN_VERSION}.${issuedAt}`;
  return `${payload}.${sign(signingKey, payload)}`;
}

/** 서명 불일치 · 변조 · 만료(발급 뒤 12시간 이상) · 미래 발급 시각 · 형식 오류 · 빈 키 → null(세션 없음). */
export function verifySessionToken(token: string | undefined | null, signingKey: string, now: number): VerifiedSession | null {
  if (typeof token !== "string" || signingKey.trim().length === 0) return null;
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const [, issuedAtText, signature] = match;
  const expected = Buffer.from(sign(signingKey, `${TOKEN_VERSION}.${issuedAtText}`));
  const actual = Buffer.from(signature);
  // 인코딩된 문자열끼리 비교한다 — base64url 마지막 글자의 남는 비트만 바꾼 변조도 거절된다
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const issuedAt = Number(issuedAtText);
  if (!Number.isSafeInteger(issuedAt)) return null;
  if (issuedAt > now) return null;                                     // 미래 발급 시각
  if (now - issuedAt >= SESSION_LIFETIME_MILLISECONDS) return null;    // 만료
  return { issuedAt };
}

const COOKIE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";

/** 로그인 성공 시 `Set-Cookie` 값 — HttpOnly · Secure · SameSite=Strict · Path=/ (Max-Age 는 12시간). */
export function buildSessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_LIFETIME_MILLISECONDS / 1000}`;
}

/** 로그아웃 시 `Set-Cookie` 값 — 같은 이름 · 같은 경로 · 빈 값 · Max-Age=0. */
export function buildClearedSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}
