/** 요청 추적의 서버 쪽 진입 — 세션 검증을 **직접** 부른 뒤에만 입력을 해석하고 OBSERVE_URL · OBSERVE_SECRET 을 읽고 관측 서버를 부른다.
 * 관측 서버 호출은 셋: 로그(`/logs`)와 구간(`/traffic/requests`)을 나란히 → 둘이 끝난 뒤 수신 상태(`/traffic/map` — 창이 로그 · 구간의 시각에 기댄다).
 * 칸마다 따로 실패한다 — 로그가 실패해도 구간은 그대로(창은 구간만으로), 구간이 실패하면 수신 상태는 부르지 않는다.
 * 설정이 비었거나 주소가 http(s) 가 아니면 trace · spans 모두 not_configured(호출 없음). 시계는 Date.now, 네트워크는 부를 때의 전역 fetch.
 * 실패는 칸마다 앱 로그 1줄(upstreamFailureLogLine("request-trace", "trace" | "spans" | "receipt", 결과) — 이유 낱말 · 상태 코드만). 입력 거절 · 성공은 남기지 않는다. */
import "server-only";
import type { FetchLike } from "@/features/auth/lib/types";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createLogClient } from "@/features/logs/lib/log-client";
import { parseRequestTraceQuery, type RequestTraceQuery } from "@/features/request-trace/lib/request-trace-query";
import { buildRequestSpans } from "@/features/request-trace/lib/request-trace-spans";
import { buildRequestTrace, type RequestTraceView } from "@/features/request-trace/lib/request-trace-view";
import { createTrafficSpanClient } from "@/features/request-trace/lib/traffic-span-client";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";
import { currentRequestId } from "@/shared/lib/request-scope";
import { inRequestScope } from "@/shared/lib/request-id";

/** 세션 검증과 입력 검증을 마친 뒤에만 부른다. */
async function buildRequestTraceView(query: RequestTraceQuery): Promise<RequestTraceView> {
  const config = readServerConfig();
  const configured = isHttpBaseUrl(config.observeUrl) && config.observeSecret.length > 0;
  const observeFetch: FetchLike = (input, init) => fetch(input, init);
  const clientOptions = { baseUrl: config.observeUrl, secret: config.observeSecret, fetch: observeFetch };
  const pendingTrace = buildRequestTrace(configured ? createLogClient(clientOptions) : null, query, Date.now());
  // 구간의 창에 쓰는 로그 줄 — 로그를 읽지 못했으면 null(0 줄로 두지 않는다). 구간 조회는 이 답을 기다리지 않고 시작한다
  const pendingLogLines = pendingTrace.then((result) => (result.ok ? result.value.timeline?.lines ?? [] : null));
  const pendingSpans = buildRequestSpans(configured ? createTrafficSpanClient(clientOptions) : null, query.requestId, pendingLogLines, Date.now());
  const [trace, spans] = await Promise.all([pendingTrace, pendingSpans]);
  const failureLogLines = [
    upstreamFailureLogLine("request-trace", "trace", trace),
    upstreamFailureLogLine("request-trace", "spans", spans),
    spans.ok ? upstreamFailureLogLine("request-trace", "receipt", spans.value.receipt) : null,
  ];
  for (const failureLogLine of failureLogLines) if (failureLogLine !== null) void log(currentRequestId(), failureLogLine, "warning");
  return { requestId: query.requestId, trace, spans };
}

/** 화면용 — 세션이 없으면 /login(관측 서버를 부르지 않는다). 입력이 없으면 빈 폼(부르지 않는다) · 빈 값을 포함해 틀리면 invalid_input. */
export async function loadRequestTrace(searchParams: SearchParamsInput): Promise<RequestTraceView> {
  return inRequestScope(async () => {
    await requireSession();
    if (searchParams.request_id === undefined) return { requestId: null, trace: null, spans: null };
    const parsed = parseRequestTraceQuery(searchParams);
    if (!parsed.ok) return { requestId: null, trace: parsed, spans: null };
    return buildRequestTraceView(parsed.query);
  });
}

/** 데이터 경로용 — 세션이 없으면 401 · 입력이 없거나 틀리면 422 · 그 밖 200 {success:true,data:RequestTraceView}. no-store. */
export async function requestTraceResponse(request: Request): Promise<Response> {
  return inRequestScope(async () => {
    const session = await requireApiSession();
    if (session instanceof Response) return session;
    const parsed = parseRequestTraceQuery(searchParamsInputFromUrl(new URL(request.url)));
    if (!parsed.ok) return screenDataResponse(null, parsed);
    return screenDataResponse(await buildRequestTraceView(parsed.query), null);
  });
}
