/** 로그인 흐름 조립 — Route Handler(POST /api/auth/login)가 부른다.
 * 순서(세부 2): Origin 검사(틀리면 origin_rejected — 속도 제한을 쓰지 않는다)
 *   → 속도 제한(초과면 비밀번호 검증 없이 rate_limited) → 형식 판정(malformed — 형식 오류도 속도 제한에 센다)
 *   → 자격 검증 → 관측 서버 판정(성공 = 자격이 맞고 allowed:true, lockStarted:true 면 결과는 잠금)
 *   → lockStarted:true 면 알림 1건(최대 ALERT_WAIT_MILLISECONDS 만 기다린다. 실패·초과는 결과 불변, 앱 로그 1줄)
 *   → 관측 서버 장애면 임시 제한으로 판정 + 대기열에 기록(그 판정의 outcome 과 함께) + temporaryRestriction:true.
 * 자격 검증 전에 거절한 것(rate_limited · origin_rejected · malformed)은 IP 마다 고정 60초 창에 이유별 첫 1건만 rejected 로 기록
 *   — 응답은 기록을 기다리지 않는다(뒤에서 끝까지 보내고 실패하면 대기열, waitForBackgroundRecords).
 * 본문(readCredentials)은 Origin 검사 · 속도 제한 뒤에만 읽는다. 속도 제한 표가 가득 차면 새 IP 는 429(기록 없음).
 * 관측 서버 호출이 성공하면 대기열을 비운다 — 시도 기록은 replayed:true + outcome, 응답이 잠금 시작이면 알림.
 * 대기열에 넣을 때마다 `queued=<현재 건수>`, 넘쳐 버리면 `dropped=<누적 건수>` 를 앱 로그에 남긴다.
 * 세부 4: 대기열이 비어 있지 않은 동안 REPLAY_INTERVAL_MILLISECONDS 마다 스스로 재전송한다(한 번에 하나만).
 *   관측 서버에 보내지 않는 거절(창 안의 반복 · 표 포화)은 요청마다가 아니라 이유별 60초에 1줄(`count=<n>`)로 남긴다. */
import { REPLAY_INTERVAL_MILLISECONDS, unrefScheduler, type Scheduler, type ScheduledTask } from "@/features/auth/lib/replay-scheduler";
import type { AlertClient } from "@/features/auth/lib/alert-client";
import type { AttemptQueue, QueuedRecord } from "@/features/auth/lib/attempt-queue";
import { verifyCredentials, type AccountConfig } from "@/features/auth/lib/credentials";
import type { ObserveClient } from "@/features/auth/lib/observe-client";
import { isAllowedOrigin } from "@/features/auth/lib/origin";
import type { RateLimiter } from "@/features/auth/lib/rate-limit";
import { issueSessionToken } from "@/features/auth/lib/session";
import type { TemporaryLockout } from "@/features/auth/lib/temporary-lockout";
import { newRequestId, runWithRequestId } from "@/shared/lib/request-scope";
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
  /** 세부 3: 본문 읽기 — Route Handler 가 넘긴다. 흐름은 Origin 검사 → 속도 제한을 통과한 뒤에만 부른다(그 전에는 본문을 읽지 않는다).
   * null 이면 형식 오류(상한 4KB · 기한 3초 초과 포함) → malformed. 주어지면 id·password·malformed 대신 이 결과를 쓴다. */
  readCredentials?: () => Promise<{ id: string; password: string } | null>;
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
  /** 세부 4: 대기열 주기 재전송의 타이머(기본 unrefScheduler). 대기열이 비어 있지 않은 동안만 REPLAY_INTERVAL_MILLISECONDS 마다. */
  scheduler?: Scheduler;
}

/** 세부 2: 잠금 알림은 로그인 응답을 이만큼만 기다린다. 넘으면 응답을 먼저 돌려주고 앱 로그 1줄. */
export const ALERT_WAIT_MILLISECONDS = 2_000;

/** 거절 기록의 창 — IP 마다 이유별 첫 1건만 관측 서버에 보낸다. */
const REJECTION_RECORD_WINDOW_MILLISECONDS = 60_000;
/** 기록하지 않은 거절의 이유 — 관측 서버 계약의 세 이유 + 속도 제한 표 포화. */
type UnrecordedReason = RejectionReason | "saturated";

/** 기록하지 않은 거절 건수 로그의 창 — 이유별 60초에 1줄. */
const UNRECORDED_COUNT_WINDOW_MILLISECONDS = 60_000;

