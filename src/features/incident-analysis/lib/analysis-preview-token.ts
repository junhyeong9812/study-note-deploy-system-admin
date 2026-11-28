/** 미리보기 → 보내기를 잇는 서명 값(순수 — 키는 부르는 쪽이 준다 · 상태를 두지 않는다). 재배포의 확인 값(rc1 — redeploy-confirmation.ts)과 같은 방식.
 * 꼴: `ap2.<만든 시각(epoch 밀리초, 10진)>.<since 칸>.<서명(base64url 43자)>` — since 칸 = 미리볼 때 그 문제의 "언제부터"가 없으면 `-`, 있으면 `s` + base64url(UTF-8).
 * 서명 = HMAC-SHA256(세션 서명 키, 일곱 줄을 "\n" 으로 이은 글): ANALYSIS_PREVIEW_PURPOSE · "ap2" · 문제 식별자 · 프롬프트의 SHA-256(16진) · 만든 시각 · since 칸 · 계정.
 * 용도 줄이 서명에 들어 있어 세션 토큰 · 재배포의 확인 값과 서로 바꿔 끼워지지 않는다. 옛 판 ap1 은 꼴이 아니다(malformed).
 * 통하는 때: 0 <= 지금 - 만든 시각 < ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS. 맞으면 서명이 묶은 since 를 돌려준다 — 부르는 쪽이 지금의 since 와 견준다
 * (같은 식별자가 닫혔다 다시 열린 뒤에 옛 미리보기가 새 발생분의 분석으로 나가지 않게). 계약: analysis-preview-token.test.ts 머리 주석. */
import { createHmac, timingSafeEqual } from "node:crypto";

export const ANALYSIS_PREVIEW_PURPOSE = "incident-analysis-preview";
export const ANALYSIS_PREVIEW_TOKEN_VERSION = "ap2";
export const ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS = 10 * 60 * 1000;
/** 이보다 긴 값은 해석하지 않고 거절한다 — since 칸(base64url)이 들어 길어졌다. */
export const ANALYSIS_PREVIEW_TOKEN_MAX_LENGTH = 2_048;

export interface AnalysisPreviewTokenFields {
  incidentId: string;
  /** analysisPromptDigest(prompt) */
  promptDigest: string;
  issuedAt: number;
  account: string;
  /** 미리볼 때 그 문제의 "언제부터"(없으면 null) — 서명에 묶인다. */
  incidentSince: string | null;
}

export type AnalysisPreviewTokenCheck = { ok: true; incidentSince: string | null } | { ok: false; reason: "malformed" | "mismatch" | "expired" };

const ISSUED_AT_PATTERN = /^\d{1,16}$/;
const SINCE_FIELD_PATTERN = /^(-|s[A-Za-z0-9_-]*)$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function sinceField(incidentSince: string | null): string {
  return incidentSince === null ? "-" : `s${Buffer.from(incidentSince, "utf8").toString("base64url")}`;
}

function sinceOf(field: string): string | null {
  return field === "-" ? null : Buffer.from(field.slice(1), "base64url").toString("utf8");
}

function sign(signingKey: string, fields: Omit<AnalysisPreviewTokenFields, "incidentSince">, sinceText: string): string {
  const lines = [
    ANALYSIS_PREVIEW_PURPOSE, ANALYSIS_PREVIEW_TOKEN_VERSION, fields.incidentId, fields.promptDigest, String(fields.issuedAt), sinceText, fields.account,
  ];
  return createHmac("sha256", signingKey).update(lines.join("\n")).digest("base64url");
}

/** 빈 키 · 시각이 정수가 아니면 예외. */
export function issueAnalysisPreviewToken(signingKey: string, fields: AnalysisPreviewTokenFields): string {
  if (signingKey.trim().length === 0) throw new Error("analysis preview signing key is empty");
  if (!Number.isSafeInteger(fields.issuedAt) || fields.issuedAt < 0) throw new Error("invalid issuedAt");
  const sinceText = sinceField(fields.incidentSince);
  return `${ANALYSIS_PREVIEW_TOKEN_VERSION}.${fields.issuedAt}.${sinceText}.${sign(signingKey, fields, sinceText)}`;
}

export function verifyAnalysisPreviewToken(
  token: unknown, signingKey: string, expected: Omit<AnalysisPreviewTokenFields, "issuedAt" | "incidentSince">, now: number,
): AnalysisPreviewTokenCheck {
  if (typeof token !== "string" || token.length === 0 || token.length > ANALYSIS_PREVIEW_TOKEN_MAX_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [version, issuedAtText, sinceText, signature] = parts;
  if (version !== ANALYSIS_PREVIEW_TOKEN_VERSION || !ISSUED_AT_PATTERN.test(issuedAtText) || !SINCE_FIELD_PATTERN.test(sinceText)
    || !SIGNATURE_PATTERN.test(signature)) return { ok: false, reason: "malformed" };
  if (signingKey.trim().length === 0) return { ok: false, reason: "mismatch" };
  const issuedAt = Number(issuedAtText);
  const expectedSignature = Buffer.from(sign(signingKey, { ...expected, issuedAt }, sinceText));
  const actualSignature = Buffer.from(signature);
  // 인코딩된 글자끼리 비교한다 — base64url 마지막 글자의 남는 비트만 바꾼 변조도 거절된다(rc1 과 같은 방식)
  if (expectedSignature.length !== actualSignature.length || !timingSafeEqual(expectedSignature, actualSignature)) return { ok: false, reason: "mismatch" };
  if (issuedAt > now) return { ok: false, reason: "mismatch" };   // 시계가 거꾸로 — 통하는 창 밖
  if (now - issuedAt >= ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS) return { ok: false, reason: "expired" };
  return { ok: true, incidentSince: sinceOf(sinceText) };
}
