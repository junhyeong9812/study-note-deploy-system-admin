/** 분석의 답(다섯 칸) — 실행 자리가 검증해 돌려준 것을 어드민이 한 번 더 검증한다(명세 ⑫ §13). 뼈대: 구현 워커가 채운다.
 * 계약: analysis-answer.test.ts 머리 주석. */

export const ANALYSIS_CONFIDENCES = ["low", "medium", "high"] as const;
export type AnalysisConfidence = (typeof ANALYSIS_CONFIDENCES)[number];
export const ANALYSIS_ACTIONS = ["rollback", "redeploy", "none"] as const;
export type AnalysisAction = (typeof ANALYSIS_ACTIONS)[number];

/** 확신의 정도 · 권하는 조치의 보이는 글(표시일 뿐 — 누를 수 없다). */
export const ANALYSIS_CONFIDENCE_LABELS: Readonly<Record<AnalysisConfidence, string>> = { low: "낮음", medium: "중간", high: "높음" };
export const ANALYSIS_ACTION_LABELS: Readonly<Record<AnalysisAction, string>> = {
  rollback: "되돌리기를 권함", redeploy: "다시 배포를 권함", none: "권하는 조치 없음",
};

export interface AnalysisAnswer {
  cause: string;
  evidence: string[];
  confidence: AnalysisConfidence;
  remedy: string;
  recommendedAction: AnalysisAction;
}

/** 실행 자리의 `data.answer` → 다섯 칸. 꼴이 하나라도 틀리면 null(고쳐 쓰지도 잘라 내지도 않는다). */
export function parseAnalysisAnswer(value: unknown): AnalysisAnswer | null {
  void value;
  throw new Error("parseAnalysisAnswer: 구현 전");
}
