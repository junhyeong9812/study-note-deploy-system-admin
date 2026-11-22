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
  throw new Error("not implemented");
}
