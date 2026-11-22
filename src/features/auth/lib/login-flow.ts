/** 로그인 흐름 조립 — Route Handler(POST /api/auth/login)가 부른다.
 * 순서: Origin 검사 → 속도 제한(초과면 비밀번호 검증 없이 rate_limited, IP 마다 창당 첫 1건만 rejected 기록)
 *   → 자격 검증 → 관측 서버 판정(성공 = 자격이 맞고 allowed:true)
 *   → lock_started:true 면 알림 1건(실패해도 결과 불변, 앱 로그 1줄)
 *   → 관측 서버 장애면 임시 제한으로 판정 + 대기열에 기록 + temporaryRestriction:true.
 * 관측 서버 호출이 성공하면 대기열을 replayed:true 로 비운다.
 * 대기열이 넘쳐 버린 항목이 생기면 앱 로그(warning)에 `dropped=<누적 건수>` 를 남긴다. */
import type { AlertClient } from "@/features/auth/lib/alert-client";
import type { AttemptQueue } from "@/features/auth/lib/attempt-queue";
import type { AccountConfig } from "@/features/auth/lib/credentials";
import type { ObserveClient } from "@/features/auth/lib/observe-client";
import type { RateLimiter } from "@/features/auth/lib/rate-limit";
import type { TemporaryLockout } from "@/features/auth/lib/temporary-lockout";
import type { AppLogger, Clock, PasswordVerifier } from "@/features/auth/lib/types";

export const USER_AGENT_MAX_LENGTH = 200;

export interface LoginInput {
  id: string;
  password: string;
  ip: string;
  userAgent: string;
  origin: string | null;
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
  throw new Error("not implemented");
}

/** 결과 → HTTP 상태: success 200 · failure 401 · locked 423 · rate_limited 429 · origin_rejected 403. */
export function loginResultStatus(result: LoginResult): number {
  throw new Error("not implemented");
}
