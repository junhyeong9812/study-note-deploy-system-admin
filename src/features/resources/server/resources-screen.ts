/** 서버 자원 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 OBSERVE_URL · OBSERVE_SECRET 을 읽는다(명세 §2.3 "어드민은 세션을 확인한 뒤에만 부르고").
 * 네트워크는 부를 때의 전역 fetch, 시계는 Date.now(). resourcesScreenFailures 의 칸마다 upstreamFailureLogLine("resources", <칸 이름>, 결과) 를
 * log(<그 요청의 추적 ID>, 줄, "warning") 로 1줄씩(주소 · 비밀값 없음).
 * - loadResourcesScreen(searchParams): 세션이 없으면 /login(다른 서버를 한 번도 부르지 않는다). 입력은 parseResourcesQuery(틀린 값은 기본값).
 * - resourcesScreenResponse(request): 세션이 없으면 401, 그 밖은 200 `{success:true,data:ResourcesScreen}`(no-store) — 입력은 요청 주소의 인자. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { collectResourcesScreen, resourcesScreenFailures, type ResourcesScreen } from "@/features/resources/lib/resources-screen";
import { parseResourcesQuery } from "@/features/resources/lib/resources-query";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";
import { currentRequestId } from "@/shared/lib/request-scope";
import { inRequestScope } from "@/shared/lib/request-id";

/** 세션 검증을 마친 뒤에만 부른다. */
async function buildResourcesScreen(searchParams: SearchParamsInput): Promise<ResourcesScreen> {
  const config = readServerConfig();
  const screen = await collectResourcesScreen({
    observeUrl: config.observeUrl, observeSecret: config.observeSecret, fetch: (input, init) => fetch(input, init),
    nowMilliseconds: Date.now(), query: parseResourcesQuery(searchParams),
  });
  for (const [cell, result] of resourcesScreenFailures(screen)) {
    const logLine = upstreamFailureLogLine("resources", cell, result);
    if (logLine !== null) void log(currentRequestId(), logLine, "warning");
  }
  return screen;
}

export async function loadResourcesScreen(searchParams: SearchParamsInput): Promise<ResourcesScreen> {
  return inRequestScope(async () => {
    await requireSession();
    return buildResourcesScreen(searchParams);
  });
}

export async function resourcesScreenResponse(request: Request): Promise<Response> {
  return inRequestScope(async () => {
    const session = await requireApiSession();
    if (session instanceof Response) return session;
    return screenDataResponse(await buildResourcesScreen(searchParamsInputFromUrl(new URL(request.url))), null);
  });
}
