/** 분석의 시작 · 진행 중 · 결과의 저장(Redis — 어드민이 이미 쓰는 것. 명세 ⑫ §19 · §20). 순수 — Redis · 실행 자리 · 시계 · 요청 ID · 로그는 주입한다.
 * - start: 잠금 SET NX PX 5분(값 = 요청 ID — 읽고 나서 쓰지 않는다: 두 탭 · 두 자리(blue/green)에서도 원자적으로 한 번) → 시도 기록(running · 보낸 글 그대로 · 30일)
 *   → 목록의 앞에 요청 ID(최근 5건 · 밀려난 시도의 키는 지운다 · 30일) → 곧바로 started. 실행 자리는 뒤에서 부른다(이 프로세스가 붙잡는다 — whenIdle).
 *   잠금이 있으면 부르지 않고 already_running. Redis 에 닿지 못하면(잠금 · 기록 · 목록 가운데 하나라도) 부르지 않고 store_unavailable — 결과를 잃을 호출을 하지 않는다.
 * - 끝: 시도 기록을 succeeded(다섯 칸) · failed(까닭)로 바꾸고 걸린 시간을 적은 뒤 잠금을 푼다(자기 것일 때만). 기록을 쓰지 못하면 로그 result_not_stored —
 *   기록은 running 으로 남아 5분 뒤 interrupted 로 보인다.
 * - history: 최근 것부터 · running 이 5분을 넘으면 interrupted · 읽을 수 없는 기록은 unreadable · 보낼 때의 since 와 지금의 since 가 다르면 fromEarlierOpening.
 * - 로그: `incident-analysis:<결과> key=value…` 한 줄 — 보낸 글 · 답의 내용은 싣지 않는다(시도 기록에만 있다).
 * 계약: incident-analysis-service.test.ts 머리 주석. */
import { parseAnalysisAnswer, type AnalysisAnswer } from "@/features/incident-analysis/lib/analysis-answer";
import { ANALYSIS_RUN_FAILURE_REASONS } from "@/features/incident-analysis/lib/analysis-runner-client";
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
  const prefix = `incident-analysis:v1:${Buffer.from(incidentId, "utf8").toString("base64url")}`;
  return { lock: `${prefix}:lock`, history: `${prefix}:history`, attempt: (requestId) => `${prefix}:attempt:${requestId}` };
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

const ATTEMPT_STATES: readonly StoredAnalysisAttempt["state"][] = ["running", "succeeded", "failed"];
const FAILURE_REASONS: readonly string[] = [...ANALYSIS_RUN_FAILURE_REASONS, "result_not_stored"];

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** 저장된 다섯 칸 — 실행 자리의 답과 같은 검증(parseAnalysisAnswer)을 다시 거친다. */
function storedAnswerOf(value: unknown): AnalysisAnswer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { recommendedAction, ...rest } = value as Record<string, unknown>;
  return parseAnalysisAnswer({ ...rest, recommended_action: recommendedAction });
}

/** 시도 기록(JSON)을 읽는다 — 꼴이 하나라도 틀리면 null(unreadable). */
function attemptOf(raw: string): StoredAnalysisAttempt | null {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const attempt = value as Record<string, unknown>;
  const { requestId, incidentId, incidentSince, account, startedAt, prompt, promptBytes, state, finishedAt, durationMilliseconds, failureReason } = attempt;
  if (attempt.version !== 1 || typeof requestId !== "string" || typeof incidentId !== "string" || !isNullableString(incidentSince)
    || typeof account !== "string" || typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt)) || typeof prompt !== "string"
    || typeof promptBytes !== "number" || !(ATTEMPT_STATES as readonly unknown[]).includes(state) || !isNullableString(finishedAt)
    || !(durationMilliseconds === null || (typeof durationMilliseconds === "number" && durationMilliseconds >= 0))) return null;
  const answer = attempt.answer === null ? null : storedAnswerOf(attempt.answer);
  if (attempt.answer !== null && answer === null) return null;
  if (!(failureReason === null || (typeof failureReason === "string" && FAILURE_REASONS.includes(failureReason)))) return null;
  // 상태와 칸이 어긋나면 읽지 않는다(성공인데 답이 없음 · 실패인데 까닭이 없음)
  if ((state === "succeeded") !== (answer !== null) || (state === "failed") !== (failureReason !== null)) return null;
  return {
    version: 1, requestId, incidentId, incidentSince, account, startedAt, prompt, promptBytes, state: state as StoredAnalysisAttempt["state"],
    finishedAt, durationMilliseconds, answer, failureReason: failureReason as AnalysisFailureReason | null,
  };
}

