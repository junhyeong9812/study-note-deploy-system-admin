/** 분석의 시작 · 진행 중 · 결과의 저장(Redis) — 뼈대: 구현 워커가 채운다. 계약: incident-analysis-service.test.ts 머리 주석. */
import type { AnalysisAnswer } from "@/features/incident-analysis/lib/analysis-answer";
import type { AnalysisRunFailureReason, AnalysisRunResult } from "@/features/incident-analysis/lib/analysis-runner-client";

/** 이 서비스가 쓰는 Redis 명령(ioredis 의 같은 이름 명령과 같은 인자 · 같은 답). */
export interface AnalysisRedisCommands {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", milliseconds: number, condition?: "NX"): Promise<"OK" | null>;
  del(...keys: string[]): Promise<number>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<"OK">;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  pexpire(key: string, milliseconds: number): Promise<number>;
}

/** 진행 중이 이보다 오래되면 "끊김 — 결과를 모름"(다시 요청할 수 있다). 잠금의 수명도 같다. */
export const ANALYSIS_RUNNING_LIMIT_MILLISECONDS = 5 * 60 * 1000;
export const ANALYSIS_HISTORY_LIMIT = 5;
export const ANALYSIS_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

/** 문제 식별자의 키 — 식별자는 base64url 로 싣는다(식별자 안의 `:` 가 키의 마디와 섞이지 않게). */
export function incidentAnalysisKeys(incidentId: string): { lock: string; history: string; attempt: (requestId: string) => string } {
  void incidentId;
  throw new Error("incidentAnalysisKeys: 구현 전");
}

export type AnalysisFailureReason = AnalysisRunFailureReason | "result_not_stored";

/** 저장되는 한 번의 분석(JSON — 판 1). */
export interface StoredAnalysisAttempt {
  version: 1;
  requestId: string;
  incidentId: string;
  /** 보낼 때 그 문제가 언제부터 열린 것이었나(모르면 null) */
  incidentSince: string | null;
  /** 누른 사람(`admin:<계정>`) */
  account: string;
  startedAt: string;
  /** 보낸 글 그대로 */
  prompt: string;
  promptBytes: number;
  state: "running" | "succeeded" | "failed";
  finishedAt: string | null;
  durationMilliseconds: number | null;
  answer: AnalysisAnswer | null;
  failureReason: AnalysisFailureReason | null;
}

export interface AnalysisStartRequest {
  incidentId: string;
  incidentSince: string | null;
  prompt: string;
  account: string;
}

export type AnalysisStartResult =
  | { kind: "started"; requestId: string }
  | { kind: "already_running"; requestId: string | null }
  | { kind: "store_unavailable" };

export type AnalysisEntry =
  | { kind: "unreadable" }
  | {
    kind: "attempt";
    attempt: StoredAnalysisAttempt;
    /** running 이 ANALYSIS_RUNNING_LIMIT_MILLISECONDS 를 넘으면 interrupted */
    status: "running" | "interrupted" | "succeeded" | "failed";
    /** 지금 열린 문제의 since 와 보낼 때의 since 가 다르다(닫혔다 다시 열린 뒤 — 옛 분석) */
    fromEarlierOpening: boolean;
  };

export type AnalysisHistoryResult = { ok: true; entries: AnalysisEntry[] } | { ok: false };

export interface IncidentAnalysisServiceOptions {
  redis: AnalysisRedisCommands;
  runAnalysis: (prompt: string, requestId: string) => Promise<AnalysisRunResult>;
  clock: () => number;
  newRequestId: () => string;
  log: (requestId: string, message: string, level: "info" | "warning" | "error") => void;
}

export interface IncidentAnalysisService {
  /** 진행 중으로 남긴 뒤 곧바로 답한다 — 실행 자리는 뒤에서 부른다. */
  start(request: AnalysisStartRequest): Promise<AnalysisStartResult>;
  /** 최근 것부터. currentSince = 지금 열린 그 문제의 since(열려 있지 않거나 모르면 undefined — 옛 분석을 가르지 않는다). */
  history(incidentId: string, currentSince?: string | null): Promise<AnalysisHistoryResult>;
  /** 이 프로세스에서 뒤에서 도는 분석의 수. */
  runningCount(): number;
  /** 뒤에서 도는 일이 모두 끝날 때까지(테스트 · 종료용). */
  whenIdle(): Promise<void>;
}

export function createIncidentAnalysisService(options: IncidentAnalysisServiceOptions): IncidentAnalysisService {
  void options;
  throw new Error("createIncidentAnalysisService: 구현 전");
}
