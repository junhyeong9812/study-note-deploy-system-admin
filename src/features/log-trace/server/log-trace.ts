/** 연관 로그의 서버 쪽 진입 — 세션 검증을 **직접** 부른 뒤에만 입력을 해석하고 설정을 읽고 관측 서버 · master · 알림 서버를 부른다(명세 ② 세부 "인증 경계의 구현 형태" · §11.2).
 * 설정: OBSERVE_URL · OBSERVE_SECRET(logs) · DEPLOY_MASTER_URL · DEPLOY_SECRET(deployHistory) · ALERT_URL · ALERT_SECRET(incidents)
 * — 쌍 중 하나라도 비었거나 주소가 http(s) 로 해석되지 않으면 그 클라이언트는 null(그 칸 not_configured, 호출 없음). 네트워크 = 부를 때의 전역 fetch.
 * 실패한 칸은 앱 로그 1줄씩(upstreamFailureLogLine("log-trace", 칸 이름, 결과) — 이유 낱말 · 상태 코드만).
 * 응답(언제나 no-store):
 * - 세션 없음 → 401(requireApiSession — 다른 서버를 부르지 않는다)
 * - 입력 거절 → 422 `{success:false,error:{code:"invalid_input",field:"selected"}}`(다른 서버를 부르지 않는다)
 * - 고른 로그가 관측 서버에 없음 → 404 `{success:false,error:{code:"not_found"}}`
 * - 그 밖 → 200 `{success:true,data:LogTraceView}`(다른 서버의 실패는 칸의 결과로). */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import { createIncidentClient } from "@/features/log-trace/lib/incident-client";
import { parseLogTraceQuery, type LogTraceQuery } from "@/features/log-trace/lib/log-trace-query";
import { buildLogTrace, type LogTraceDependencies, type LogTraceOutcome } from "@/features/log-trace/lib/log-trace-view";
import { createLogClient } from "@/features/logs/lib/log-client";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { errorResponse } from "@/shared/lib/responses";
import { screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

/** 설정의 주소 · 비밀값 쌍이 쓸 만한가(비었거나 http(s) 가 아니면 그 출처는 null). */
function configured(baseUrl: string, secret: string): boolean {
  return isHttpBaseUrl(baseUrl) && secret.length > 0;
}

export function currentDependencies(): LogTraceDependencies {
  const config = readServerConfig();
  const networkFetch = (input: string, init: RequestInit) => fetch(input, init);
  return {
    logs: configured(config.observeUrl, config.observeSecret)
      ? createLogClient({ baseUrl: config.observeUrl, secret: config.observeSecret, fetch: networkFetch }) : null,
    deployHistory: configured(config.deployMasterUrl, config.deploySecret)
      ? createDeployHistoryClient({ baseUrl: config.deployMasterUrl, secret: config.deploySecret, fetch: networkFetch }) : null,
    incidents: configured(config.alertUrl, config.alertSecret)
      ? createIncidentClient({ baseUrl: config.alertUrl, secret: config.alertSecret, fetch: networkFetch }) : null,
  };
}

export function logFailedCells(outcome: LogTraceOutcome) {
  if (outcome.kind !== "view") return;
  const { view } = outcome;
  const cells = [
    ["selected", view.selected], ["requestSummary", view.requestSummary], ["relatedLogs", view.relatedLogs],
    ["levelCounts", view.serverState.levelCounts], ["deployments", view.serverState.deployments], ["incidents", view.serverState.incidents],
  ] as const;
  for (const [cell, result] of cells) {
    if (result === null) continue;
    const logLine = upstreamFailureLogLine("log-trace", cell, result);
    if (logLine !== null) void log("screen-log-trace", logLine, "warning");
  }
}

/** 세션 검증과 입력 검증을 마친 뒤에만 부른다. */
async function buildOutcome(query: LogTraceQuery): Promise<LogTraceOutcome> {
  const outcome = await buildLogTrace(currentDependencies(), query);
  logFailedCells(outcome);
  return outcome;
}

/** 화면용 — 세션이 없으면 requireSession 이 /login 으로 보낸다(다른 서버를 한 번도 부르지 않는다). 입력 거절은 { kind: "invalid_input", field }. */
export async function loadLogTrace(searchParams: SearchParamsInput): Promise<LogTraceOutcome> {
  await requireSession();
  const parsed = parseLogTraceQuery(searchParams);
  if (!parsed.ok) return { kind: "invalid_input", field: parsed.field ?? "" };
  return buildOutcome(parsed.query);
}

/** 데이터 경로용(Route Handler 의 GET 이 그대로 돌려준다). */
export async function logTraceResponse(request: Request): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  const parsed = parseLogTraceQuery(searchParamsInputFromUrl(new URL(request.url)));
  if (!parsed.ok) return screenDataResponse(null, parsed);
  const outcome = await buildOutcome(parsed.query);
  if (outcome.kind === "not_found") return errorResponse(404, "not_found");
  if (outcome.kind === "invalid_input") return errorResponse(422, "invalid_input", { field: outcome.field });
  return screenDataResponse(outcome.view, null);
}
