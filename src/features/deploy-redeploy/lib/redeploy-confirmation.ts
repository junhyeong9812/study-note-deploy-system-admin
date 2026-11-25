/** 재배포의 확인 값(순수) — 뼈대: 상수 · 타입 · 시그니처만. 구현 워커가 채운다.
 * 꼴: `rc1.<요청 ID>.<만든 시각(epoch 밀리초, 10진)>.<서명(base64url, 43자)>`.
 * 서명 = HMAC-SHA256(세션 서명 키, 아래 일곱 줄을 "\n" 으로 이은 글):
 *   REDEPLOY_CONFIRMATION_PURPOSE · "rc1" · 서비스 · 커밋 · 요청 ID · 만든 시각(10진) · 계정
 * 용도 줄이 서명에 들어 있어 세션 토큰(`v1.<시각>` 에 서명)과 서로 바꿔 끼워지지 않는다.
 * 통하는 때: 0 <= 지금 - 만든 시각 < REDEPLOY_CONFIRMATION_LIFETIME_MILLISECONDS. 상태를 두지 않는다(저장소 · 메모리 표 없음). */

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

/** `adm-` + 예측할 수 없는 글자(암호학적 난수) — REDEPLOY_REQUEST_ID_PATTERN 안. */
export function newRedeployRequestId(): string {
  throw new Error("not implemented: newRedeployRequestId");
}

/** 빈 키 · 꼴이 틀린 요청 ID 면 예외. */
export function issueRedeployConfirmation(signingKey: string, fields: RedeployConfirmationFields): string {
  void signingKey; void fields;
  throw new Error("not implemented: issueRedeployConfirmation");
}

export function verifyRedeployConfirmation(token: unknown, signingKey: string, expected: { service: string; commitSha: string; account: string }, now: number): RedeployConfirmationCheck {
  void token; void signingKey; void expected; void now;
  throw new Error("not implemented: verifyRedeployConfirmation");
}
