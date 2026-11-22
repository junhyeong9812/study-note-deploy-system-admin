/** 관측 서버 로그 조회 클라이언트 — `GET <OBSERVE_URL>/logs?…`, 헤더 `X-Observe-Secret`, 5초 기한, GET 만, redirect:"manual".
 * 보내는 인자: LogQuery 에서 null 이 아닌 것만(from · to · service · level · request_id · q · before) + limit(언제나).
 * 응답(LogController.kt:110-121): `{success:true,data:{logs:[{id,at,level,service,request_id,message}],next_before,from,to}}`.
 * 오류(LogController.kt:38-56): 401 unauthorized · 422 invalid_request(detail 포함 — 넘기지 않는다) · 503 query_failed · 504 query_timeout
 * → UpstreamFailure 의 unauthorized · invalid_request · unavailable · server_timeout(status 함께, message 는 고정 글자). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { LOG_LEVELS, type LogEntryView, type LogLevel, type LogPage, type LogQuery } from "@/features/logs/lib/log-query";
import { envelopeData, getUpstream, isRecord, upstreamUrl } from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export interface LogClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface LogClient {
  searchLogs(query: LogQuery): Promise<UpstreamResult<LogPage>>;
}

function parseLogEntry(row: unknown): LogEntryView | null {
  if (!isRecord(row)) return null;
  const { id, at, level, service, request_id: requestId, message } = row;
  if (typeof id !== "string" || typeof at !== "string" || typeof service !== "string" || typeof requestId !== "string" || typeof message !== "string") return null;
  if (typeof level !== "string" || !(LOG_LEVELS as readonly string[]).includes(level)) return null;
  return { id, at, level: level as LogLevel, service, requestId, message };
}

export function createLogClient(options: LogClientOptions): LogClient {
  return {
    async searchLogs(query) {
      const url = upstreamUrl(options.baseUrl, "/logs", [
        ["from", query.from], ["to", query.to], ["service", query.service], ["level", query.level],
        ["request_id", query.requestId], ["q", query.text], ["before", query.before], ["limit", String(query.limit)],
      ]);
      const response = await getUpstream(url, { fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers: { "X-Observe-Secret": options.secret } });
      if (!response.ok) return response;
      if (response.status < 200 || response.status >= 300) return failureForHttpStatus(response.status);
      const data = envelopeData(response);
      if (data === undefined || !Array.isArray(data.logs)) return upstreamFailure("unparseable");
      const { next_before: nextBefore, from, to } = data;
      if (typeof nextBefore !== "string" || typeof from !== "string" || typeof to !== "string") return upstreamFailure("unparseable");
      const logs: LogEntryView[] = [];
      for (const row of data.logs) {
        const entry = parseLogEntry(row);
        if (entry === null) return upstreamFailure("unparseable");
        logs.push(entry);
      }
      return { ok: true, value: { logs, nextBefore: nextBefore === "" ? null : nextBefore, from, to } };
    },
  };
}
