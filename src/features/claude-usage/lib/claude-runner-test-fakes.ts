/** 테스트 전용 — 가짜 Claude 실행 자리(study-note-deploy-system-claude 의 runner/server.py · usage_ledger.py 계약 그대로).
 * 주소는 문서용 도메인(.test), 비밀값은 명백한 가짜. 받은 요청을 남기고, 경로마다 override 로 답을 바꿔 끼운다.
 * - GET /usage · GET /limits · PUT /limits: 머리글 X-Claude-Runner-Settings-Secret 이 맞아야 한다(아니면 401 unauthorized).
 * - PUT /limits: 실행 자리의 검증(칸 넷 · 정수 0~1000 · purposes 는 정확히 용도 목록 · changed_by 는 앞뒤 공백을 뺀 1~200자의 인쇄 가능한 글)을
 *   그대로 하고, 받으면 상태를 바꾼 뒤 새 값(changed_at · changed_by 포함)을 돌려준다.
 * - GET /health: 봉투 없음 · 인증 없음. healthStatus 가 ok 면 200, 아니면 503. */
import { vi } from "vitest";
import { FORBIDDEN_IN_RESULTS, UPSTREAM_RAW_MARKER, jsonBody, type RoutedFetchHandler } from "@/shared/lib/upstream-test-fakes";

export const FAKE_CLAUDE_RUNNER_URL = "http://claude-runner.example.test:15200";
export const FAKE_CLAUDE_RUNNER_SETTINGS_SECRET = "fake-claude-settings-secret-marker-c74";
export const CLAUDE_SETTINGS_HEADER = "x-claude-runner-settings-secret";

/** 결과 · 화면 · 로그 어디에도 나오면 안 되는 글자(기존 목록 + 실행 자리의 주소 · 비밀값 · 머리글 이름). */
export const CLAUDE_FORBIDDEN_IN_RESULTS: readonly string[] = [
  ...FORBIDDEN_IN_RESULTS,
  FAKE_CLAUDE_RUNNER_SETTINGS_SECRET, "claude-runner.example.test", "X-Claude-Runner-Settings-Secret", CLAUDE_SETTINGS_HEADER, UPSTREAM_RAW_MARKER,
];

export interface RunnerPair { per_day: number; per_hour: number }
export interface RunnerLimits {
  enabled: boolean;
  total: RunnerPair;
  purposes: Record<string, RunnerPair>;
  changed_at: string | null;
  changed_by: string | null;
}

export function defaultRunnerLimits(overrides: Partial<RunnerLimits> = {}): RunnerLimits {
  return {
    enabled: true, total: { per_day: 30, per_hour: 10 }, purposes: { chat: { per_day: 30, per_hour: 10 } },
    changed_at: null, changed_by: null, ...overrides,
  };
}

/** 용도 둘(chat · analysis)의 실행 자리로 바꾼다 — 상한 · 건수 · 용도 표를 함께. analysis 는 어드민의 이름 표에 없는 이름이다. */
export function useTwoPurposes(runner: FakeClaudeRunner, pairs: { chat?: RunnerPair; analysis?: RunnerPair } = {}): void {
  runner.purposeNames = ["chat", "analysis"];
  runner.limits = defaultRunnerLimits({ purposes: { chat: pairs.chat ?? { per_day: 30, per_hour: 10 }, analysis: pairs.analysis ?? { per_day: 6, per_hour: 2 } } });
  runner.counts = { total: { today: 5, last_hour: 2 }, purposes: { chat: { today: 3, last_hour: 1 }, analysis: { today: 2, last_hour: 1 } } };
}

export interface RunnerCounts { today: number; last_hour: number }

export function runnerCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    started_at: "2026-11-26T13:05:00+09:00", request_id: "req-123", purpose: "chat", result: "succeeded", duration_ms: 8123,
    usage: { input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }, ...overrides,
  };
}

/** GET /usage 의 data — 지금 상한(limits)과 건수(counts)에서 만든다. */
export function runnerUsageData(limits: RunnerLimits, counts: { total: RunnerCounts; purposes: Record<string, RunnerCounts> }, recent: Record<string, unknown>[]) {
  return {
    now: "2026-11-26T13:10:00+09:00", day_started_at: "2026-11-26T00:00:00+09:00", enabled: limits.enabled,
    total: { ...counts.total, ...limits.total },
    purposes: Object.fromEntries(Object.entries(limits.purposes).map(([name, pair]) => [name, { ...(counts.purposes[name] ?? { today: 0, last_hour: 0 }), ...pair }])),
    recent,
  };
}

const LIMIT_FIELDS = new Set(["enabled", "total", "purposes", "changed_by"]);

function failure(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return jsonBody({ success: false, error: { code, ...extra } }, status);
}

function isPair(value: unknown): value is RunnerPair {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("per_day") || !keys.includes("per_hour")) return false;
  return Object.values(value).every((number) => typeof number === "number" && Number.isInteger(number) && number >= 0 && number <= 1000);
}

