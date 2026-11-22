/** 관측 서버 로그인 시도 기록 클라이언트 — `GET /auth/attempts?…` · `GET /auth/lock`, 헤더 `X-Observe-Secret`, 호출마다 5초, GET 만, redirect:"manual".
 * 응답 봉투 `{success:true,data:…}`. 오류 401 · 422 · 503(query_failed) → unauthorized · invalid_request · unavailable(고정 글자). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { LockStatusView, LoginAttemptsPage, LoginAttemptsQuery } from "@/features/login-attempts/lib/login-attempts-query";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

export interface LoginAttemptsClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface LoginAttemptsClient {
  /** 보내는 인자: null 이 아닌 from · to · before + limit(언제나). */
  listAttempts(query: LoginAttemptsQuery): Promise<UpstreamResult<LoginAttemptsPage>>;
  readLock(): Promise<UpstreamResult<LockStatusView>>;
}

export function createLoginAttemptsClient(options: LoginAttemptsClientOptions): LoginAttemptsClient {
  void options;
  throw new Error("not implemented");
}
