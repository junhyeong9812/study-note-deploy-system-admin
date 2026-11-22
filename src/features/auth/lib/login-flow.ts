/** 로그인 흐름 조립 — Route Handler(POST /api/auth/login)가 부른다.
 * 순서: Origin 검사 → 속도 제한(초과면 비밀번호 검증 없이 rate_limited, IP 마다 창당 첫 1건만 rejected 기록)
 *   → 자격 검증 → 관측 서버 판정(성공 = 자격이 맞고 allowed:true)
 *   → lock_started:true 면 알림 1건(실패해도 결과 불변, 앱 로그 1줄)
 *   → 관측 서버 장애면 임시 제한으로 판정 + 대기열에 기록 + temporaryRestriction:true.
 * 관측 서버 호출이 성공하면 대기열을 replayed:true 로 비운다.
 * 대기열이 넘쳐 버린 항목이 생기면 앱 로그(warning)에 `dropped=<누적 건수>` 를 남긴다. */
import type { AlertClient } from "@/features/auth/lib/alert-client";
import type { AttemptQueue, QueuedRecord } from "@/features/auth/lib/attempt-queue";
import { verifyCredentials, type AccountConfig } from "@/features/auth/lib/credentials";
import type { ObserveClient } from "@/features/auth/lib/observe-client";
import { isAllowedOrigin } from "@/features/auth/lib/origin";
import type { RateLimiter } from "@/features/auth/lib/rate-limit";
import { issueSessionToken } from "@/features/auth/lib/session";
import type { TemporaryLockout } from "@/features/auth/lib/temporary-lockout";
import type { AppLogger, AttemptRecordBody, AttemptVerdict, Clock, PasswordVerifier } from "@/features/auth/lib/types";

export const USER_AGENT_MAX_LENGTH = 200;

export interface LoginInput {
  id: string;
  password: string;
  ip: string;
  userAgent: string;
  origin: string | null;
  /** 앱 로그의 requestId — 없으면 이 시도의 attempt_id 를 쓴다. */
  requestId?: string;
}

export type LoginResult =
  | { kind: "success"; sessionToken: string; temporaryRestriction: boolean }
  | { kind: "failure"; temporaryRestriction: boolean }      // ID 틀림 · 비밀번호 틀림 구별 없음
  | { kind: "locked"; temporaryRestriction: boolean }
  | { kind: "rate_limited" }                                 // HTTP 429
  | { kind: "origin_rejected" };                             // HTTP 403

export interface LoginFlowDependencies {
  clock: Clock;
  newAttemptId: () => string;               // UUID
  account: AccountConfig;
  verifyPassword: PasswordVerifier;
  sessionSigningKey: string;
  configuredOrigin: string;                 // ADMIN_ORIGIN
  rateLimiter: RateLimiter;
  temporaryLockout: TemporaryLockout;
  attemptQueue: AttemptQueue;
  observeClient: ObserveClient;
  alertClient: AlertClient;
  logger: AppLogger;
}

export interface LoginFlow {
  login(input: LoginInput): Promise<LoginResult>;
  /** login 이 시작한 대기열 재전송(있으면)이 끝날 때까지 기다린다. 재전송을 login 안에서 기다리는 구현이면 바로 끝난다. */
  waitForReplay(): Promise<void>;
}

