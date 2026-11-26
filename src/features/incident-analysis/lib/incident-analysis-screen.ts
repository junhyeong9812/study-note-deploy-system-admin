/** 분석 화면의 꼴(순수 — 서버 진입 함수가 채우고 화면이 그린다) · 경로와 입력 검증 · 고정 글. 계약: ui/IncidentAnalysisScreen.test.ts · app/incidents/incident-analysis-page.test.ts. */
import type { AnalysisMaskKind } from "@/features/incident-analysis/lib/analysis-masking";
import { isIncidentId } from "@/features/incidents/lib/incident-id";
import { singleValue } from "@/shared/lib/query-input";
import { invalidInput, type SearchParamsInput, type UpstreamFailure } from "@/shared/lib/upstream-result";
import type { AnalysisEntry, AnalysisFailureReason } from "@/features/incident-analysis/lib/incident-analysis-service";

export const INCIDENT_ANALYSIS_PATH = "/incidents/analysis";
export const INCIDENT_ANALYSIS_START_PATH = "/api/incidents/analysis";
/** 진행 중일 때만 화면이 다시 읽는 간격(meta refresh). */
export const INCIDENT_ANALYSIS_REFRESH_SECONDS = 5;

export const INCIDENT_ANALYSIS_TEXT = {
  title: "분석",
  disclaimer: "분석은 틀릴 수 있습니다 — 근거와 함께 확인하세요",
  requestLink: "분석 요청 — 보낼 글 미리 보기",
  previewTitle: "보낼 글 그대로(가린 뒤 · 자른 뒤)",
  send: "이 글을 보낸다",
  running: "분석 진행 중",
  interrupted: "끊김 — 결과를 모름(5분 안에 답을 받지 못했습니다 · 실행 자리는 한 번을 셌을 수 있습니다)",
  unreadable: "저장된 분석 하나를 읽지 못했습니다",
  storeUnavailable: "저장소에 닿지 못해 분석을 보이거나 시작할 수 없습니다",
  notConfigured: "분석 설정이 없습니다(실행 자리 · 저장소)",
  earlierOpening: "옛 분석 — 이 문제가 지금과 다른 때에 열렸을 때 보낸 것입니다",
  sentText: "보낸 글 그대로",
  closed: "이 문제는 지금 열려 있지 않습니다 — 분석을 요청할 수 없습니다",
  unchecked: "이 문제가 지금 열려 있는지 확인하지 못했습니다 — 분석을 요청할 수 없습니다",
  noAnalysis: "아직 분석이 없습니다",
  cause: "원인",
  evidence: "근거",
  confidence: "확신의 정도",
  remedy: "대처법",
  recommendedAction: "권하는 조치(표시일 뿐 — 실행하지 않습니다)",
  toIncident: "문제 화면으로",
  /** POST — 미리볼 때와 그 문제의 "언제부터"가 다르다(닫혔다 다시 열림 — 명세 ⑫ §21 3) */
  reopened: "문제가 다시 열렸습니다 — 미리보기를 다시 여세요",
  /** POST — 이미 한 번 보낸 미리보기(명세 ⑫ §21 4) */
  previewUsed: "이미 보낸 미리보기입니다 — 분석 화면에서 결과를 보세요",
} as const;

/** 실패의 까닭마다 고정 글(실행 자리의 글 · 주소를 내지 않는다). */
export const ANALYSIS_FAILURE_TEXTS: Readonly<Record<AnalysisFailureReason, string>> = {
  prompt_too_long: "보낼 글이 6만 자를 넘어 보내지 않았습니다",
  answer_invalid: "답의 꼴이 틀림 — 저장하지 않았습니다",
  invalid_answer: "Claude 의 답이 정해진 꼴이 아니었습니다(실행 자리가 거절)",
  bad_output: "Claude 의 출력을 읽지 못했습니다",
  claude_failed: "Claude 실행이 실패했습니다",
  timeout: "Claude 가 시간 안에 답하지 않았습니다(240초)",
  busy: "실행 자리가 다른 요청을 처리하는 중이었습니다 — 잠시 뒤 다시 요청하세요",
  limit_reached: "Claude 사용 상한에 닿았습니다 — Claude 사용량 화면에서 확인하세요",
  disabled: "Claude 호출이 꺼져 있습니다 — Claude 사용량 화면에서 켤 수 있습니다",
  token_missing: "실행 자리에 Claude 토큰이 없습니다",
  claude_unavailable: "실행 자리에서 Claude 를 쓸 수 없습니다",
  runner_unavailable: "실행 자리가 일시적으로 쓸 수 없는 상태였습니다",
  unauthorized: "실행 자리가 어드민의 호출 비밀값을 받지 않았습니다",
  rejected: "실행 자리가 요청을 거절했습니다",
  internal: "실행 자리의 내부 오류",
  unreachable: "실행 자리에 닿지 못했습니다",
  no_answer: "실행 자리의 답을 받지 못했습니다 — 한 번이 세어졌을 수 있습니다",
  result_not_stored: "결과를 저장하지 못했습니다",
};

export interface AnalysisPreviewView {
  /** 보낼 글 그대로 */
  prompt: string;
  /** 미리보기의 서명 값(보내기 폼에 싣는다) */
  token: string;
  characters: number;
  bytes: number;
  reductions: string[];
  maskCounts: Partial<Record<AnalysisMaskKind, number>>;
}

export type AnalysisPreviewState =
  | { kind: "ready"; view: AnalysisPreviewView }
  | { kind: "unavailable"; text: string };

export type AnalysisIncidentState =
  | { state: "open"; kindLabel: string; target: string; since: string | null }
  | { state: "closed" }
  | { state: "unchecked" };

export type AnalysisHistoryView =
  | { ok: true; entries: AnalysisEntry[] }
  | { ok: false; reason: "store_unavailable" | "not_configured" };

export interface IncidentAnalysisScreenData {
  checkedAt: string;
  incidentId: string;
  incident: AnalysisIncidentState;
  history: AnalysisHistoryView;
  /** preview=1 이고 문제가 열려 있을 때만 */
  preview: AnalysisPreviewState | null;
}

export type IncidentAnalysisScreenOutcome =
  | { kind: "invalid_input" }
  | { kind: "screen"; data: IncidentAnalysisScreenData };

/** `/incidents/analysis?incident=<식별자>`(+ `&preview=1`). */
export function incidentAnalysisHref(incidentId: string, preview = false): string {
  const search = new URLSearchParams({ incident: incidentId });
  if (preview) search.set("preview", "1");
  return `${INCIDENT_ANALYSIS_PATH}?${search.toString()}`;
}

export interface IncidentAnalysisQuery {
  incidentId: string;
  preview: boolean;
}

/** 입력: `incident`(필수 · isIncidentId) · `preview`(없음 또는 정확히 "1"). 같은 이름이 여러 번이면 거절 — 거절이면 다른 서버를 부르지 않는다. */
export function parseIncidentAnalysisQuery(input: SearchParamsInput): { ok: true; query: IncidentAnalysisQuery } | UpstreamFailure {
  const incident = singleValue(input, "incident");
  if (incident === null || incident === "many" || !isIncidentId(incident)) return invalidInput("incident");
  const preview = singleValue(input, "preview");
  if (preview === "many" || (preview !== null && preview !== "1")) return invalidInput("preview");
  return { ok: true, query: { incidentId: incident, preview: preview === "1" } };
}
