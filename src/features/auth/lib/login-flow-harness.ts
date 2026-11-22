/** 로그인 흐름 테스트의 조립 — 실제 속도 제한 · 임시 제한 · 대기열 + Fake 관측/알림/로거/시계. */
import { vi } from "vitest";
import { createAttemptQueue } from "@/features/auth/lib/attempt-queue";
import { createLoginFlow, type LoginInput } from "@/features/auth/lib/login-flow";
import { createRateLimiter } from "@/features/auth/lib/rate-limit";
import { createTemporaryLockout } from "@/features/auth/lib/temporary-lockout";
import {
  FAKE_ADMIN_ID, FAKE_IP, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_PASSWORD_HASH, FAKE_SIGNING_KEY, FAKE_USER_AGENT,
  createFakeAlertClient, createFakeClock, createFakeObserveClient, createRecordingLogger,
} from "@/features/auth/lib/test-fakes";
import type { PasswordVerifier } from "@/features/auth/lib/types";

export const OUTAGE = { ok: false as const, reason: "unreachable" as const };
export const TIMEOUT = { ok: false as const, reason: "timeout" as const };

export function buildHarness(options: { queueCapacity?: number; account?: { adminId: string; passwordHash: string };
                       delay?: (milliseconds: number) => Promise<void>; maxTrackedIps?: number } = {}) {
  const clock = createFakeClock();
  const recording = createRecordingLogger();
  const observe = createFakeObserveClient();
  const alert = createFakeAlertClient();
  const queue = createAttemptQueue({ capacity: options.queueCapacity ?? 500 });
  const temporaryLockout = createTemporaryLockout({ clock: clock.now });
  const rateLimiter = createRateLimiter({ clock: clock.now, maxTrackedIps: options.maxTrackedIps });
  const verifyPassword = vi.fn<PasswordVerifier>(async (passwordHash, password) =>
    passwordHash === FAKE_PASSWORD_HASH && password === FAKE_PASSWORD);
  let attemptCounter = 0;
  const flow = createLoginFlow({
    clock: clock.now,
    newAttemptId: () => {
      attemptCounter += 1;
      return `00000000-0000-4000-8000-${String(attemptCounter).padStart(12, "0")}`;
    },
    account: options.account ?? { adminId: FAKE_ADMIN_ID, passwordHash: FAKE_PASSWORD_HASH },
    verifyPassword,
    sessionSigningKey: FAKE_SIGNING_KEY,
    configuredOrigin: FAKE_ORIGIN,
    rateLimiter, temporaryLockout, attemptQueue: queue,
    observeClient: observe, alertClient: alert, logger: recording.logger,
    delay: options.delay ?? (() => new Promise<void>(() => undefined)),   // 기본: 끝나지 않는 대기 — 알림이 빨리 끝나면 기다리지 않아야 한다
  });
  return { clock, recording, observe, alert, queue, temporaryLockout, verifyPassword, flow };
}

export function input(overrides: Partial<LoginInput> = {}): LoginInput {
  return { id: FAKE_ADMIN_ID, password: FAKE_PASSWORD, ip: FAKE_IP, userAgent: FAKE_USER_AGENT, origin: FAKE_ORIGIN, ...overrides };
}
