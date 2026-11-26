/** 분석에 보내는 글(프롬프트) — 가린 뒤 자른 근거 묶음(+ 배포 실패의 전체 출력)을 무작위 경계 표지로 감싼 고정 틀. 뼈대: 구현 워커가 채운다.
 * 계약: analysis-prompt.test.ts 머리 주석. */
import type { IncidentEvidence } from "@/features/incidents/lib/incident-evidence";
import type { AnalysisMaskKind } from "@/features/incident-analysis/lib/analysis-masking";
import type { DeployFailureOutputResult } from "@/features/incident-analysis/lib/deploy-failure-output-client";

/** 자료(근거 묶음 + 출력)의 UTF-8 바이트 상한 — 12-1 의 묶음 상한과 같다. */
export const ANALYSIS_DATA_MAXIMUM_BYTES = 48_000;
/** 자료 안에서 배포 실패 출력 구역이 쓰는 바이트의 상한(끝부분을 먼저 남긴다). */
export const FAILURE_OUTPUT_MAXIMUM_BYTES = 16_000;
/** 경계 표지의 무작위 바이트 수 — 16진 32자. */
export const ANALYSIS_BOUNDARY_BYTES = 16;
/** 자료와 겹치지 않는 표지를 뽑는 횟수의 상한. */
export const ANALYSIS_BOUNDARY_ATTEMPTS = 8;
export const FAILURE_OUTPUT_SECTION_TITLE = "배포 실패의 전체 출력";

export interface AnalysisPromptInput {
  /** 맞추기(fitIncidentEvidence) 전의 묶음 — 가린 뒤에 맞춘다 */
  evidence: IncidentEvidence;
  /** 배포 실패 문제일 때만(그 밖은 null) */
  failureOutput: DeployFailureOutputResult | null;
  /** 무작위 원천(주입 — 실제는 node:crypto randomBytes) */
  randomBytes: (size: number) => Uint8Array;
}

export type AnalysisPromptResult =
  | {
    ok: true;
    prompt: string;
    /** 이번 표지의 무작위 글자(16진 32자) */
    boundary: string;
    /** 표지 사이의 자료(가린 뒤 · 자른 뒤) */
    dataText: string;
    /** 프롬프트의 코드 포인트 수 · UTF-8 바이트 수 */
    characters: number;
    bytes: number;
    /** 줄인 것(12-1 의 줄인 것 + 출력 구역에서 뺀 것) */
    reductions: string[];
    maskCounts: Partial<Record<AnalysisMaskKind, number>>;
  }
  | { ok: false; reason: "too_long"; characters: number }
  | { ok: false; reason: "boundary_unavailable" };

export function buildAnalysisPrompt(input: AnalysisPromptInput): AnalysisPromptResult {
  void input;
  throw new Error("buildAnalysisPrompt: 구현 전");
}

/** 프롬프트의 SHA-256(소문자 16진 64자) — 미리본 글과 보내는 글이 바이트까지 같은지 잇는 값. */
export function analysisPromptDigest(prompt: string): string {
  void prompt;
  throw new Error("analysisPromptDigest: 구현 전");
}
