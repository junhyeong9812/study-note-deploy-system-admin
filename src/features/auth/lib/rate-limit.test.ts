import { describe, expect, it } from "vitest";
import { createRateLimiter } from "@/features/auth/lib/rate-limit";
import { createFakeClock } from "@/features/auth/lib/test-fakes";

const IP_A = "198.51.100.1";
const IP_B = "198.51.100.2";

function hitTimes(limiter: ReturnType<typeof createRateLimiter>, ip: string, count: number) {
  return Array.from({ length: count }, () => limiter.hit(ip));
}

describe("속도 제한 — IP 마다 최근 60초 10회", () => {
  it("10회까지 허용, 11번째 거절", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now });
    const decisions = hitTimes(limiter, IP_A, 11);
    expect(decisions.slice(0, 10).every((decision) => decision.allowed)).toBe(true);
    expect(decisions[10].allowed).toBe(false);
  });

  it("IP 끼리는 따로 센다", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now });
    hitTimes(limiter, IP_A, 11);
    expect(limiter.hit(IP_B).allowed).toBe(true);
  });

  it("창(60초)이 지나면 다시 허용", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now });
    hitTimes(limiter, IP_A, 11);
    clock.advance(59_999);
    expect(limiter.hit(IP_A).allowed).toBe(false);
    clock.advance(1);
    expect(limiter.hit(IP_A).allowed).toBe(true);
  });

  it("미끄러지는 창 — 60초 전의 요청만 빠진다", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now });
    hitTimes(limiter, IP_A, 5);            // t=0
    clock.advance(30_000);
    hitTimes(limiter, IP_A, 5);            // t=30s
    expect(limiter.hit(IP_A).allowed).toBe(false);
    clock.advance(30_000);                 // t=60s — 앞의 5건만 빠진다
    const decisions = hitTimes(limiter, IP_A, 6);
    expect(decisions.slice(0, 5).every((decision) => decision.allowed)).toBe(true);
    expect(decisions[5].allowed).toBe(false);
  });

  it("거절된 요청은 창을 늘리지 않는다(계속 두드려도 60초 뒤 풀린다)", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now });
    hitTimes(limiter, IP_A, 10);           // t=0
    for (let second = 1; second < 60; second += 1) {
      clock.advance(1000);
      expect(limiter.hit(IP_A).allowed).toBe(false);
    }
    clock.advance(1000);                   // t=60s
    expect(limiter.hit(IP_A).allowed).toBe(true);
  });

  it("창당 첫 거절만 firstRejectionInWindow", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now });
    const decisions = hitTimes(limiter, IP_A, 13);
    expect(decisions.slice(0, 10).every((decision) => !decision.firstRejectionInWindow)).toBe(true);
    expect(decisions[10]).toEqual({ allowed: false, firstRejectionInWindow: true });
    expect(decisions[11]).toEqual({ allowed: false, firstRejectionInWindow: false });
    expect(decisions[12]).toEqual({ allowed: false, firstRejectionInWindow: false });
    expect(limiter.hit(IP_B).firstRejectionInWindow).toBe(false);
  });

  it("창이 지나 다시 막히면 그 창의 첫 거절이 다시 표시된다", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now });
    hitTimes(limiter, IP_A, 12);
    clock.advance(60_000);
    const decisions = hitTimes(limiter, IP_A, 12);
    expect(decisions[10]).toEqual({ allowed: false, firstRejectionInWindow: true });
    expect(decisions[11].firstRejectionInWindow).toBe(false);
  });

  it("다른 IP 의 거절 표시는 서로 독립", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now });
    hitTimes(limiter, IP_A, 11);
    const decisionsB = hitTimes(limiter, IP_B, 11);
    expect(decisionsB[10].firstRejectionInWindow).toBe(true);
  });

  it("추적 IP 수는 상한을 넘지 않는다", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now, maxTrackedIps: 3 });
    for (let index = 0; index < 50; index += 1) {
      limiter.hit(`198.51.100.${index + 10}`);
      clock.advance(10);
      expect(limiter.trackedIpCount()).toBeLessThanOrEqual(3);
    }
  });

  it("상한에서는 만료된 IP 부터 정리하고 아직 막힌 IP 는 남긴다", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now, maxTrackedIps: 3 });
    limiter.hit("198.51.100.20");                       // t=0 — 61초 뒤 만료
    clock.advance(30_000);
    hitTimes(limiter, IP_A, 10);                        // t=30s — 막힌 상태
    clock.advance(31_000);                              // t=61s
    limiter.hit("198.51.100.21");
    limiter.hit("198.51.100.22");
    expect(limiter.trackedIpCount()).toBeLessThanOrEqual(3);
    expect(limiter.hit(IP_A).allowed).toBe(false);      // 만료된 .20 이 먼저 나갔다
  });

  it("만료된 IP 는 추적 수에서 빠진다(오래된 IP 정리)", () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ clock: clock.now });
    for (let index = 0; index < 20; index += 1) limiter.hit(`198.51.100.${index + 30}`);
    clock.advance(60_000 * 5);
    limiter.hit(IP_A);
    expect(limiter.trackedIpCount()).toBe(1);
  });
});
