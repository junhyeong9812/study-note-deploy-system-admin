/** Claude 실행 자리 클라이언트(순수 — 설정 · 비밀값을 읽지 않는다. 기준 주소 · 설정용 비밀값은 부르는 쪽이 준다).
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 몸은 구현 워커가 채운다.
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
import type { ClaudeLimits, ClaudeLimitsChange } from "@/features/claude-usage/lib/claude-limits";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

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

export function createClaudeRunnerClient(_options: ClaudeRunnerClientOptions): ClaudeRunnerClient {
  throw new Error("not implemented: createClaudeRunnerClient");
}
