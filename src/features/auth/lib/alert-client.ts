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
  throw new Error("not implemented");
}
