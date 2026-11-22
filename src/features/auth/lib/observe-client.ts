/** 관측 서버 클라이언트 — 로그인 시도 기록·판정. 헤더 X-Observe-Secret, 호출마다 5초 제한.
 * 장애 = 연결 실패 · 시간 초과 · 2xx 아님 · 해석 불가 본문({success:true,data:{…}} 형식이 아님).
 * 장애면 같은 본문(같은 attempt_id)으로 1회 재시도, 그래도 안 되면 { ok:false }. */
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

export function createObserveClient(options: ObserveClientOptions): ObserveClient {
  throw new Error("not implemented");
}
