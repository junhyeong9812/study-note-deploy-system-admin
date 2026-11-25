/** Claude 실행 자리 클라이언트(순수 — 설정 · 비밀값을 읽지 않는다. 기준 주소 · 설정용 비밀값은 부르는 쪽이 준다).
 *
 * 읽기 셋 — getUpstream(5초 · redirect:"manual" · no-store)과 같은 규칙, 실패는 upstream-result 의 고정 사유만(원문 · 주소 · 예외 문구 없음):
 * - readUsage(): GET <base>/usage · 머리글 X-Claude-Runner-Settings-Secret. 200 + 봉투의 data 를 ClaudeUsage 로(계약과 다른 꼴 → unparseable).
 * - readLimits(): GET <base>/limits · 같은 머리글. 200 + data 를 ClaudeLimits 로.
 * - readHealth(): GET <base>/health · 비밀 머리글 없음 · 봉투 없음. 200 이면 status "ok", 503 이면 status 가
 *   token_missing · claude_unavailable · ledger_unavailable 가운데 하나일 때 그 값(ok:true) — 그 밖의 503 은 unavailable.
 * - 2xx 가 아닌 상태는 failureForHttpStatus(401 unauthorized · 503 unavailable …). 연결 실패 unreachable · 5초 timeout.
 * - 꼴: purposes 의 용도 목록은 응답에서 온다 — isClaudePurposeList(1~8개 · 이름 ^[a-z][a-z0-9_]{0,31}$ · 중복 없음)를 벗어나면 unparseable.
 *   /usage 와 /limits 는 각자의 응답대로(서로 맞추지 않는다). 용도의 차례는 응답의 차례 그대로. 수는 0 이상의 정수.
 *   recent 의 usage 는 null 또는 네 칸(정수가 아니거나 없는 칸은 null).
 *
 * 쓰기 하나 — replaceLimits(): PUT <base>/limits 한 번(다시 보내지 않는다) · 머리글 X-Claude-Runner-Settings-Secret · Content-Type: application/json ·
 *   본문 {"enabled", "total": {"per_day","per_hour"}, "purposes": {<용도>: {…} — change.purposes 그대로}, "changed_by"} · redirect:"manual" · 기한 CLAUDE_LIMITS_PUT_TIMEOUT_MILLISECONDS(본문까지). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { isClaudePurposeList, type ClaudeLimitPair, type ClaudeLimits, type ClaudeLimitsChange } from "@/features/claude-usage/lib/claude-limits";
import { isConnectFailure } from "@/features/deploy-redeploy/lib/redeploy-accept-client";
import {
  envelopeData, getUpstream, isNonNegativeInteger, isRecord, upstreamUrl, type UpstreamResponse,
} from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, upstreamFailure, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const CLAUDE_RUNNER_SETTINGS_SECRET_HEADER = "X-Claude-Runner-Settings-Secret";
export const CLAUDE_RUNNER_USAGE_PATH = "/usage";
export const CLAUDE_RUNNER_LIMITS_PATH = "/limits";
export const CLAUDE_RUNNER_HEALTH_PATH = "/health";
/** PUT /limits 의 기한(본문까지) — 넘으면 결과를 모른다(unknown). */
export const CLAUDE_LIMITS_PUT_TIMEOUT_MILLISECONDS = 10_000;

/** 실행 자리 헬스의 상태(README "GET /health"). */
export type ClaudeRunnerHealthStatus = "ok" | "token_missing" | "claude_unavailable" | "ledger_unavailable";

export interface ClaudeRunnerHealth {
  status: ClaudeRunnerHealthStatus;
}

/** 한 범위(전체 · 용도)의 건수와 그 상한. */
export interface ClaudeUsageCount {
  today: number;
  lastHour: number;
  perDay: number;
  perHour: number;
}

/** 한 호출의 토큰 수 — 실행 자리가 알지 못한 칸은 null. */
export interface ClaudeTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export interface ClaudeRecentCall {
  startedAt: string;
  requestId: string;
  purpose: string;
  result: string;
  durationMs: number;
  usage: ClaudeTokenUsage | null;
}

export interface ClaudeUsage {
  now: string;
  dayStartedAt: string;
  enabled: boolean;
  total: ClaudeUsageCount;
  /** 용도 이름 → 건수(응답의 차례). */
  purposes: Record<string, ClaudeUsageCount>;
  /** 실행 자리가 준 차례 그대로(최근 것이 먼저). */
  recent: ClaudeRecentCall[];
}

/** PUT /limits 의 결과(원문 · 오류 detail 은 담지 않는다).
 * - replaced: 200 이고 data 가 ClaudeLimits 의 꼴 — 실행 자리가 돌려준 값
 * - rejected: 422(code 가 invalid_limits · invalid_changed_by · unknown_field · invalid_body 면 그대로, 그 밖은 unexpected) ·
 *   401(unauthorized) · 그 밖의 4xx · 3xx(unexpected)
 * - not_replaced: 연결을 맺지 못함(cause.code 가 ECONNREFUSED · ENOTFOUND · EHOSTUNREACH · ENETUNREACH · UND_ERR_CONNECT_TIMEOUT) · 5xx — 바뀌지 않았다
 * - unknown: 그 밖 — 기한 초과 · 보낸 뒤 끊김 · cause 없는 실패 · 2xx 인데 본문을 읽다 끊김 · 200 인데 꼴이 틀림. 바뀌었을 수 있다 */
