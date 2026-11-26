/** 실행 자리의 분석 부르기(POST /runs · 용도 analysis) — 뼈대: 구현 워커가 채운다. 계약: analysis-runner-client.test.ts 머리 주석. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { AnalysisAnswer } from "@/features/incident-analysis/lib/analysis-answer";

export const CLAUDE_RUNNER_CALL_SECRET_HEADER = "X-Claude-Runner-Secret";
export const CLAUDE_RUNNER_RUNS_PATH = "/runs";
export const ANALYSIS_PURPOSE = "analysis";
/** 실행 자리의 분석 상한(240초) + 여유 — 넘으면 답을 받지 못한 것(no_answer). */
export const ANALYSIS_RUN_TIMEOUT_MILLISECONDS = 260_000;
/** 실행 자리의 프롬프트 상한(코드 포인트) — 넘으면 보내지 않는다. */
export const ANALYSIS_PROMPT_MAXIMUM_CHARACTERS = 60_000;

export const ANALYSIS_RUN_FAILURE_REASONS = [
  "prompt_too_long", "answer_invalid", "invalid_answer", "bad_output", "claude_failed", "timeout", "busy", "limit_reached", "disabled",
  "token_missing", "claude_unavailable", "runner_unavailable", "unauthorized", "rejected", "internal", "unreachable", "no_answer",
] as const;
export type AnalysisRunFailureReason = (typeof ANALYSIS_RUN_FAILURE_REASONS)[number];

export type AnalysisRunResult =
  | { kind: "answered"; answer: AnalysisAnswer }
  | { kind: "failed"; reason: AnalysisRunFailureReason };

export interface AnalysisRunnerClientOptions {
  baseUrl: string;
  callSecret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface AnalysisRunnerClient {
  runAnalysis(prompt: string, requestId: string): Promise<AnalysisRunResult>;
}

export function createAnalysisRunnerClient(options: AnalysisRunnerClientOptions): AnalysisRunnerClient {
  void options;
  throw new Error("createAnalysisRunnerClient: 구현 전");
}
