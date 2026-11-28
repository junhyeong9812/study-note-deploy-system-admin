/** 방문 기록 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 OBSERVE_URL · OBSERVE_SECRET · SITE_ORIGIN 을 읽는다(명세 §2 "어드민 조회는 로그인 뒤에만").
 * 네트워크는 부를 때의 전역 fetch. visitsScreenFailures 의 칸마다 upstreamFailureLogLine("visits", <칸 이름>, 결과) 를
 * log("screen-visits", 줄, "warning") 로 1줄씩(주소 · 비밀값 없음).
 * - loadVisitsScreen(searchParams): 세션이 없으면 /login(다른 서버를 한 번도 부르지 않는다). 입력은 parseVisitsQuery(틀린 값은 기본값 7).
 * - visitsScreenResponse(request): 세션이 없으면 401, 그 밖은 200 `{success:true,data:VisitsScreen}`(no-store) — 입력은 요청 주소의 인자. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { collectVisitsScreen, visitsScreenFailures, type VisitsScreen } from "@/features/visits/lib/visits-screen";
import { parseVisitsQuery } from "@/features/visits/lib/visits-query";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

/** 세션 검증을 마친 뒤에만 부른다. */
async function buildVisitsScreen(searchParams: SearchParamsInput): Promise<VisitsScreen> {
  const config = readServerConfig();
  const screen = await collectVisitsScreen({
    observeUrl: config.observeUrl, observeSecret: config.observeSecret, siteOrigin: config.siteOrigin,
    fetch: (input, init) => fetch(input, init), query: parseVisitsQuery(searchParams),
  });
  for (const [cell, result] of visitsScreenFailures(screen)) {
    const logLine = upstreamFailureLogLine("visits", cell, result);
    if (logLine !== null) void log("screen-visits", logLine, "warning");
  }
  return screen;
}

export async function loadVisitsScreen(searchParams: SearchParamsInput): Promise<VisitsScreen> {
  await requireSession();
  return buildVisitsScreen(searchParams);
}

export async function visitsScreenResponse(request: Request): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  return screenDataResponse(await buildVisitsScreen(searchParamsInputFromUrl(new URL(request.url))), null);
}
