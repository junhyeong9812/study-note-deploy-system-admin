/** 관측 서버 클라이언트 — 로그인 시도 기록·판정. 헤더 X-Observe-Secret, 호출마다 5초 제한.
 * 장애 = 연결 실패 · 시간 초과 · 2xx 아님 · 해석 불가 본문({success:true,data:{…}} 형식이 아님).
 * 연결 실패 · 2xx 아님 · 해석 불가면 같은 본문(같은 attempt_id)으로 1회 재시도, 그래도 안 되면 { ok:false }.
 * 시간 초과는 재시도하지 않는다(세부 2 — 로그인이 최대 약 5초에 끝나게). */
import type {
  AttemptRecordBody, AttemptVerdict, FetchLike, RejectedAttemptBody, TimeoutSignalFactory,
} from "@/features/auth/lib/types";

export const OBSERVE_TIMEOUT_MILLISECONDS = 5_000;

export type ObserveFailureReason = "unreachable" | "timeout" | "bad_status" | "bad_body";

export type ObserveResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; reason: ObserveFailureReason };

export interface ObserveClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;   // 기본 AbortSignal.timeout
}

export interface ObserveClient {
  /** POST /auth/attempts → 판정. */
  recordAttempt(body: AttemptRecordBody): Promise<ObserveResult<AttemptVerdict>>;
  /** POST /auth/attempts/rejected → 기록만. */
  recordRejected(body: RejectedAttemptBody): Promise<ObserveResult<null>>;
}

const OUTCOMES = new Set(["success", "failure", "locked"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 판정 data → AttemptVerdict. 모양이 하나라도 어긋나면 null(해석 불가). */
function parseVerdict(data: unknown): AttemptVerdict | null {
  if (!isRecord(data)) return null;
  const { allowed, outcome, locked_until: lockedUntil, lock_started: lockStarted, failures } = data;
  if (typeof allowed !== "boolean") return null;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) return null;
  if (lockedUntil !== null && typeof lockedUntil !== "string") return null;
  if (typeof lockStarted !== "boolean") return null;
  if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 0) return null;
  return { allowed, outcome: outcome as AttemptVerdict["outcome"], lockedUntil, lockStarted, failures };
}

function isTimeoutError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export function createObserveClient(options: ObserveClientOptions): ObserveClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutSignal = options.timeoutSignal ?? ((milliseconds: number) => AbortSignal.timeout(milliseconds));

  /** 한 번 호출 — 봉투 {success:true,data} 를 확인하고 data 를 parse 로 넘긴다. */
  async function callOnce<Value>(path: string, body: unknown, parse: (data: unknown) => Value | undefined): Promise<ObserveResult<Value>> {
    const signal = timeoutSignal(OBSERVE_TIMEOUT_MILLISECONDS);
    let response: Response;
    try {
      response = await options.fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Observe-Secret": options.secret },
        body: JSON.stringify(body),
        signal,
        redirect: "manual",
        cache: "no-store",
      });
    } catch (error) {
      return { ok: false, reason: isTimeoutError(error, signal) ? "timeout" : "unreachable" };
    }
    if (response.status < 200 || response.status >= 300) {
      response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "bad_status" };
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(await response.text());
    } catch (error) {
      if (isTimeoutError(error, signal)) return { ok: false, reason: "timeout" };
      return { ok: false, reason: "bad_body" };
    }
    if (!isRecord(envelope) || envelope.success !== true || !("data" in envelope)) return { ok: false, reason: "bad_body" };
    const value = parse(envelope.data);
    if (value === undefined) return { ok: false, reason: "bad_body" };
    return { ok: true, value };
  }

  /** 시간 초과가 아닌 장애면 같은 본문으로 1회 재시도. */
  async function callWithRetry<Value>(path: string, body: unknown, parse: (data: unknown) => Value | undefined): Promise<ObserveResult<Value>> {
    const first = await callOnce(path, body, parse);
    if (first.ok || first.reason === "timeout") return first;
    return callOnce(path, body, parse);
  }

  return {
    recordAttempt: (body) => callWithRetry("/auth/attempts", body, (data) => parseVerdict(data) ?? undefined),
    recordRejected: (body) => callWithRetry("/auth/attempts/rejected", body, () => null),
  };
}
