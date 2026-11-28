/** 로그 조회 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 OBSERVE_URL · OBSERVE_SECRET 을 읽고 관측 서버를 부른다.
 * 설정이 비었거나 주소가 http(s) 가 아니면 logs = not_configured(호출 없음). 시계는 Date.now, 네트워크는 부를 때의 전역 fetch. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createLogClient } from "@/features/logs/lib/log-client";
import { nextLogPageQuery, parseLogQuery, type LogPage, type LogQuery } from "@/features/logs/lib/log-query";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { invalidInputOf, screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import { upstreamFailure, type SearchParamsInput, type UpstreamResult } from "@/shared/lib/upstream-result";
import { currentRequestId } from "@/shared/lib/request-scope";
import { inRequestScope } from "@/shared/lib/request-id";

export interface LogSearchView {
  /** 입력이 틀렸으면 null(logs 는 invalid_input, 호출 없음) */
  query: LogQuery | null;
  logs: UpstreamResult<LogPage>;
  /** 다음 쪽 조건(nextLogPageQuery) — 끝이거나 실패면 null */
  nextPageQuery: LogQuery | null;
}

async function buildLogSearchView(searchParams: SearchParamsInput): Promise<LogSearchView> {
  const parsed = parseLogQuery(searchParams, Date.now());
  if (!parsed.ok) return { query: null, logs: parsed, nextPageQuery: null };
  const config = readServerConfig();
  let logs: UpstreamResult<LogPage>;
  if (!isHttpBaseUrl(config.observeUrl) || config.observeSecret.length === 0) {
    logs = upstreamFailure("not_configured");
  } else {
    const client = createLogClient({ baseUrl: config.observeUrl, secret: config.observeSecret, fetch: (input, init) => fetch(input, init) });
    logs = await client.searchLogs(parsed.query);
  }
  const logLine = upstreamFailureLogLine("logs", "logs", logs);
  if (logLine !== null) void log(currentRequestId(), logLine, "warning");
  return { query: parsed.query, logs, nextPageQuery: logs.ok ? nextLogPageQuery(parsed.query, logs.value) : null };
}

/** 화면용 — 세션이 없으면 /login(다른 서버를 부르지 않는다). */
export async function loadLogSearch(searchParams: SearchParamsInput): Promise<LogSearchView> {
  return inRequestScope(async () => {
    await requireSession();
    return buildLogSearchView(searchParams);
  });
}

/** 데이터 경로용 — 세션이 없으면 401. 입력이 틀리면 422 `{success:false,error:{code:"invalid_input",field}}`, 그 밖은 200 `{success:true,data:LogSearchView}`. no-store. */
export async function logSearchResponse(request: Request): Promise<Response> {
  return inRequestScope(async () => {
    const session = await requireApiSession();
    if (session instanceof Response) return session;
    const view = await buildLogSearchView(searchParamsInputFromUrl(new URL(request.url)));
    return screenDataResponse(view, invalidInputOf(view.logs));
  });
}
