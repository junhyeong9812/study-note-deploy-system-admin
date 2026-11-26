/** 요청 추적의 서버 쪽 진입 — 세션 검증을 **직접** 부른 뒤에만 입력을 해석하고 OBSERVE_URL · OBSERVE_SECRET 을 읽고 관측 서버를 부른다.
 * 설정이 비었거나 주소가 http(s) 가 아니면 trace = not_configured(호출 없음). 시계는 Date.now, 네트워크는 부를 때의 전역 fetch.
 * 실패는 앱 로그 1줄(upstreamFailureLogLine("request-trace", "trace", 결과) — 이유 낱말 · 상태 코드만). 입력 거절 · 성공은 남기지 않는다. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createLogClient } from "@/features/logs/lib/log-client";
import { parseRequestTraceQuery, type RequestTraceQuery } from "@/features/request-trace/lib/request-trace-query";
import { buildRequestTrace, type RequestTraceView } from "@/features/request-trace/lib/request-trace-view";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

/** 세션 검증과 입력 검증을 마친 뒤에만 부른다. */
async function buildRequestTraceView(query: RequestTraceQuery): Promise<RequestTraceView> {
  const config = readServerConfig();
  const logs = isHttpBaseUrl(config.observeUrl) && config.observeSecret.length > 0
    ? createLogClient({ baseUrl: config.observeUrl, secret: config.observeSecret, fetch: (input, init) => fetch(input, init) })
    : null;
  const trace = await buildRequestTrace(logs, query, Date.now());
  const logLine = upstreamFailureLogLine("request-trace", "trace", trace);
  if (logLine !== null) void log("screen-request-trace", logLine, "warning");
  return { requestId: query.requestId, trace, spans: null };   // T7 뼈대 — 구현 전
}

/** 화면용 — 세션이 없으면 /login(관측 서버를 부르지 않는다). 입력이 없으면 빈 폼(부르지 않는다) · 빈 값을 포함해 틀리면 invalid_input. */
export async function loadRequestTrace(searchParams: SearchParamsInput): Promise<RequestTraceView> {
  await requireSession();
  if (searchParams.request_id === undefined) return { requestId: null, trace: null, spans: null };
  const parsed = parseRequestTraceQuery(searchParams);
  if (!parsed.ok) return { requestId: null, trace: parsed, spans: null };
  return buildRequestTraceView(parsed.query);
}

/** 데이터 경로용 — 세션이 없으면 401 · 입력이 없거나 틀리면 422 · 그 밖 200 {success:true,data:RequestTraceView}. no-store. */
export async function requestTraceResponse(request: Request): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  const parsed = parseRequestTraceQuery(searchParamsInputFromUrl(new URL(request.url)));
  if (!parsed.ok) return screenDataResponse(null, parsed);
  return screenDataResponse(await buildRequestTraceView(parsed.query), null);
}