export type ClaudeLimitsReplaceResult =
  | { kind: "replaced"; limits: ClaudeLimits }
  | { kind: "rejected"; code: "invalid_limits" | "invalid_changed_by" | "unknown_field" | "invalid_body" | "unauthorized" | "unexpected" }
  | { kind: "not_replaced"; status?: number }
  | { kind: "unknown" };

export interface ClaudeRunnerClientOptions {
  baseUrl: string;
  settingsSecret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface ClaudeRunnerClient {
  readUsage(): Promise<UpstreamResult<ClaudeUsage>>;
  readLimits(): Promise<UpstreamResult<ClaudeLimits>>;
  readHealth(): Promise<UpstreamResult<ClaudeRunnerHealth>>;
  replaceLimits(change: ClaudeLimitsChange, changedBy: string): Promise<ClaudeLimitsReplaceResult>;
}

type RejectedCode = Extract<ClaudeLimitsReplaceResult, { kind: "rejected" }>["code"];

/** PUT /limits 의 422 code 가운데 결과에 그대로 옮기는 것(그 밖은 unexpected). */
const KNOWN_REJECTED_CODES: readonly RejectedCode[] = ["invalid_limits", "invalid_changed_by", "unknown_field", "invalid_body"];

const HEALTH_FAILURE_STATUSES: readonly ClaudeRunnerHealthStatus[] = ["token_missing", "claude_unavailable", "ledger_unavailable"];

function defaultTimeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

// ---- 꼴 읽기 — 계약과 다르면 null(호출하는 쪽이 unparseable · unknown 으로) ----

/** 용도 이름 → 값의 표. 이름의 목록이 isClaudePurposeList 를 벗어나거나 값 하나라도 읽지 못하면 null. 차례는 응답의 차례. */
function purposeTable<Value>(value: unknown, readEach: (each: unknown) => Value | null): Record<string, Value> | null {
  if (!isRecord(value) || !isClaudePurposeList(Object.keys(value))) return null;
  const table: Record<string, Value> = {};
  for (const [name, each] of Object.entries(value)) {
    const read = readEach(each);
    if (read === null) return null;
    table[name] = read;
  }
  return table;
}

function limitPairOf(value: unknown): ClaudeLimitPair | null {
  if (!isRecord(value) || !isNonNegativeInteger(value.per_day) || !isNonNegativeInteger(value.per_hour)) return null;
  return { perDay: value.per_day, perHour: value.per_hour };
}

function usageCountOf(value: unknown): ClaudeUsageCount | null {
  const pair = limitPairOf(value);
  if (pair === null || !isRecord(value) || !isNonNegativeInteger(value.today) || !isNonNegativeInteger(value.last_hour)) return null;
  return { today: value.today, lastHour: value.last_hour, ...pair };
}

function integerOrNull(value: unknown): number | null {
  return isNonNegativeInteger(value) ? value : null;
}

/** 한 호출의 토큰 수 — 네 칸 가운데 정수가 아니거나 없는 칸은 null(0 으로 메우지 않는다). 칸 묶음이 아니면 null. */
function tokenUsageOf(value: unknown): ClaudeTokenUsage | null {
  if (!isRecord(value)) return null;
  return {
    inputTokens: integerOrNull(value.input_tokens), outputTokens: integerOrNull(value.output_tokens),
    cacheCreationInputTokens: integerOrNull(value.cache_creation_input_tokens), cacheReadInputTokens: integerOrNull(value.cache_read_input_tokens),
  };
}

function recentCallOf(value: unknown): ClaudeRecentCall | null {
  if (!isRecord(value)) return null;
  const { started_at: startedAt, request_id: requestId, purpose, result, duration_ms: durationMs } = value;
  if (typeof startedAt !== "string" || typeof requestId !== "string" || typeof purpose !== "string" || typeof result !== "string"
    || !isNonNegativeInteger(durationMs)) return null;
  return { startedAt, requestId, purpose, result, durationMs, usage: tokenUsageOf(value.usage) };
}

function usageOf(data: Record<string, unknown>): ClaudeUsage | null {
  if (typeof data.now !== "string" || typeof data.day_started_at !== "string" || typeof data.enabled !== "boolean" || !Array.isArray(data.recent)) return null;
  const total = usageCountOf(data.total);
  const purposes = purposeTable(data.purposes, usageCountOf);
  const recent = data.recent.map(recentCallOf);
  if (total === null || purposes === null || recent.some((call) => call === null)) return null;
  return { now: data.now, dayStartedAt: data.day_started_at, enabled: data.enabled, total, purposes, recent: recent as ClaudeRecentCall[] };
}

function limitsOf(data: Record<string, unknown> | undefined): ClaudeLimits | null {
  if (data === undefined || typeof data.enabled !== "boolean") return null;
  const total = limitPairOf(data.total);
  const purposes = purposeTable(data.purposes, limitPairOf);
  const changedAt = data.changed_at;
  const changedBy = data.changed_by;
  if (total === null || purposes === null || (changedAt !== null && typeof changedAt !== "string") || (changedBy !== null && typeof changedBy !== "string")) return null;
  return { enabled: data.enabled, total, purposes, changedAt, changedBy };
}

/** 200 + 봉투의 data 를 parse 로 — 2xx 가 아니면 상태의 실패, 꼴이 틀리면 unparseable. */
function enveloped<Value>(response: UpstreamResponse | UpstreamFailure, parse: (data: Record<string, unknown>) => Value | null): UpstreamResult<Value> {
  if (!response.ok) return response;
  if (response.status !== 200) return failureForHttpStatus(response.status);
  const data = envelopeData(response);
  const value = data === undefined ? null : parse(data);
  return value === null ? upstreamFailure("unparseable") : { ok: true, value };
}

function healthOf(response: UpstreamResponse | UpstreamFailure): UpstreamResult<ClaudeRunnerHealth> {
  if (!response.ok) return response;
  const status = response.parsed && isRecord(response.json) ? response.json.status : undefined;
  if (response.status === 200) return status === "ok" ? { ok: true, value: { status: "ok" } } : upstreamFailure("unparseable");
  if (response.status === 503 && (HEALTH_FAILURE_STATUSES as readonly unknown[]).includes(status)) {
    return { ok: true, value: { status: status as ClaudeRunnerHealthStatus } };
  }
  return failureForHttpStatus(response.status);
}

function errorCodeOf(json: unknown): string | null {
  if (!isRecord(json) || !isRecord(json.error)) return null;
  return typeof json.error.code === "string" ? json.error.code : null;
}

function replaceResultFor(status: number, json: unknown): ClaudeLimitsReplaceResult {
  if (status === 200) {
    const limits = limitsOf(isRecord(json) && json.success === true && isRecord(json.data) ? json.data : undefined);
    return limits === null ? { kind: "unknown" } : { kind: "replaced", limits };
  }
  if (status >= 200 && status < 300) return { kind: "unknown" };
  // 5xx 를 "바뀌지 않음"으로 두는 것은 어드민과 실행 자리 사이에 프록시가 없다는 전제다(5xx 는 실행 자리 자신의 답 — 바꾸기 전에 거절한다).
  if (status >= 500) return { kind: "not_replaced", status };
  if (status === 401) return { kind: "rejected", code: "unauthorized" };
  const code = errorCodeOf(json);
  if (status === 422 && code !== null && (KNOWN_REJECTED_CODES as readonly string[]).includes(code)) return { kind: "rejected", code: code as RejectedCode };
  return { kind: "rejected", code: "unexpected" };   // 그 밖의 4xx · 3xx
}

export function createClaudeRunnerClient(options: ClaudeRunnerClientOptions): ClaudeRunnerClient {
  const settingsHeaders = { [CLAUDE_RUNNER_SETTINGS_SECRET_HEADER]: options.settingsSecret };
  const read = (path: string, headers: Record<string, string>) =>
    getUpstream(upstreamUrl(options.baseUrl, path), { fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers });
  return {
    async readUsage() {
      return enveloped(await read(CLAUDE_RUNNER_USAGE_PATH, settingsHeaders), usageOf);
    },
    async readLimits() {
      return enveloped(await read(CLAUDE_RUNNER_LIMITS_PATH, settingsHeaders), limitsOf);
    },
    async readHealth() {
      return healthOf(await read(CLAUDE_RUNNER_HEALTH_PATH, {}));
    },
    async replaceLimits(change, changedBy) {
      const signal = (options.timeoutSignal ?? defaultTimeoutSignal)(CLAUDE_LIMITS_PUT_TIMEOUT_MILLISECONDS);
      const pairOf = (pair: ClaudeLimitPair) => ({ per_day: pair.perDay, per_hour: pair.perHour });
      const body = JSON.stringify({
        enabled: change.enabled, total: pairOf(change.total),
        purposes: Object.fromEntries(Object.entries(change.purposes).map(([name, pair]) => [name, pairOf(pair)])), changed_by: changedBy,
      });
      let response: Response;
      try {
        response = await options.fetch(upstreamUrl(options.baseUrl, CLAUDE_RUNNER_LIMITS_PATH), {
          method: "PUT",
          headers: { Accept: "application/json", "Content-Type": "application/json", ...settingsHeaders },
          body,
          signal,
          redirect: "manual",
          cache: "no-store",
        });
      } catch (error) {
        return isConnectFailure(error, signal) ? { kind: "not_replaced" } : { kind: "unknown" };
      }
      let json: unknown = null;
      try {
        const text = await response.text();
        try { json = JSON.parse(text) as unknown; } catch { json = null; }
      } catch {
        // 상태는 받았다. 2xx 는 본문이 있어야 바뀐 값을 알 수 있어 모름, 그 밖은 상태로 이미 가른다
        if (response.status >= 200 && response.status < 300) return { kind: "unknown" };
      }
      return replaceResultFor(response.status, json);
    },
  };
}
