/** 로그인 속도 제한 — IP 마다 최근 60초(미끄러지는 창) 안의 허용 요청이 10회면 그다음은 거절.
 * 인스턴스 메모리에서 센다. 추적 IP 수에 상한이 있다 — 만료된 IP 는 정리하고, 아직 창 안에 있는 IP 는 지우지 않는다.
 * 표가 활성 항목으로 가득 차면 새 IP 는 거절한다(닫힌 쪽 — 세부 3, tableFull:true). */
import type { Clock } from "@/features/auth/lib/types";

export interface RateLimiterOptions {
  clock: Clock;
  limit?: number;             // 기본 10
  windowMilliseconds?: number; // 기본 60_000
  maxTrackedIps?: number;     // 기본 10_000
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 거절이면서, 이 IP 의 이번 창에서 첫 거절일 때만 true. */
  firstRejectionInWindow: boolean;
  /** 표가 활성 항목으로 가득 차 새 IP 를 받지 못한 거절(관측 서버에 기록하지 않는다 — 건수만 로그). */
  tableFull?: boolean;
}

export interface RateLimiter {
  hit(ip: string): RateLimitDecision;
  trackedIpCount(): number;
}

interface IpWindow {
  allowedTimestamps: number[];   // 창 안의 허용 요청 시각(오래된 것부터)
  rejectionMarked: boolean;      // 막힌 뒤 첫 거절을 이미 표시했나 — 다시 허용되면 지운다
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const limit = options.limit ?? 10;
  const windowMilliseconds = options.windowMilliseconds ?? 60_000;
  const maxTrackedIps = options.maxTrackedIps ?? 10_000;
  // Map 의 순서 = 마지막 허용 요청 시각 순(허용될 때마다 맨 뒤로 옮긴다) → 앞에서부터 만료·정리
  const windows = new Map<string, IpWindow>();

  const isExpired = (window: IpWindow, now: number) => {
    const latest = window.allowedTimestamps[window.allowedTimestamps.length - 1];
    return latest === undefined || now - latest >= windowMilliseconds;
  };

  const pruneExpired = (now: number) => {
    for (const [ip, window] of windows) {
      if (!isExpired(window, now)) break;
      windows.delete(ip);
    }
  };

  return {
    hit(ip) {
      const now = options.clock();
      pruneExpired(now);
      let window = windows.get(ip);
      if (window === undefined) {
        // 만료된 항목은 위에서 정리했다 — 남은 것은 전부 창 안이다. 지우지 않고 새 IP 를 거절한다.
        if (windows.size >= maxTrackedIps) return { allowed: false, firstRejectionInWindow: false, tableFull: true };
        window = { allowedTimestamps: [], rejectionMarked: false };
      }
      while (window.allowedTimestamps.length > 0 && now - window.allowedTimestamps[0] >= windowMilliseconds) {
        window.allowedTimestamps.shift();
      }
      if (window.allowedTimestamps.length < limit) {
        window.allowedTimestamps.push(now);
        window.rejectionMarked = false;
        windows.delete(ip);
        windows.set(ip, window);
        return { allowed: true, firstRejectionInWindow: false };
      }
      const firstRejectionInWindow = !window.rejectionMarked;
      window.rejectionMarked = true;
      if (!windows.has(ip)) windows.set(ip, window);
      return { allowed: false, firstRejectionInWindow };
    },
    trackedIpCount() {
      return windows.size;
    },
  };
}
