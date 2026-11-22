/** 관측 서버 로그 조회 클라이언트 — `GET <OBSERVE_URL>/logs?…`, 헤더 `X-Observe-Secret`, 5초 기한, GET 만, redirect:"manual".
 * 보내는 인자: LogQuery 에서 null 이 아닌 것만(from · to · service · level · request_id · q · before) + limit(언제나).
 * 응답(LogController.kt:110-121): `{success:true,data:{logs:[{id,at,level,service,request_id,message}],next_before,from,to}}`.
 * 오류(LogController.kt:38-56): 401 unauthorized · 422 invalid_request(detail 포함 — 넘기지 않는다) · 503 query_failed · 504 query_timeout
 * → UpstreamFailure 의 unauthorized · invalid_request · unavailable · server_timeout(status 함께, message 는 고정 글자). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { LogPage, LogQuery } from "@/features/logs/lib/log-query";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

export interface LogClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface LogClient {
  searchLogs(query: LogQuery): Promise<UpstreamResult<LogPage>>;
}

export function createLogClient(options: LogClientOptions): LogClient {
  void options;
  throw new Error("not implemented");
}
