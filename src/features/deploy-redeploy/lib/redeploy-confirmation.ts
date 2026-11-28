/** 재배포의 확인 값(순수 — 키는 부르는 쪽이 준다).
 * 꼴: `rc1.<요청 ID>.<만든 시각(epoch 밀리초, 10진)>.<서명(base64url, 43자)>`.
 * 서명 = HMAC-SHA256(세션 서명 키, 아래 일곱 줄을 "\n" 으로 이은 글):
 *   REDEPLOY_CONFIRMATION_PURPOSE · "rc1" · 서비스 · 커밋 · 요청 ID · 만든 시각(10진) · 계정
 * 용도 줄이 서명에 들어 있어 세션 토큰(`v1.<시각>` 에 서명)과 서로 바꿔 끼워지지 않는다.
 * 통하는 때: 0 <= 지금 - 만든 시각 < REDEPLOY_CONFIRMATION_LIFETIME_MILLISECONDS. 상태를 두지 않는다(저장소 · 메모리 표 없음). */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const REDEPLOY_CONFIRMATION_PURPOSE = "redeploy-confirmation";
export const REDEPLOY_CONFIRMATION_VERSION = "rc1";
export const REDEPLOY_CONFIRMATION_LIFETIME_MILLISECONDS = 5 * 60 * 1000;
/** 이보다 긴 값은 해석하지 않고 거절한다. */
export const REDEPLOY_CONFIRMATION_MAX_LENGTH = 512;
/** master 가 받는 요청 ID 의 꼴(ci-cd internal/shared/logger.go AcceptOrIssue) — 밖이면 master 가 조용히 새 ID 를 만든다. */
export const REDEPLOY_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const REDEPLOY_REQUEST_ID_PREFIX = "adm-";

export interface RedeployConfirmationFields {
  service: string;
  commitSha: string;
  requestId: string;
  /** epoch 밀리초 */
  issuedAt: number;
  /** 세션의 계정(ADMIN_USER) */
  account: string;
}

export type RedeployConfirmationCheck =
  | { ok: true; requestId: string; issuedAt: number }
  /** malformed: 꼴이 아님(글자 아님 · 빈 값 · 너무 김 · 접두 · 조각 수 · 서명 길이) · mismatch: 서명이 맞지 않음(값 변조 · 다른 서비스 · 커밋 · 계정 · 키, 미래 시각 포함) ·
   * expired: 서명은 맞으나 5분이 지났다 */
  | { ok: false; reason: "malformed" | "mismatch" | "expired" };

/** 접두 뒤의 무작위 바이트 수 — base64url 로 32자(192비트). */
const REQUEST_ID_RANDOM_BYTES = 24;
const ISSUED_AT_PATTERN = /^\d{1,16}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `adm-` + 예측할 수 없는 글자(암호학적 난수) — REDEPLOY_REQUEST_ID_PATTERN 안. */
export function newRedeployRequestId(): string {
  return `${REDEPLOY_REQUEST_ID_PREFIX}${randomBytes(REQUEST_ID_RANDOM_BYTES).toString("base64url")}`;
}

/** 서명하는 글 — 일곱 줄(용도 · 판 · 서비스 · 커밋 · 요청 ID · 만든 시각 · 계정). */
function sign(signingKey: string, fields: RedeployConfirmationFields): string {
  const lines = [
    REDEPLOY_CONFIRMATION_PURPOSE, REDEPLOY_CONFIRMATION_VERSION, fields.service, fields.commitSha, fields.requestId, String(fields.issuedAt), fields.account,
  ];
  return createHmac("sha256", signingKey).update(lines.join("\n")).digest("base64url");
}

/** 빈 키 · 꼴이 틀린 요청 ID 면 예외. */
export function issueRedeployConfirmation(signingKey: string, fields: RedeployConfirmationFields): string {
  if (signingKey.trim().length === 0) throw new Error("redeploy confirmation signing key is empty");
  if (!REDEPLOY_REQUEST_ID_PATTERN.test(fields.requestId)) throw new Error("invalid redeploy request id");
  if (!Number.isSafeInteger(fields.issuedAt) || fields.issuedAt < 0) throw new Error("invalid issuedAt");
  return `${REDEPLOY_CONFIRMATION_VERSION}.${fields.requestId}.${fields.issuedAt}.${sign(signingKey, fields)}`;
}

export function verifyRedeployConfirmation(token: unknown, signingKey: string, expected: { service: string; commitSha: string; account: string }, now: number): RedeployConfirmationCheck {
  if (typeof token !== "string" || token.length === 0 || token.length > REDEPLOY_CONFIRMATION_MAX_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [version, requestId, issuedAtText, signature] = parts;
  if (version !== REDEPLOY_CONFIRMATION_VERSION || !REDEPLOY_REQUEST_ID_PATTERN.test(requestId)
    || !ISSUED_AT_PATTERN.test(issuedAtText) || !SIGNATURE_PATTERN.test(signature)) return { ok: false, reason: "malformed" };
  if (signingKey.trim().length === 0) return { ok: false, reason: "mismatch" };
  const issuedAt = Number(issuedAtText);
  const expectedSignature = Buffer.from(sign(signingKey, { ...expected, requestId, issuedAt }));
  const actualSignature = Buffer.from(signature);
  // 인코딩된 글자끼리 비교한다 — base64url 마지막 글자의 남는 비트만 바꾼 변조도 거절된다(세션 토큰과 같은 방식)
  if (expectedSignature.length !== actualSignature.length || !timingSafeEqual(expectedSignature, actualSignature)) return { ok: false, reason: "mismatch" };
  if (issuedAt > now) return { ok: false, reason: "mismatch" };   // 시계가 거꾸로 — 통하는 창 밖
  if (now - issuedAt >= REDEPLOY_CONFIRMATION_LIFETIME_MILLISECONDS) return { ok: false, reason: "expired" };
  return { ok: true, requestId, issuedAt };
}
