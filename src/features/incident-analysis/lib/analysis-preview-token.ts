/** 미리보기 → 보내기를 잇는 서명 값(순수 — 키는 부르는 쪽이 준다 · 상태를 두지 않는다). 뼈대: 구현 워커가 채운다.
 * 계약: analysis-preview-token.test.ts 머리 주석. */

export const ANALYSIS_PREVIEW_TOKEN_VERSION = "ap1";
export const ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS = 10 * 60 * 1000;

export interface AnalysisPreviewTokenFields {
  incidentId: string;
  /** analysisPromptDigest(prompt) */
  promptDigest: string;
  issuedAt: number;
  account: string;
}

export type AnalysisPreviewTokenCheck = { ok: true } | { ok: false; reason: "malformed" | "mismatch" | "expired" };

export function issueAnalysisPreviewToken(signingKey: string, fields: AnalysisPreviewTokenFields): string {
  void signingKey; void fields;
  throw new Error("issueAnalysisPreviewToken: 구현 전");
}

export function verifyAnalysisPreviewToken(
  token: unknown, signingKey: string, expected: Omit<AnalysisPreviewTokenFields, "issuedAt">, now: number,
): AnalysisPreviewTokenCheck {
  void token; void signingKey; void expected; void now;
  throw new Error("verifyAnalysisPreviewToken: 구현 전");
}
