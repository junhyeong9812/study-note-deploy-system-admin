/** 분석의 답(다섯 칸) — 실행 자리가 검증해 돌려준 것을 어드민이 한 번 더 검증한다(명세 ⑫ §13 · §14).
 * 규칙은 실행 자리(analysis_answer.py)의 검증과 같다 — 계약: analysis-answer.test.ts 머리 주석. */

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

const ANSWER_FIELDS = ["cause", "evidence", "confidence", "remedy", "recommended_action"] as const;
export const ANALYSIS_CAUSE_MAXIMUM_LENGTH = 2000;
export const ANALYSIS_EVIDENCE_MAXIMUM_COUNT = 10;
export const ANALYSIS_EVIDENCE_MAXIMUM_LENGTH = 500;
export const ANALYSIS_REMEDY_MAXIMUM_LENGTH = 4000;
/** 보이는 글자 — 공백(Z*) · 제어(Cc) · 서식(Cf)이 아닌 것. */
const VISIBLE_CHARACTER = /[^\p{Z}\p{Cc}\p{Cf}]/u;

/** 1~maximum 자(코드 포인트) · 보이는 글자가 하나 이상 · UTF-8 로 쓸 수 있는(짝 없는 서로게이트가 없는) 글. */
function isAnswerText(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || !value.isWellFormed() || !VISIBLE_CHARACTER.test(value)) return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= maximum;
}

function isOneOf<Value extends string>(value: unknown, choices: readonly Value[]): value is Value {
  return typeof value === "string" && (choices as readonly string[]).includes(value);
}

/** 실행 자리의 `data.answer` → 다섯 칸. 꼴이 하나라도 틀리면 null(고쳐 쓰지도 잘라 내지도 않는다). */
export function parseAnalysisAnswer(value: unknown): AnalysisAnswer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  const names = Object.keys(answer);
  if (names.length !== ANSWER_FIELDS.length || !ANSWER_FIELDS.every((name) => Object.hasOwn(answer, name))) return null;
  const { cause, evidence, confidence, remedy, recommended_action: recommendedAction } = answer;
  if (!isAnswerText(cause, ANALYSIS_CAUSE_MAXIMUM_LENGTH) || !isAnswerText(remedy, ANALYSIS_REMEDY_MAXIMUM_LENGTH)) return null;
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > ANALYSIS_EVIDENCE_MAXIMUM_COUNT
    || !evidence.every((item) => isAnswerText(item, ANALYSIS_EVIDENCE_MAXIMUM_LENGTH))) return null;
  if (!isOneOf(confidence, ANALYSIS_CONFIDENCES) || !isOneOf(recommendedAction, ANALYSIS_ACTIONS)) return null;
  return { cause, evidence: [...evidence] as string[], confidence, remedy, recommendedAction };
}