export function createLoginFlow(dependencies: LoginFlowDependencies): LoginFlow {
  const {
    clock, newAttemptId, account, verifyPassword, sessionSigningKey, configuredOrigin,
    rateLimiter, temporaryLockout, attemptQueue, observeClient, alertClient,
  } = dependencies;
  let replayInFlight: Promise<void> | null = null;
  let unrecordedRateLimited = 0;   // 관측 서버에 남기지 않은(창당 첫 1건이 아닌) 속도 제한 거절의 누적 건수

  /** 로그는 요청을 막지 않는다 — 로거의 실패·예외를 흡수한다. */
  const log = (requestId: string, message: string, level: "info" | "warning" | "error" = "info") => {
    try {
      const pending = dependencies.logger(requestId, message, level);
      if (pending && typeof pending.catch === "function") pending.catch(() => undefined);
    } catch {
      // 무해
    }
  };

  /** 대기열에 넣고, 넘쳐 버렸으면 누적 건수를 남긴다(조용히 버리지 않는다). */
  const enqueueRecord = (requestId: string, record: QueuedRecord) => {
    if (!attemptQueue.enqueue(record)) {
      log(requestId, `login:queue_overflow dropped=${attemptQueue.droppedCount()} queued=${attemptQueue.size()}`, "warning");
    }
  };

  /** 관측 서버가 응답했으면 쌓인 기록을 재전송한다(한 번에 하나만 돈다). 현재 로그인 판정과는 무관. */
  const startReplay = (requestId: string) => {
    if (replayInFlight !== null || attemptQueue.size() === 0) return;
    replayInFlight = (async () => {
      try {
        const result = await attemptQueue.flush(async (record) => {
          if (record.kind === "attempt") return (await observeClient.recordAttempt({ ...record.body, replayed: true })).ok;
          return (await observeClient.recordRejected(record.body)).ok;
        });
        log(requestId, `login:queue_replay sent=${result.sent} remaining=${result.remaining} dropped=${attemptQueue.droppedCount()}`,
          result.remaining > 0 ? "warning" : "info");
      } catch {
        log(requestId, "login:queue_replay failed", "warning");
      } finally {
        replayInFlight = null;
      }
    })();
  };

  const sendLockAlert = async (requestId: string, lockedUntil: string, temporaryRestriction: boolean) => {
    let delivered = false;
    try {
      delivered = await alertClient.sendLoginLocked(lockedUntil);
    } catch {
      delivered = false;
    }
    if (!delivered) log(requestId, `login:lock_alert_failed temporary=${temporaryRestriction}`, "warning");
  };

  return {
    async login(input) {
      if (!isAllowedOrigin(input.origin, configuredOrigin)) return { kind: "origin_rejected" };

      const attemptId = newAttemptId();
      const requestId = input.requestId ?? attemptId;
      const at = new Date(clock()).toISOString();
      const userAgent = input.userAgent.slice(0, USER_AGENT_MAX_LENGTH);

      const rateDecision = rateLimiter.hit(input.ip);
      if (!rateDecision.allowed) {
        if (rateDecision.firstRejectionInWindow) {
          const body = { attempt_id: attemptId, at, reason: "rate_limited" as const, ip: input.ip, user_agent: userAgent };
          const recorded = await observeClient.recordRejected(body);
          if (recorded.ok) {
            log(requestId, "login:rate_limited recorded=true");
            startReplay(requestId);
          } else {
            log(requestId, `login:rate_limited recorded=false observe=${recorded.reason} queued=true`, "warning");
            enqueueRecord(requestId, { kind: "rejected", body });
          }
        } else {
          unrecordedRateLimited += 1;
          log(requestId, `login:rate_limited recorded=false unrecorded_total=${unrecordedRateLimited}`);
        }
        return { kind: "rate_limited" };
      }

      const credentialOk = await verifyCredentials({ id: input.id, password: input.password }, account, verifyPassword);
      const body: AttemptRecordBody = {
        attempt_id: attemptId, at, credential_ok: credentialOk, ip: input.ip, user_agent: userAgent, replayed: false,
      };

      let verdict: AttemptVerdict;
      let temporaryRestriction: boolean;
      const observed = await observeClient.recordAttempt(body);
      if (observed.ok) {
        verdict = observed.value;
        temporaryRestriction = false;
        startReplay(requestId);
      } else {
        verdict = temporaryLockout.decide(credentialOk);
        temporaryRestriction = true;
        log(requestId, `login:temporary_restriction observe=${observed.reason} outcome=${verdict.outcome} failures=${verdict.failures}`, "warning");
        enqueueRecord(requestId, { kind: "attempt", body });
      }

      if (verdict.lockStarted && verdict.lockedUntil !== null) {
        log(requestId, `login:lock_started until=${verdict.lockedUntil} temporary=${temporaryRestriction}`, "warning");
        await sendLockAlert(requestId, verdict.lockedUntil, temporaryRestriction);
      }

      if (credentialOk && verdict.allowed) {
        log(requestId, `login:success temporary=${temporaryRestriction}`);
        return { kind: "success", sessionToken: issueSessionToken(sessionSigningKey, clock()), temporaryRestriction };
      }
      if (verdict.outcome === "locked") {
        log(requestId, `login:locked temporary=${temporaryRestriction}`);
        return { kind: "locked", temporaryRestriction };
      }
      log(requestId, `login:failure failures=${verdict.failures} temporary=${temporaryRestriction}`);
      return { kind: "failure", temporaryRestriction };
    },
    async waitForReplay() {
      while (replayInFlight !== null) await replayInFlight;
    },
  };
}

/** 결과 → HTTP 상태: success 200 · failure 401 · locked 423 · rate_limited 429 · origin_rejected 403. */
export function loginResultStatus(result: LoginResult): number {
  switch (result.kind) {
    case "success": return 200;
    case "failure": return 401;
    case "locked": return 423;
    case "rate_limited": return 429;
    case "origin_rejected": return 403;
  }
}
