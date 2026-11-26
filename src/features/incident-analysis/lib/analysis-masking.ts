/** 분석에 보내는 글의 가림(한 겹 더 — 명세 ⑫ §19) — 배포 마스터(12-2)의 규칙표와 같은 뜻으로 어드민에서 한 번 더 가린다. 뼈대: 구현 워커가 채운다.
 * 계약(테스트가 고정): incident-analysis/lib/analysis-masking.test.ts 머리 주석. */

/** 가림 표시의 종류 — 표시는 `[가림:<종류>]`(배포 마스터와 같은 꼴). */
export const ANALYSIS_MASK_KINDS = ["pem", "token", "authorization", "url_credential", "secret_field", "hex", "email", "private_ip"] as const;
export type AnalysisMaskKind = (typeof ANALYSIS_MASK_KINDS)[number];

export interface MaskedText {
  text: string;
  /** 종류 → 가린 횟수(0 인 종류는 싣지 않는다) */
  counts: Partial<Record<AnalysisMaskKind, number>>;
}

export function maskForAnalysis(text: string): MaskedText {
  void text;
  throw new Error("maskForAnalysis: 구현 전");
}
