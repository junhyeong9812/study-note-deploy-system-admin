/** 실행 자리의 분석 부르기(POST /runs · 용도 analysis — 실행 자리 runner/server.py 의 계약). 순수 — 기준 주소 · 호출용 비밀값은 부르는 쪽이 준다.
 * POST <base>/runs 한 번(다시 보내지 않는다) · 머리 X-Claude-Runner-Secret · 본문 {"purpose":"analysis","prompt","request_id"} 뿐 · redirect manual · no-store ·
 * 기한 ANALYSIS_RUN_TIMEOUT_MILLISECONDS(본문까지). 6만 자(코드 포인트)를 넘는 프롬프트는 부르지 않는다.
 * 200 의 data.answer 는 parseAnalysisAnswer 로 한 번 더 검증한다. 실패는 고정 낱말만(실행 자리의 글 · 주소 · 예외 문구를 싣지 않는다) —
 * 대응표는 failureReasonFor. 계약: analysis-runner-client.test.ts 머리 주석. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { parseAnalysisAnswer, type AnalysisAnswer } from "@/features/incident-analysis/lib/analysis-answer";
import { isConnectFailure } from "@/features/deploy-redeploy/lib/redeploy-accept-client";
import { isRecord, upstreamUrl } from "@/shared/lib/upstream-fetch";

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

function defaultTimeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

function errorCodeOf(json: unknown): string | null {
  if (!isRecord(json) || !isRecord(json.error)) return null;
  return typeof json.error.code === "string" ? json.error.code : null;
}

function codeIn<Reason extends AnalysisRunFailureReason>(code: string | null, reasons: readonly Reason[], otherwise: AnalysisRunFailureReason): AnalysisRunFailureReason {
  return code !== null && (reasons as readonly string[]).includes(code) ? (code as Reason) : otherwise;
}

/** 200 이 아닌 상태 → 고정 낱말(본문의 code 는 아는 낱말일 때만 옮긴다). */
function failureReasonFor(status: number, json: unknown): AnalysisRunFailureReason {
  const code = errorCodeOf(json);
  if (status === 502) return codeIn(code, ["invalid_answer", "bad_output", "claude_failed"], "internal");
  if (status === 504) return "timeout";
  if (status === 503) return codeIn(code, ["token_missing", "claude_unavailable"], "runner_unavailable");
  if (status >= 500) return "internal";
  if (status === 429) return codeIn(code, ["busy", "limit_reached", "disabled"], "rejected");
  if (status === 401) return "unauthorized";
  if (status >= 200 && status < 300) return "answer_invalid";
  return "rejected";   // 그 밖의 4xx · 3xx
}

export function createAnalysisRunnerClient(options: AnalysisRunnerClientOptions): AnalysisRunnerClient {
  return {
    async runAnalysis(prompt, requestId) {
      if (Array.from(prompt).length > ANALYSIS_PROMPT_MAXIMUM_CHARACTERS) return { kind: "failed", reason: "prompt_too_long" };
      const signal = (options.timeoutSignal ?? defaultTimeoutSignal)(ANALYSIS_RUN_TIMEOUT_MILLISECONDS);
      let response: Response;
      try {
        response = await options.fetch(upstreamUrl(options.baseUrl, CLAUDE_RUNNER_RUNS_PATH), {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", [CLAUDE_RUNNER_CALL_SECRET_HEADER]: options.callSecret },
          body: JSON.stringify({ purpose: ANALYSIS_PURPOSE, prompt, request_id: requestId }),
          signal,
          redirect: "manual",
          cache: "no-store",
        });
      } catch (error) {
        // 연결을 맺지 못했으면 나가지 않았다 — 그 밖(기한 · 보낸 뒤 끊김)은 실행 자리가 한 번을 셌을 수 있다
        return { kind: "failed", reason: isConnectFailure(error, signal) ? "unreachable" : "no_answer" };
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        return { kind: "failed", reason: "no_answer" };
      }
      let json: unknown = null;
      let parsed = true;
      try { json = JSON.parse(text) as unknown; } catch { parsed = false; }
      if (response.status !== 200) return { kind: "failed", reason: failureReasonFor(response.status, json) };
      if (!parsed) return { kind: "failed", reason: "no_answer" };
      const data = isRecord(json) && json.success === true && isRecord(json.data) ? json.data : null;
      const answer = data === null ? null : parseAnalysisAnswer(data.answer);
      return answer === null ? { kind: "failed", reason: "answer_invalid" } : { kind: "answered", answer };
    },
  };
}