/** 거절 기록 창을 기억하는 IP · 이유 쌍의 상한 — 넘으면 새 쌍은 기록하지 않고 건수만 센다. */
const REJECTION_RECORD_MAX_KEYS = 10_000;

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
  /** 세부 3: 응답을 기다리게 하지 않은 거절 기록 전송(과 그 실패의 대기열 넣기)이 끝날 때까지 기다린다. */
  waitForBackgroundRecords(): Promise<void>;
  /** 세부 4: 관측 서버에 닿지 않는 동안 true — 마지막 관측 호출이 실패했거나 대기열에 항목이 있는 동안. */
  temporaryRestrictionActive(): boolean;
  /** 세부 4: 아직 로그로 내보내지 않은 "기록하지 않은 거절" 건수를 이유별 1줄로 내보낸다(창 끝 · 종료 때).
   * 줄 형식(계약): 이유 낱말(origin_rejected · malformed · rate_limited · saturated)과 `count=<n>` 을 담는다. 0 건이면 줄 없음. */
  flushUnrecordedCounts(): void;
}

export function createLoginFlow(dependencies: LoginFlowDependencies): LoginFlow {
  const {
    clock, newAttemptId, account, verifyPassword, sessionSigningKey, configuredOrigin,
    rateLimiter, temporaryLockout, attemptQueue, observeClient, alertClient,
  } = dependencies;
  const delay = dependencies.delay ?? defaultDelay;
  // 거절 기록의 창 — IP · 이유마다 고정 60초 창(창이 시작된 시각)에 첫 1건(세부 3)
  const rejectionWindowStarts = new Map<string, number>();
  const scheduler = dependencies.scheduler ?? unrefScheduler;
  let replayInFlight: Promise<void> | null = null;
  let replayTimer: ScheduledTask | null = null;
  let countFlushTimer: ScheduledTask | null = null;
  let lastObserveCallFailed = false;
  const backgroundRecords = new Set<Promise<void>>();
  // 관측 서버에 보내지 않은 거절의 건수 — 이유별로 창(60초)이 시작된 시각과 그 창의 건수(세부 4)
  const unrecordedCounts = new Map<UnrecordedReason, { windowStartedAt: number; count: number }>();

  /** 이 IP · 이유의 고정 창에서 첫 거절인가. 맵은 창이 시작된 순서 — 앞에서부터 만료 항목을 정리하고, 상한이면 기록하지 않는다. */
  const isFirstRejectionInWindow = (reason: RejectionReason, ip: string): boolean => {
    const now = clock();
    for (const [key, startedAt] of rejectionWindowStarts) {
      if (now - startedAt < REJECTION_RECORD_WINDOW_MILLISECONDS) break;
      rejectionWindowStarts.delete(key);
    }
    const key = `${reason}|${ip}`;
    const startedAt = rejectionWindowStarts.get(key);
    if (startedAt !== undefined && now - startedAt < REJECTION_RECORD_WINDOW_MILLISECONDS) return false;
    if (startedAt === undefined && rejectionWindowStarts.size >= REJECTION_RECORD_MAX_KEYS) return false;
    rejectionWindowStarts.delete(key);
    rejectionWindowStarts.set(key, now);
    return true;
  };

  /** 로그는 요청을 막지 않는다 — 로거의 실패·예외를 흡수한다. */
  const log = (requestId: string, message: string, level: "info" | "warning" | "error" = "info") => {
    try {
      const pending = dependencies.logger(requestId, message, level);
      if (pending && typeof pending.catch === "function") pending.catch(() => undefined);
    } catch {
      // 무해
    }
  };

  /** 관측 호출의 결과를 기억한다 — 임시 제한 표시(temporaryRestrictionActive)가 쓴다. */
  const noteObserveCall = (succeeded: boolean) => {
    lastObserveCallFailed = !succeeded;
  };

  /** 이유 하나의 집계 줄을 내보내고 지운다(0 건이면 줄 없음). */
  const emitUnrecordedCount = (reason: UnrecordedReason) => {
    const entry = unrecordedCounts.get(reason);
    unrecordedCounts.delete(reason);
    if (entry === undefined || entry.count === 0) return;
    log("login-aggregate", `login:unrecorded_rejections reason=${reason} count=${entry.count} window_seconds=${UNRECORDED_COUNT_WINDOW_MILLISECONDS / 1000}`,
      reason === "saturated" ? "warning" : "info");
  };

  /** 창(60초)이 끝난 이유들의 건수를 내보낸다. 남은 창이 있으면 그 끝에 다시 확인하도록 예약한다. */
  const flushExpiredUnrecordedCounts = () => {
    const now = clock();
    for (const [reason, entry] of [...unrecordedCounts]) {
      if (now - entry.windowStartedAt >= UNRECORDED_COUNT_WINDOW_MILLISECONDS) emitUnrecordedCount(reason);
    }
    scheduleCountFlush();
  };

  const scheduleCountFlush = () => {
    if (countFlushTimer !== null || unrecordedCounts.size === 0) return;
    const now = clock();
    const earliestEnd = Math.min(...[...unrecordedCounts.values()].map((entry) => entry.windowStartedAt + UNRECORDED_COUNT_WINDOW_MILLISECONDS));
    countFlushTimer = scheduler(() => {
      countFlushTimer = null;
      flushExpiredUnrecordedCounts();
    }, Math.max(earliestEnd - now, 0));
  };

  /** 관측 서버에 보내지 않은 거절 1건을 센다 — 요청마다 로그를 남기지 않는다. */
  const countUnrecorded = (reason: UnrecordedReason) => {
    const now = clock();
    const entry = unrecordedCounts.get(reason);
    if (entry !== undefined && now - entry.windowStartedAt >= UNRECORDED_COUNT_WINDOW_MILLISECONDS) emitUnrecordedCount(reason);
    const current = unrecordedCounts.get(reason);
    if (current === undefined) unrecordedCounts.set(reason, { windowStartedAt: now, count: 1 });
    else current.count += 1;
    scheduleCountFlush();
  };

  /** 대기열이 비어 있지 않으면 주기 재전송을 하나 걸어 둔다(이미 걸려 있으면 그대로). */
  const scheduleReplay = () => {
    if (replayTimer !== null || attemptQueue.size() === 0) return;
    replayTimer = scheduler(() => {
      replayTimer = null;
      flushExpiredUnrecordedCounts();
      if (replayInFlight !== null) return;   // 도는 중이면 그 실행이 끝날 때 다시 건다
      if (attemptQueue.size() === 0) return; // 비었으면 멈춘다
      startReplay();
    }, REPLAY_INTERVAL_MILLISECONDS);
  };

  /** 대기열에 넣고 현재 건수를 남긴다. 넘쳐 버렸으면 누적 유실 건수를 남긴다(조용히 버리지 않는다). */
  const enqueueRecord = (requestId: string, record: QueuedRecord) => {
    if (attemptQueue.enqueue(record)) {
      log(requestId, `login:queue_added kind=${record.kind} queued=${attemptQueue.size()}`);
      scheduleReplay();
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

  /** 관측 서버가 응답했으면 쌓인 기록을 재전송한다(한 번에 하나만 돈다). 현재 로그인 판정과는 무관.
   * 한 바퀴 = 새 추적 ID 의 범위(통신 규약 §1.2 — 들어온 요청 없이 시작되는 호출): 그 바퀴의 호출 · 잠금 알림 · 로그 줄이 그 값이다.
   * 대기열을 채운 요청 · 그때 로그인하는 요청의 ID 를 싣지 않고, 다시 건 타이머가 앞 바퀴의 값을 잇지 않는다(바퀴마다 새로 연다). */
  const startReplay = () => {
    if (replayInFlight !== null || attemptQueue.size() === 0) return;
    const requestId = newRequestId();
    replayInFlight = runWithRequestId(requestId, async () => {
      try {
        const discardStatuses = new Set<number>();
        // 관측 서버가 422(본문 자체가 틀림 — 다시 보내도 같다)를 준 항목만 버린다. 그 밖의 실패는 남겨 다음에 다시 보낸다.
        const discardOrKeep = (failure: { reason: string; status?: number }): "discard" | false => {
          if (failure.reason === "bad_status" && failure.status === 422) {
            discardStatuses.add(422);
            return "discard";
          }
          return false;
        };
        const result = await attemptQueue.flush(async (record) => {
          if (record.kind === "rejected") {
            const recorded = await observeClient.recordRejected(record.body);
            noteObserveCall(recorded.ok);
            return recorded.ok ? true : discardOrKeep(recorded);
          }
          const replayed = await observeClient.recordAttempt({ ...record.body, replayed: true });
          noteObserveCall(replayed.ok);
          if (!replayed.ok) return discardOrKeep(replayed);
          // 응답을 잃었던 잠금 — 재전송 응답이 잠금 시작이면 알린다(key 에 locked_until 이 있어 겹치지 않는다)
          if (replayed.value.lockStarted && replayed.value.lockedUntil !== null) {
            log(requestId, `login:lock_started source=replay until=${replayed.value.lockedUntil}`, "warning");
            await sendLockAlert(requestId, replayed.value.lockedUntil, "replay", false);
          }
          return true;
        });
        log(requestId, `login:queue_replay sent=${result.sent} remaining=${result.remaining}`,
          result.remaining > 0 ? "warning" : "info");
        if (result.discarded > 0) {
          log(requestId, `login:queue_discarded discarded=${result.discarded} status=${[...discardStatuses].join(",")}`, "warning");
        }
      } catch {
        log(requestId, "login:queue_replay failed", "warning");
      } finally {
        replayInFlight = null;
        scheduleReplay();   // 남은 항목(실패 · 도는 중에 들어온 것)이 있으면 다음 주기에 다시
      }
    });
  };

  /** 자격 검증 전 거절의 기록 — 창당 첫 1건만 관측 서버에, 나머지는 건수만 앱 로그에. */
  const recordRejection = (requestId: string, reason: RejectionReason, firstInWindow: boolean,
                                 base: { attemptId: string; at: string; ip: string; userAgent: string }) => {
    if (!firstInWindow) {
      countUnrecorded(reason);
      return;
    }
    const body: RejectedAttemptBody = { attempt_id: base.attemptId, at: base.at, reason, ip: base.ip, user_agent: base.userAgent };
    // 응답을 기다리게 하지 않는다 — 뒤에서 끝까지 보내고, 실패하면 대기열에(시작만 하고 버리지 않는다)
    const task = (async () => {
      try {
        const recorded = await observeClient.recordRejected(body);
        noteObserveCall(recorded.ok);
        if (recorded.ok) {
          log(requestId, `login:${reason} recorded=true`);
          startReplay();
        } else {
          log(requestId, `login:${reason} recorded=false observe=${recorded.reason}`, "warning");
          enqueueRecord(requestId, { kind: "rejected", body });
        }
      } catch {
        noteObserveCall(false);
        log(requestId, `login:${reason} recorded=false observe=exception`, "warning");
        enqueueRecord(requestId, { kind: "rejected", body });
      }
    })();
    backgroundRecords.add(task);
    void task.finally(() => backgroundRecords.delete(task));
  };

  return {
    async login(input) {
      const attemptId = newAttemptId();
      const requestId = input.requestId ?? attemptId;
      const at = new Date(clock()).toISOString();
      const userAgent = input.userAgent.slice(0, USER_AGENT_MAX_LENGTH);
      const base = { attemptId, at, ip: input.ip, userAgent };
      flushExpiredUnrecordedCounts();

      if (!isAllowedOrigin(input.origin, configuredOrigin)) {
        recordRejection(requestId, "origin_rejected", isFirstRejectionInWindow("origin_rejected", input.ip), base);
        return { kind: "origin_rejected" };
      }

      const rateDecision = rateLimiter.hit(input.ip);
      if (rateDecision.tableFull === true) {
        // 표가 활성 항목으로 가득 참 — 닫힌 쪽으로 거절, 관측 서버에는 기록하지 않는다(기록 폭주 방지). 건수는 집계 줄로.
        countUnrecorded("saturated");
        return { kind: "rate_limited" };
      }
      if (!rateDecision.allowed) {
        recordRejection(requestId, "rate_limited", isFirstRejectionInWindow("rate_limited", input.ip), base);
        return { kind: "rate_limited" };
      }

      // 본문은 Origin 검사 · 속도 제한을 통과한 뒤에만 읽는다(세부 3)
      let credentials: { id: string; password: string } | null;
      if (input.readCredentials !== undefined) {
        try {
          credentials = await input.readCredentials();
        } catch {
          credentials = null;
        }
      } else {
        credentials = input.malformed === true ? null : { id: input.id, password: input.password };
      }
      if (credentials === null) {
        recordRejection(requestId, "malformed", isFirstRejectionInWindow("malformed", input.ip), base);
        return { kind: "malformed" };
      }

      const credentialOk = await verifyCredentials(credentials, account, verifyPassword);
      const body: AttemptRecordBody = {
        attempt_id: attemptId, at, credential_ok: credentialOk, ip: input.ip, user_agent: userAgent, replayed: false,
      };

      let verdict: AttemptVerdict;
      let temporaryRestriction: boolean;
      const observed = await observeClient.recordAttempt(body);
      noteObserveCall(observed.ok);
      if (observed.ok) {
        verdict = observed.value;
        temporaryRestriction = false;
        // 관측 서버가 허용한 성공은 임시 제한의 메모리 횟수도 0 으로(세부 3)
        if (credentialOk && verdict.allowed && !verdict.lockStarted) temporaryLockout.reset();
        startReplay();
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
    async waitForBackgroundRecords() {
      while (backgroundRecords.size > 0) await Promise.all([...backgroundRecords]);
    },
    temporaryRestrictionActive() {
      return lastObserveCallFailed || attemptQueue.size() > 0;
    },
    flushUnrecordedCounts() {
      for (const reason of [...unrecordedCounts.keys()]) emitUnrecordedCount(reason);
      countFlushTimer?.cancel();
      countFlushTimer = null;
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
