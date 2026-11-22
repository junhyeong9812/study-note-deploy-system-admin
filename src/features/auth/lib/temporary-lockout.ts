/** 임시 제한 — 관측 서버에 닿지 않을 때 인스턴스 메모리에서 판정. 연속 3회 실패 → 15분 잠금.
 * 잠금 중에는 맞는 자격도 거절하고, 그 시도는 횟수를 늘리지도 잠금을 연장하지도 않는다.
 * 성공하면 0, 잠금이 풀리면 0 부터. 관측 서버 판정과 같은 모양(AttemptVerdict)으로 답한다. */
import type { AttemptVerdict, Clock } from "@/features/auth/lib/types";

export interface TemporaryLockoutOptions {
  clock: Clock;
  maxFailures?: number;          // 기본 3
  lockMilliseconds?: number;     // 기본 15분
}

export interface TemporaryLockout {
  decide(credentialOk: boolean): AttemptVerdict;
  failures(): number;
  lockedUntil(): number | null;  // epoch 밀리초, 잠금 아니면 null
}

export function createTemporaryLockout(options: TemporaryLockoutOptions): TemporaryLockout {
  const maxFailures = options.maxFailures ?? 3;
  const lockMilliseconds = options.lockMilliseconds ?? 15 * 60 * 1000;
  let failureCount = 0;
  let lockedUntilTime: number | null = null;

  /** 잠금이 끝났으면 풀고 0 부터. */
  const releaseIfExpired = (now: number) => {
    if (lockedUntilTime !== null && now >= lockedUntilTime) {
      lockedUntilTime = null;
      failureCount = 0;
    }
  };

  return {
    decide(credentialOk) {
      const now = options.clock();
      releaseIfExpired(now);
      if (lockedUntilTime !== null) {
        return { allowed: false, outcome: "locked", lockedUntil: new Date(lockedUntilTime).toISOString(), lockStarted: false, failures: failureCount };
      }
      if (credentialOk) {
        failureCount = 0;
        return { allowed: true, outcome: "success", lockedUntil: null, lockStarted: false, failures: 0 };
      }
      failureCount += 1;
      if (failureCount >= maxFailures) {
        lockedUntilTime = now + lockMilliseconds;
        // 잠금을 건 그 시도 자체는 실패다(관측 서버와 같은 꼴) — 응답은 lockStarted 를 보고 잠금으로 답한다
        return { allowed: false, outcome: "failure", lockedUntil: new Date(lockedUntilTime).toISOString(), lockStarted: true, failures: failureCount };
      }
      return { allowed: false, outcome: "failure", lockedUntil: null, lockStarted: false, failures: failureCount };
    },
    failures() {
      releaseIfExpired(options.clock());
      return failureCount;
    },
    lockedUntil() {
      releaseIfExpired(options.clock());
      return lockedUntilTime;
    },
  };
}
