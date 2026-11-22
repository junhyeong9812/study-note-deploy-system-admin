/** 로그인 속도 제한 — IP 마다 최근 60초(미끄러지는 창) 안의 허용 요청이 10회면 그다음은 거절.
 * 인스턴스 메모리에서 센다. 추적 IP 수에 상한이 있다(만료된 IP 부터, 그다음 가장 오래 활동 없는 IP 부터 정리). */
import type { Clock } from "@/features/auth/lib/types";

export interface RateLimiterOptions {
  clock: Clock;
  limit?: number;             // 기본 10
  windowMilliseconds?: number; // 기본 60_000
  maxTrackedIps?: number;     // 기본 10_000
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 거절이면서, 이 IP 의 이번 창에서 첫 거절일 때만 true — 관측 서버에 기록할 1건. */
  firstRejectionInWindow: boolean;
}

export interface RateLimiter {
  hit(ip: string): RateLimitDecision;
  trackedIpCount(): number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  throw new Error("not implemented");
}
