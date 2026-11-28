/** 로그인 시도 기록 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 OBSERVE_URL · OBSERVE_SECRET 을 읽는다.
 * 목록과 잠금 상태를 **병렬**로 부르고 각각 5초 — 하나가 실패해도 다른 하나는 보인다. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createLoginAttemptsClient } from "@/features/login-attempts/lib/login-attempts-client";
import {
  nextLoginAttemptsPageQuery, parseLoginAttemptsQuery, type LockStatusView, type LoginAttemptsPage, type LoginAttemptsQuery,
} from "@/features/login-attempts/lib/login-attempts-query";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { invalidInputOf, screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import { upstreamFailure, type SearchParamsInput, type UpstreamResult } from "@/shared/lib/upstream-result";
import { currentRequestId } from "@/shared/lib/request-scope";
import { inRequestScope } from "@/shared/lib/request-id";

export interface LoginAttemptsScreenView {
  /** 입력이 틀렸으면 null — attempts 는 invalid_input(목록은 부르지 않는다). 잠금 상태는 입력과 무관하게 부른다. */
  query: LoginAttemptsQuery | null;
  attempts: UpstreamResult<LoginAttemptsPage>;
  lock: UpstreamResult<LockStatusView>;
  nextPageQuery: LoginAttemptsQuery | null;
}

async function buildLoginAttemptsView(searchParams: SearchParamsInput): Promise<LoginAttemptsScreenView> {
  const parsed = parseLoginAttemptsQuery(searchParams, Date.now());
  const config = readServerConfig();
  let attempts: UpstreamResult<LoginAttemptsPage>;
  let lock: UpstreamResult<LockStatusView>;
  if (!isHttpBaseUrl(config.observeUrl) || config.observeSecret.length === 0) {
    attempts = parsed.ok ? upstreamFailure("not_configured") : parsed;
    lock = upstreamFailure("not_configured");
  } else {
    const client = createLoginAttemptsClient({ baseUrl: config.observeUrl, secret: config.observeSecret, fetch: (input, init) => fetch(input, init) });
    [attempts, lock] = await Promise.all([parsed.ok ? client.listAttempts(parsed.query) : Promise.resolve(parsed), client.readLock()]);
  }
  for (const [cell, result] of [["attempts", attempts], ["lock", lock]] as const) {
    const logLine = upstreamFailureLogLine("login-attempts", cell, result);
    if (logLine !== null) void log(currentRequestId(), logLine, "warning");
  }
  const query = parsed.ok ? parsed.query : null;
  return { query, attempts, lock, nextPageQuery: query !== null && attempts.ok ? nextLoginAttemptsPageQuery(query, attempts.value) : null };
}

/** 화면용 — 세션이 없으면 /login(다른 서버를 부르지 않는다). */
export async function loadLoginAttempts(searchParams: SearchParamsInput): Promise<LoginAttemptsScreenView> {
  return inRequestScope(async () => {
    await requireSession();
    return buildLoginAttemptsView(searchParams);
  });
}

/** 데이터 경로용 — 세션이 없으면 401. 입력이 틀리면 422 `{success:false,error:{code:"invalid_input",field}}`(어떤 서버도 부르지 않는다), 그 밖은 200 `{success:true,data:LoginAttemptsScreenView}`. no-store. */
export async function loginAttemptsResponse(request: Request): Promise<Response> {
  return inRequestScope(async () => {
    const session = await requireApiSession();
    if (session instanceof Response) return session;
    const searchParams = searchParamsInputFromUrl(new URL(request.url));
    // 데이터 경로는 입력이 틀리면 422 만 — 잠금 상태도 부르지 않는다(화면은 입력과 무관하게 잠금 상태를 보인다)
    const parsed = parseLoginAttemptsQuery(searchParams, Date.now());
    if (!parsed.ok) return screenDataResponse(null, parsed);
    const view = await buildLoginAttemptsView(searchParams);
    return screenDataResponse(view, invalidInputOf(view.attempts));
  });
}
