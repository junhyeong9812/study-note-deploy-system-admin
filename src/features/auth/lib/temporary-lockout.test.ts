import { describe, expect, it } from "vitest";
import { createTemporaryLockout } from "@/features/auth/lib/temporary-lockout";
import { createFakeClock } from "@/features/auth/lib/test-fakes";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

describe("임시 제한 — 3회 실패 → 15분", () => {
  it("맞는 자격은 허용 · success", () => {
    const lockout = createTemporaryLockout({ clock: createFakeClock().now });
    expect(lockout.decide(true)).toMatchObject({ allowed: true, outcome: "success", lockStarted: false, failures: 0 });
  });

  it("2회 실패까지는 failure, 3번째에 잠금 시작", () => {
    const clock = createFakeClock();
    const lockout = createTemporaryLockout({ clock: clock.now });
    expect(lockout.decide(false)).toMatchObject({ allowed: false, outcome: "failure", lockStarted: false, failures: 1 });
    expect(lockout.decide(false)).toMatchObject({ allowed: false, outcome: "failure", lockStarted: false, failures: 2 });
    const third = lockout.decide(false);
    expect(third).toMatchObject({ allowed: false, lockStarted: true, failures: 3 });
    expect(third.lockedUntil).toBe(new Date(clock.now() + FIFTEEN_MINUTES).toISOString());
    expect(lockout.lockedUntil()).toBe(clock.now() + FIFTEEN_MINUTES);
  });

  it("잠금 중에는 맞는 자격도 거절(locked), 횟수·잠금 시각은 그대로", () => {
    const clock = createFakeClock();
    const lockout = createTemporaryLockout({ clock: clock.now });
    lockout.decide(false); lockout.decide(false); lockout.decide(false);
    const lockedUntil = lockout.lockedUntil();
    clock.advance(60_000);
    expect(lockout.decide(true)).toMatchObject({ allowed: false, outcome: "locked", lockStarted: false });
    expect(lockout.decide(false)).toMatchObject({ allowed: false, outcome: "locked", lockStarted: false });
    expect(lockout.lockedUntil()).toBe(lockedUntil);
    expect(lockout.failures()).toBe(3);
  });

  it("15분 직전까지 잠금, 15분이 되면 풀리고 0 부터", () => {
    const clock = createFakeClock();
    const lockout = createTemporaryLockout({ clock: clock.now });
    lockout.decide(false); lockout.decide(false); lockout.decide(false);
    clock.advance(FIFTEEN_MINUTES - 1);
    expect(lockout.decide(true).outcome).toBe("locked");
    clock.advance(1);
    expect(lockout.decide(false)).toMatchObject({ outcome: "failure", failures: 1, lockStarted: false });
    expect(lockout.lockedUntil()).toBeNull();
  });

  it("풀린 뒤 맞는 자격은 허용", () => {
    const clock = createFakeClock();
    const lockout = createTemporaryLockout({ clock: clock.now });
    lockout.decide(false); lockout.decide(false); lockout.decide(false);
    clock.advance(FIFTEEN_MINUTES);
    expect(lockout.decide(true)).toMatchObject({ allowed: true, outcome: "success", failures: 0 });
  });

  it("성공하면 실패 횟수 0 — 연속 실패만 센다", () => {
    const clock = createFakeClock();
    const lockout = createTemporaryLockout({ clock: clock.now });
    lockout.decide(false); lockout.decide(false);
    lockout.decide(true);
    expect(lockout.failures()).toBe(0);
    expect(lockout.decide(false)).toMatchObject({ outcome: "failure", failures: 1 });
    expect(lockout.decide(false)).toMatchObject({ outcome: "failure", failures: 2 });
  });
});