export function createIncidentAnalysisService(options: IncidentAnalysisServiceOptions): IncidentAnalysisService {
  const { redis, clock, log } = options;
  const running = new Set<Promise<void>>();

  const writeAttempt = (incidentId: string, attempt: StoredAnalysisAttempt) =>
    redis.set(incidentAnalysisKeys(incidentId).attempt(attempt.requestId), JSON.stringify(attempt), "PX", ANALYSIS_RETENTION_MILLISECONDS);

  /** 잠금이 이 요청의 것일 때만 푼다. 단순화: 읽고 지우는 두 명령이다(원자적이 아님) — 그 사이에 잠금이 5분 수명으로 사라지고 다른 요청이 잡으면 그것을 지운다.
   * 분석은 260초 기한이라 잠금(5분)보다 먼저 끝난다. 고칠 때: 비교 후 지우기를 한 명령(Lua)으로. */
  const releaseLock = async (incidentId: string, requestId: string) => {
    const { lock } = incidentAnalysisKeys(incidentId);
    if (await redis.get(lock) === requestId) await redis.del(lock);
  };

  /** 뒤에서 부르고 결과를 남긴다 — 거부하지 않는다. */
  const runInBackground = async (attempt: StoredAnalysisAttempt, startedAtMilliseconds: number) => {
    const bytes = attempt.promptBytes;
    const result = await options.runAnalysis(attempt.prompt, attempt.requestId).catch((): { kind: "failed"; reason: "no_answer" } => ({ kind: "failed", reason: "no_answer" }));
    const finishedAtMilliseconds = clock();
    const durationMilliseconds = Math.max(0, finishedAtMilliseconds - startedAtMilliseconds);
    const finished: StoredAnalysisAttempt = {
      ...attempt, state: result.kind === "answered" ? "succeeded" : "failed", finishedAt: new Date(finishedAtMilliseconds).toISOString(), durationMilliseconds,
      answer: result.kind === "answered" ? result.answer : null, failureReason: result.kind === "answered" ? null : result.reason,
    };
    try {
      await writeAttempt(attempt.incidentId, finished);
    } catch {
      log(attempt.requestId, `incident-analysis:result_not_stored incident=${attempt.incidentId}`, "error");
      return;
    }
    if (result.kind === "answered") {
      log(attempt.requestId, `incident-analysis:succeeded incident=${attempt.incidentId} duration_ms=${durationMilliseconds} bytes=${bytes}`, "info");
    } else {
      log(attempt.requestId, `incident-analysis:failed reason=${result.reason} incident=${attempt.incidentId} duration_ms=${durationMilliseconds} bytes=${bytes}`, "warning");
    }
    try {
      await releaseLock(attempt.incidentId, attempt.requestId);
    } catch {
      // 풀지 못해도 잠금은 5분 수명으로 사라진다
    }
  };

  return {
    async start(request) {
      const keys = incidentAnalysisKeys(request.incidentId);
      const requestId = options.newRequestId();
      const startedAtMilliseconds = clock();
      let acquired: "OK" | null;
      try {
        acquired = await redis.set(keys.lock, requestId, "PX", ANALYSIS_RUNNING_LIMIT_MILLISECONDS, "NX");
      } catch {
        log(requestId, `incident-analysis:store_unavailable incident=${request.incidentId}`, "error");
        return { kind: "store_unavailable" };
      }
      if (acquired !== "OK") {
        const holder = await redis.get(keys.lock).catch(() => null);
        log(requestId, `incident-analysis:already_running incident=${request.incidentId}`, "info");
        return { kind: "already_running", requestId: holder };
      }
      const attempt: StoredAnalysisAttempt = {
        version: 1, requestId, incidentId: request.incidentId, incidentSince: request.incidentSince, account: request.account,
        startedAt: new Date(startedAtMilliseconds).toISOString(), prompt: request.prompt, promptBytes: utf8Bytes(request.prompt),
        state: "running", finishedAt: null, durationMilliseconds: null, answer: null, failureReason: null,
      };
      try {
        await writeAttempt(request.incidentId, attempt);
        await redis.lpush(keys.history, requestId);
        const evicted = await redis.lrange(keys.history, ANALYSIS_HISTORY_LIMIT, -1);
        if (evicted.length > 0) await redis.del(...evicted.map((evictedId) => keys.attempt(evictedId)));
        await redis.ltrim(keys.history, 0, ANALYSIS_HISTORY_LIMIT - 1);
        await redis.pexpire(keys.history, ANALYSIS_RETENTION_MILLISECONDS);
      } catch {
        log(requestId, `incident-analysis:store_unavailable incident=${request.incidentId}`, "error");
        await releaseLock(request.incidentId, requestId).catch(() => undefined);
        return { kind: "store_unavailable" };
      }
      log(requestId, `incident-analysis:started incident=${request.incidentId} bytes=${attempt.promptBytes}`, "info");
      const work = runInBackground(attempt, startedAtMilliseconds);
      running.add(work);
      void work.finally(() => running.delete(work));
      return { kind: "started", requestId };
    },

    async history(incidentId, currentSince) {
      const keys = incidentAnalysisKeys(incidentId);
      let raws: (string | null)[];
      try {
        const requestIds = await redis.lrange(keys.history, 0, ANALYSIS_HISTORY_LIMIT - 1);
        raws = await Promise.all(requestIds.map((requestId) => redis.get(keys.attempt(requestId))));
      } catch {
        return { ok: false };
      }
      const now = clock();
      const entries: AnalysisEntry[] = [];
      for (const raw of raws) {
        if (raw === null) continue;   // 시도 기록만 먼저 사라졌다(수명) — 보일 것이 없다
        const attempt = attemptOf(raw);
        if (attempt === null) {
          entries.push({ kind: "unreadable" });
          continue;
        }
        const interrupted = attempt.state === "running" && now - Date.parse(attempt.startedAt) >= ANALYSIS_RUNNING_LIMIT_MILLISECONDS;
        entries.push({
          kind: "attempt", attempt, status: interrupted ? "interrupted" : attempt.state,
          fromEarlierOpening: currentSince !== undefined && attempt.incidentSince !== currentSince,
        });
      }
      return { ok: true, entries };
    },

    runningCount() {
      return running.size;
    },

    async whenIdle() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}
