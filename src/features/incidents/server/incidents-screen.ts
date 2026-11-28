/** 문제 화면의 서버 쪽 진입 — 세션 검증을 **직접** 부른 뒤에만 입력을 해석하고 설정(ALERT_URL · ALERT_SECRET · OBSERVE_URL · OBSERVE_SECRET ·
 * DEPLOY_MASTER_URL · DEPLOY_SECRET)을 읽고 다른 서버를 부른다. 네트워크 = 부를 때의 전역 fetch, 시계 = Date.now.
 * 조치 구역의 "Claude 가 권함"은 분석의 저장소(latestAnalysisAction — 분석 설정이 없으면 권함 없음)에서.
 * 실패한 칸은 앱 로그 1줄씩(upstreamFailureLogLine("incidents", <칸>, 결과) → log(<그 요청의 추적 ID>, 줄, "warning") — 이유 낱말 · 상태 코드만).
 * 두 진입 모두 그 요청의 추적 ID 범위에서 돈다(⑬ T2g — 알림 · 관측 · 마스터로 가는 호출이 그 값 하나를 싣는다).
 * - loadIncidentsScreen(input): 세션이 없으면 /login(다른 서버를 한 번도 부르지 않는다). 입력이 틀리면 { kind: "invalid_input" }(호출 없음).
 * - incidentsScreenResponse(request): 세션 없음 401 · 입력 거절 422 `{success:false,error:{code:"invalid_input",field:"incident"}}`(호출 없음) ·
 *   그 밖 200 `{success:true,data:IncidentsScreenData}`(다른 서버의 실패는 칸의 결과로). 언제나 no-store. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { latestAnalysisAction } from "@/features/incident-analysis/server/incident-analysis";
import { parseIncidentsQuery } from "@/features/incidents/lib/incidents-query";
import { collectIncidentsScreen, type IncidentsScreenData } from "@/features/incidents/lib/incidents-screen";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { inRequestScope } from "@/shared/lib/request-id";
import { currentRequestId } from "@/shared/lib/request-scope";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export type IncidentsScreenOutcome =
  | { kind: "screen"; data: IncidentsScreenData }
  | { kind: "invalid_input"; field: string };

/** 세션 검증과 입력 검증을 마친 뒤에만 부른다. */
function buildIncidentsScreen(incidentId: string | null): Promise<IncidentsScreenData> {
  const config = readServerConfig();
  return collectIncidentsScreen({
    alertUrl: config.alertUrl, alertSecret: config.alertSecret, observeUrl: config.observeUrl, observeSecret: config.observeSecret,
    deployMasterUrl: config.deployMasterUrl, deploySecret: config.deploySecret,
    fetch: (input, init) => fetch(input, init), now: () => Date.now(), latestAnalysisAction,
    logFailure: (cell, failure) => {
      const logLine = upstreamFailureLogLine("incidents", cell, failure);
      if (logLine !== null) void log(currentRequestId(), logLine, "warning");
    },
  }, incidentId);
}

/** 화면용 — 세션이 없으면 requireSession 이 /login 으로 보낸다(다른 서버를 한 번도 부르지 않는다). 입력 거절은 { kind: "invalid_input", field }. */
export async function loadIncidentsScreen(input: SearchParamsInput): Promise<IncidentsScreenOutcome> {
  return inRequestScope(async () => {
    await requireSession();
    const parsed = parseIncidentsQuery(input);
    if (!parsed.ok) return { kind: "invalid_input", field: parsed.field ?? "" };
    return { kind: "screen", data: await buildIncidentsScreen(parsed.query.incidentId) };
  });
}

/** 데이터 경로용(Route Handler 의 GET 이 그대로 돌려준다). */
export async function incidentsScreenResponse(request: Request): Promise<Response> {
  return inRequestScope(async () => {
    const session = await requireApiSession();
    if (session instanceof Response) return session;
    const parsed = parseIncidentsQuery(searchParamsInputFromUrl(new URL(request.url)));
    if (!parsed.ok) return screenDataResponse(null, parsed);
    return screenDataResponse(await buildIncidentsScreen(parsed.query.incidentId), null);
  });
}
