/** 로그인 흐름 조립 — Route Handler(POST /api/auth/login)가 부른다.
 * 순서(세부 2): Origin 검사(틀리면 origin_rejected — 속도 제한을 쓰지 않는다)
 *   → 속도 제한(초과면 비밀번호 검증 없이 rate_limited) → 형식 판정(malformed — 형식 오류도 속도 제한에 센다)
 *   → 자격 검증 → 관측 서버 판정(성공 = 자격이 맞고 allowed:true, lockStarted:true 면 결과는 잠금)
 *   → lockStarted:true 면 알림 1건(최대 ALERT_WAIT_MILLISECONDS 만 기다린다. 실패·초과는 결과 불변, 앱 로그 1줄)
 *   → 관측 서버 장애면 임시 제한으로 판정 + 대기열에 기록(그 판정의 outcome 과 함께) + temporaryRestriction:true.
 * 자격 검증 전에 거절한 것(rate_limited · origin_rejected · malformed)은 IP 마다 60초 창에 이유별 첫 1건만 rejected 로 기록.
 * 관측 서버 호출이 성공하면 대기열을 비운다 — 시도 기록은 replayed:true + outcome, 응답이 잠금 시작이면 알림.
 * 대기열에 넣을 때마다 `queued=<현재 건수>`, 넘쳐 버리면 `dropped=<누적 건수>` 를 앱 로그에 남긴다. */
import type { AlertClient } from "@/features/auth/lib/alert-client";
import type { AttemptQueue, QueuedRecord } from "@/features/auth/lib/attempt-queue";
import { verifyCredentials, type AccountConfig } from "@/features/auth/lib/credentials";
import type { ObserveClient } from "@/features/auth/lib/observe-client";
import { isAllowedOrigin } from "@/features/auth/lib/origin";
import { createRateLimiter, type RateLimiter } from "@/features/auth/lib/rate-limit";
import { issueSessionToken } from "@/features/auth/lib/session";
import type { TemporaryLockout } from "@/features/auth/lib/temporary-lockout";
import type {
  AppLogger, AttemptRecordBody, AttemptVerdict, Clock, PasswordVerifier, RejectedAttemptBody, RejectionReason,
} from "@/features/auth/lib/types";

export const USER_AGENT_MAX_LENGTH = 200;

export interface LoginInput {
  id: string;
  password: string;
  ip: string;
  userAgent: string;
  origin: string | null;
  /** 앱 로그의 requestId — 없으면 이 시도의 attempt_id 를 쓴다. */
  requestId?: string;
  /** 세부 2: 본문 형식이 틀렸거나 상한을 넘었다(Route Handler 가 해석해 넘긴다). true 면 id·password 는 보지 않는다.
   * 순서는 Origin 검사 → 속도 제한 → 이 표시 — 형식 오류도 속도 제한에 센다. */
  malformed?: boolean;
}

export type LoginResult =
  | { kind: "success"; sessionToken: string; temporaryRestriction: boolean }
  | { kind: "failure"; temporaryRestriction: boolean }      // ID 틀림 · 비밀번호 틀림 구별 없음
  | { kind: "locked"; temporaryRestriction: boolean }
  | { kind: "rate_limited" }                                 // HTTP 429
  | { kind: "origin_rejected" }                              // HTTP 403
  | { kind: "malformed" };                                   // HTTP 400

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
  /** 알림 대기 상한용 — milliseconds 뒤에 끝나는 약속. 기본은 setTimeout. 테스트는 직접 끝내는 Fake 를 준다. */
  delay?: (milliseconds: number) => Promise<void>;
}

/** 세부 2: 잠금 알림은 로그인 응답을 이만큼만 기다린다. 넘으면 응답을 먼저 돌려주고 앱 로그 1줄. */
export const ALERT_WAIT_MILLISECONDS = 2_000;

/** 거절 기록의 창 — IP 마다 이유별 첫 1건만 관측 서버에 보낸다. */
const REJECTION_RECORD_WINDOW_MILLISECONDS = 60_000;

