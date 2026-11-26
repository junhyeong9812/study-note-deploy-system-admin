/** 상한을 넓히는 바꿈의 확인 값(순수 — 키는 부르는 쪽이 준다). 재배포의 확인 값(redeploy-confirmation, rc1)과 같은 방식:
 * HMAC-SHA256(세션 서명 키) · 용도 줄이 서명에 들어 있어 세션 토큰 · 재배포 확인 값과 서로 바꿔 끼워지지 않는다 · 5분 · 상태를 두지 않는다.
 *
 * 꼴: `cc1.<만든 시각(epoch 밀리초, 10진 1~16자리)>.<서명(base64url, 43자)>` — 값 · 계정 · 비밀번호는 싣지 않는다(서명에만 든다).
 * 서명 = HMAC-SHA256(세션 서명 키, 아래 일곱 줄을 "\n" 으로 이은 글):
 *   CLAUDE_LIMITS_CONFIRMATION_PURPOSE · "cc1" · 계정 · 만든 시각(10진) · 앞 값의 바꾼 시각(실행 자리의 changed_at — null 이면 "-")
 *   · claudeLimitsCanonical(앞 값) · claudeLimitsCanonical(새 값)
 *   앞 값 = 확인 화면을 만들 때 실행 자리가 쥐고 있던 값, 새 값 = 바꾸려는 값 전부(켬/끔 · 전체 · 모든 용도).
 *   바꾼 시각을 묶는 까닭: 넓힌 뒤 누가 같은 값으로 되돌려 놓아도(바꿀 때마다 실행 자리의 changed_at 이 바뀐다) 같은 확인 값으로 다시 넓히지 못하게.
 *   단순화: changed_at 은 초 단위라 같은 초 안의 두 바꿈은 가르지 못한다.
 * 통하는 때: 0 <= 지금 - 만든 시각 < CLAUDE_LIMITS_CONFIRMATION_LIFETIME_MILLISECONDS.
 * 확인할 때의 앞 값은 **그때 다시 읽은 실행 자리의 값**이다 — 그 사이 누가 바꿨으면 mismatch(다시 확인하게 한다). */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ClaudeLimitPair, ClaudeLimitsChange } from "@/features/claude-usage/lib/claude-limits";

export const CLAUDE_LIMITS_CONFIRMATION_PURPOSE = "claude-limits-confirmation";
export const CLAUDE_LIMITS_CONFIRMATION_VERSION = "cc1";
export const CLAUDE_LIMITS_CONFIRMATION_LIFETIME_MILLISECONDS = 5 * 60 * 1000;
/** 이보다 긴 값은 해석하지 않고 거절한다(폼 해석에서 malformed). */
export const CLAUDE_LIMITS_CONFIRMATION_MAX_LENGTH = 128;

export interface ClaudeLimitsConfirmationFields {
  /** 세션의 계정(ADMIN_USER) */
  account: string;
  /** epoch 밀리초 */
  issuedAt: number;
  /** 앞 값의 바꾼 시각(실행 자리 GET /limits 의 changed_at) — 바꾼 적이 없으면 null */
  beforeChangedAt: string | null;
  before: ClaudeLimitsChange;
  after: ClaudeLimitsChange;
}

export type ClaudeLimitsConfirmationCheck =
  | { ok: true; issuedAt: number }
  /** malformed: 꼴이 아님(글자 아님 · 빈 값 · 너무 김 · 접두 · 조각 수 · 시각 · 서명 길이) ·
   * mismatch: 서명이 맞지 않음(새 값 · 앞 값 · 계정 · 키가 다름, 미래 시각 포함) · expired: 서명은 맞으나 5분이 지났다 */
  | { ok: false; reason: "malformed" | "mismatch" | "expired" };

const ISSUED_AT_PATTERN = /^\d{1,16}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 서명에 넣는 값의 글 — 켬/끔 · 전체 · 용도(이름 차례로 정렬 — 실행 자리가 주는 차례가 바뀌어도 같은 글). 예: `on;total=30/10;analysis=6/2;chat=40/10`. */
export function claudeLimitsCanonical(change: ClaudeLimitsChange): string {
  const pairText = (pair: ClaudeLimitPair) => `${pair.perDay}/${pair.perHour}`;
  const purposes = Object.keys(change.purposes).sort().map((name) => `${name}=${pairText(change.purposes[name])}`);
  return [change.enabled ? "on" : "off", `total=${pairText(change.total)}`, ...purposes].join(";");
}

/** 서명하는 글 — 일곱 줄(용도 · 판 · 계정 · 만든 시각 · 앞 값의 바꾼 시각 · 앞 값 · 새 값). */
function sign(signingKey: string, fields: ClaudeLimitsConfirmationFields): string {
  const lines = [
    CLAUDE_LIMITS_CONFIRMATION_PURPOSE, CLAUDE_LIMITS_CONFIRMATION_VERSION, fields.account, String(fields.issuedAt),
    fields.beforeChangedAt ?? "-", claudeLimitsCanonical(fields.before), claudeLimitsCanonical(fields.after),
  ];
  return createHmac("sha256", signingKey).update(lines.join("\n")).digest("base64url");
}

/** 빈 키 · 음수 시각이면 예외. */
export function issueClaudeLimitsConfirmation(signingKey: string, fields: ClaudeLimitsConfirmationFields): string {
  if (signingKey.trim().length === 0) throw new Error("claude limits confirmation signing key is empty");
  if (!Number.isSafeInteger(fields.issuedAt) || fields.issuedAt < 0) throw new Error("invalid issuedAt");
  return `${CLAUDE_LIMITS_CONFIRMATION_VERSION}.${fields.issuedAt}.${sign(signingKey, fields)}`;
}

export function verifyClaudeLimitsConfirmation(
  token: unknown, signingKey: string,
  expected: { account: string; beforeChangedAt: string | null; before: ClaudeLimitsChange; after: ClaudeLimitsChange }, now: number,
): ClaudeLimitsConfirmationCheck {
  if (typeof token !== "string" || token.length === 0 || token.length > CLAUDE_LIMITS_CONFIRMATION_MAX_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [version, issuedAtText, signature] = parts;
  if (version !== CLAUDE_LIMITS_CONFIRMATION_VERSION || !ISSUED_AT_PATTERN.test(issuedAtText) || !SIGNATURE_PATTERN.test(signature)) {
    return { ok: false, reason: "malformed" };
  }
  if (signingKey.trim().length === 0) return { ok: false, reason: "mismatch" };
  const issuedAt = Number(issuedAtText);
  const expectedSignature = Buffer.from(sign(signingKey, { ...expected, issuedAt }));
  const actualSignature = Buffer.from(signature);
  // 인코딩된 글자끼리 비교한다 — base64url 마지막 글자의 남는 비트만 바꾼 변조도 거절된다(재배포 확인 값과 같은 방식)
  if (expectedSignature.length !== actualSignature.length || !timingSafeEqual(expectedSignature, actualSignature)) return { ok: false, reason: "mismatch" };
  if (issuedAt > now) return { ok: false, reason: "mismatch" };   // 시계가 거꾸로 — 통하는 창 밖
  if (now - issuedAt >= CLAUDE_LIMITS_CONFIRMATION_LIFETIME_MILLISECONDS) return { ok: false, reason: "expired" };
  return { ok: true, issuedAt };
}