/** 실행 자리 read_limits_document 와 같은 검증 — 받으면 null, 아니면 거절 응답. */
function rejectionOf(document: unknown, purposeNames: readonly string[]): Response | null {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return failure(422, "invalid_body");
  const record = document as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !LIMIT_FIELDS.has(key)).sort();
  if (unknown.length > 0) return failure(422, "unknown_field", { detail: unknown[0] });
  if (typeof record.enabled !== "boolean") return failure(422, "invalid_limits");
  if (!isPair(record.total)) return failure(422, "invalid_limits");
  const purposes = record.purposes;
  if (typeof purposes !== "object" || purposes === null || Array.isArray(purposes)) return failure(422, "invalid_limits");
  const names = Object.keys(purposes).sort();
  if (names.join(",") !== [...purposeNames].sort().join(",")) return failure(422, "invalid_limits");
  if (!names.every((name) => isPair((purposes as Record<string, unknown>)[name]))) return failure(422, "invalid_limits");
  if (typeof record.changed_by !== "string") return failure(422, "invalid_changed_by");
  const changedBy = record.changed_by.trim();
  // eslint-disable-next-line no-control-regex
  if (changedBy.length === 0 || changedBy.length > 200 || /[\x00-\x1f\x7f]/.test(changedBy)) return failure(422, "invalid_changed_by");
  return null;
}

export interface FakeClaudeRunner {
  fetch: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;
  limits: RunnerLimits;
  /** 실행 자리의 용도 표 — PUT /limits 의 purposes 가 정확히 이 이름들이어야 받는다(기본 ["chat"]). */
  purposeNames: string[];
  counts: { total: RunnerCounts; purposes: Record<string, RunnerCounts> };
  recent: Record<string, unknown>[];
  healthStatus: "ok" | "token_missing" | "claude_unavailable" | "ledger_unavailable";
  /** 값을 쓴 뒤(상태를 바꾼 뒤) 이 상태로 실패를 답한다 — 실제 실행 자리의 replace_limits 가 커밋 뒤 다시 읽기에 실패할 때의 503 limits_unavailable(명세 §15). null 이면 정상. */
  failAfterWrite: number | null;
  /** "METHOD /path" → 답(정상 처리 대신). */
  override: Partial<Record<"GET /usage" | "GET /limits" | "PUT /limits" | "GET /health", RoutedFetchHandler>>;
  /** 받은 요청 — 메서드 · 경로 · 머리글 · 본문(JSON 이면 해석한 값). */
  requests: { method: string; path: string; url: URL; headers: Headers; body: unknown }[];
  calls: (method: string, path: string) => FakeClaudeRunner["requests"];
}

export function createFakeClaudeRunner(): FakeClaudeRunner {
  const runner: FakeClaudeRunner = {
    fetch: vi.fn(),
    limits: defaultRunnerLimits(),
    purposeNames: ["chat"],
    counts: { total: { today: 3, last_hour: 1 }, purposes: { chat: { today: 3, last_hour: 1 } } },
    recent: [runnerCall()],
    healthStatus: "ok",
    failAfterWrite: null,
    override: {},
    requests: [],
    calls: (method, path) => runner.requests.filter((request) => request.method === method && request.path === path),
  };
  runner.fetch.mockImplementation(async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? {});
    let body: unknown = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    runner.requests.push({ method, path: url.pathname, url, headers, body });
    const key = `${method} ${url.pathname}` as keyof FakeClaudeRunner["override"];
    const override = runner.override[key];
    if (override !== undefined) return override(url, init);
    if (key === "GET /health") {
      const status = runner.healthStatus;
      return jsonBody({ status, ledger_readable: status !== "ledger_unavailable", ledger_writable: status !== "ledger_unavailable",
        claude_available: status !== "claude_unavailable", token_configured: status !== "token_missing", running: false, enabled: runner.limits.enabled }, status === "ok" ? 200 : 503);
    }
    if (key !== "GET /usage" && key !== "GET /limits" && key !== "PUT /limits") return failure(404, "not_found");
    if (headers.get(CLAUDE_SETTINGS_HEADER) !== FAKE_CLAUDE_RUNNER_SETTINGS_SECRET) return failure(401, "unauthorized");
    if (key === "GET /usage") return jsonBody({ success: true, data: runnerUsageData(runner.limits, runner.counts, runner.recent) });
    if (key === "GET /limits") return jsonBody({ success: true, data: structuredClone(runner.limits) });
    const rejection = rejectionOf(body, runner.purposeNames);
    if (rejection !== null) return rejection;
    const document = body as { enabled: boolean; total: RunnerPair; purposes: Record<string, RunnerPair>; changed_by: string };
    runner.limits = {
      enabled: document.enabled, total: { per_day: document.total.per_day, per_hour: document.total.per_hour },
      purposes: Object.fromEntries(Object.entries(document.purposes).map(([name, pair]) => [name, { per_day: pair.per_day, per_hour: pair.per_hour }])),
      changed_at: "2026-11-26T13:11:00+09:00", changed_by: document.changed_by.trim(),
    };
    if (runner.failAfterWrite !== null) return failure(runner.failAfterWrite, "limits_unavailable");
    return jsonBody({ success: true, data: structuredClone(runner.limits) });
  });
  return runner;
}