/** 기본 대기 — 프로세스 종료를 붙잡지 않는다(unref). */
function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

export interface LoginFlow {
  login(input: LoginInput): Promise<LoginResult>;
  /** login 이 시작한 대기열 재전송(있으면)이 끝날 때까지 기다린다 — 재전송 응답으로 보낸 잠금 알림까지 포함.
   * 재전송을 login 안에서 기다리는 구현이면 바로 끝난다. */
  waitForReplay(): Promise<void>;
}

export function createLoginFlow(dependencies: LoginFlowDependencies): LoginFlow {
  const {
    clock, newAttemptId, account, verifyPassword, sessionSigningKey, configuredOrigin,
    rateLimiter, temporaryLockout, attemptQueue, observeClient, alertClient,
  } = dependencies;
  const delay = dependencies.delay ?? defaultDelay;
  // origin_rejected · malformed 거절 기록의 창(IP 마다 60초에 이유별 1건) — rate_limited 는 rateLimiter 의 표시를 쓴다
  const rejectionRecordWindow = createRateLimiter({ clock, limit: 1, windowMilliseconds: REJECTION_RECORD_WINDOW_MILLISECONDS });
  const unrecordedRejections: Record<RejectionReason, number> = { rate_limited: 0, origin_rejected: 0, malformed: 0 };
  let replayInFlight: Promise<void> | null = null;

  /** 로그는 요청을 막지 않는다 — 로거의 실패·예외를 흡수한다. */
  const log = (requestId: string, message: string, level: "info" | "warning" | "error" = "info") => {
    try {
      const pending = dependencies.logger(requestId, message, level);
      if (pending && typeof pending.catch === "function") pending.catch(() => undefined);
    } catch {
      // 무해
    }
  };

  /** 대기열에 넣고 현재 건수를 남긴다. 넘쳐 버렸으면 누적 유실 건수를 남긴다(조용히 버리지 않는다). */
  const enqueueRecord = (requestId: string, record: QueuedRecord) => {
    if (attemptQueue.enqueue(record)) {
      log(requestId, `login:queue_added kind=${record.kind} queued=${attemptQueue.size()}`);
    } else {
      log(requestId, `login:queue_overflow dropped=${attemptQueue.droppedCount()}`, "warning");
    }
  };

  /** 잠금 알림 — 로그인 응답(또는 재전송)을 최대 ALERT_WAIT_MILLISECONDS 만 기다린다. 실패·초과는 앱 로그 1줄. */
  const sendLockAlert = async (requestId: string, lockedUntil: string, source: "login" | "replay", temporaryRestriction: boolean) => {
    const delivery = (async () => {
      try {
        return (await alertClient.sendLoginLocked(lockedUntil)) === true ? "delivered" as const : "failed" as const;
      } catch {
        return "failed" as const;
      }
    })();
    const waitOver = delay(ALERT_WAIT_MILLISECONDS).then(() => "wait_over" as const, () => "wait_over" as const);
    const outcome = await Promise.race([delivery, waitOver]);
    if (outcome === "failed") {
      log(requestId, `login:lock_alert_failed source=${source} temporary=${temporaryRestriction}`, "warning");
    } else if (outcome === "wait_over") {
      log(requestId, `login:lock_alert_not_confirmed source=${source} waited_ms=${ALERT_WAIT_MILLISECONDS}`, "warning");
    }
  };

  /** 관측 서버가 응답했으면 쌓인 기록을 재전송한다(한 번에 하나만 돈다). 현재 로그인 판정과는 무관. */
  const startReplay = (requestId: string) => {
    if (replayInFlight !== null || attemptQueue.size() === 0) return;
    replayInFlight = (async () => {
      try {
        const result = await attemptQueue.flush(async (record) => {
          if (record.kind === "rejected") return (await observeClient.recordRejected(record.body)).ok;
          const replayed = await observeClient.recordAttempt({ ...record.body, replayed: true });
          if (!replayed.ok) return false;
          // 응답을 잃었던 잠금 — 재전송 응답이 잠금 시작이면 알린다(key 에 locked_until 이 있어 겹치지 않는다)
          if (replayed.value.lockStarted && replayed.value.lockedUntil !== null) {
            log(requestId, `login:lock_started source=replay until=${replayed.value.lockedUntil}`, "warning");
            await sendLockAlert(requestId, replayed.value.lockedUntil, "replay", false);
          }
          return true;
        });
        log(requestId, `login:queue_replay sent=${result.sent} remaining=${result.remaining}`,
          result.remaining > 0 ? "warning" : "info");
      } catch {
        log(requestId, "login:queue_replay failed", "warning");
      } finally {
        replayInFlight = null;
      }
    })();
  };

  /** 자격 검증 전 거절의 기록 — 창당 첫 1건만 관측 서버에, 나머지는 건수만 앱 로그에. */
  const recordRejection = async (requestId: string, reason: RejectionReason, firstInWindow: boolean,
                                 base: { attemptId: string; at: string; ip: string; userAgent: string }) => {
    if (!firstInWindow) {
      unrecordedRejections[reason] += 1;
      log(requestId, `login:${reason} recorded=false unrecorded_total=${unrecordedRejections[reason]}`);
      return;
    }
    const body: RejectedAttemptBody = { attempt_id: base.attemptId, at: base.at, reason, ip: base.ip, user_agent: base.userAgent };
    const recorded = await observeClient.recordRejected(body);
    if (recorded.ok) {
      log(requestId, `login:${reason} recorded=true`);
      startReplay(requestId);
    } else {
      log(requestId, `login:${reason} recorded=false observe=${recorded.reason}`, "warning");
      enqueueRecord(requestId, { kind: "rejected", body });
    }
  };

  return {
    async login(input) {
      const attemptId = newAttemptId();
      const requestId = input.requestId ?? attemptId;
      const at = new Date(clock()).toISOString();
      const userAgent = input.userAgent.slice(0, USER_AGENT_MAX_LENGTH);
      const base = { attemptId, at, ip: input.ip, userAgent };

      if (!isAllowedOrigin(input.origin, configuredOrigin)) {
        const firstInWindow = rejectionRecordWindow.hit(`origin_rejected|${input.ip}`).allowed;
        await recordRejection(requestId, "origin_rejected", firstInWindow, base);
        return { kind: "origin_rejected" };
      }

      const rateDecision = rateLimiter.hit(input.ip);
      if (!rateDecision.allowed) {
        await recordRejection(requestId, "rate_limited", rateDecision.firstRejectionInWindow, base);
        return { kind: "rate_limited" };
      }

      if (input.malformed === true) {
        const firstInWindow = rejectionRecordWindow.hit(`malformed|${input.ip}`).allowed;
        await recordRejection(requestId, "malformed", firstInWindow, base);
        return { kind: "malformed" };
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
        // 재전송 때 관측 서버가 그대로 기록할, 임시 제한이 실제로 내린 판정
        enqueueRecord(requestId, { kind: "attempt", body: { ...body, outcome: verdict.outcome } });
      }

      if (verdict.lockStarted && verdict.lockedUntil !== null) {
        log(requestId, `login:lock_started source=login until=${verdict.lockedUntil} temporary=${temporaryRestriction}`, "warning");
        await sendLockAlert(requestId, verdict.lockedUntil, "login", temporaryRestriction);
      }

      if (credentialOk && verdict.allowed && !verdict.lockStarted) {
        log(requestId, `login:success temporary=${temporaryRestriction}`);
        return { kind: "success", sessionToken: issueSessionToken(sessionSigningKey, clock()), temporaryRestriction };
      }
      if (verdict.lockStarted || verdict.outcome === "locked") {
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
    case "malformed": return 400;
  }
}
