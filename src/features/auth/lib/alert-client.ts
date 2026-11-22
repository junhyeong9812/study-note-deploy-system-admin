/** 알림 서버 클라이언트 — 잠금이 걸린 그 한 번에 POST /events 1건(헤더 X-Alert-Secret).
 * 본문 {source:"admin", kind:"login_locked", severity:"warning", key(locked_until 포함), title, detail}.
 * detail 에 IP · ID 를 넣지 않는다. 실패(연결·시간 초과·2xx 아님)는 false — 예외를 밖으로 내지 않는다. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";

export const ALERT_TIMEOUT_MILLISECONDS = 5_000;

export interface AlertClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface AlertClient {
  sendLoginLocked(lockedUntil: string): Promise<boolean>;
}

export function createAlertClient(options: AlertClientOptions): AlertClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutSignal = options.timeoutSignal ?? ((milliseconds: number) => AbortSignal.timeout(milliseconds));

  return {
    async sendLoginLocked(lockedUntil) {
      const body = {
        source: "admin",
        kind: "login_locked",
        severity: "warning",
        key: `admin:login_locked:${lockedUntil}`.slice(0, 120),
        title: "어드민 로그인 잠금",
        detail: `연속 로그인 실패로 ${lockedUntil} 까지 로그인이 잠겼습니다.`,
      };
      try {
        const response = await options.fetch(`${baseUrl}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Alert-Secret": options.secret },
          body: JSON.stringify(body),
          signal: timeoutSignal(ALERT_TIMEOUT_MILLISECONDS),
          redirect: "manual",
          cache: "no-store",
        });
        response.body?.cancel().catch(() => undefined);
        return response.status >= 200 && response.status < 300;
      } catch {
        return false;
      }
    },
  };
}
