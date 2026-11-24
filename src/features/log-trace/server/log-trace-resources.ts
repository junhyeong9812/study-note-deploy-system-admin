/** 연관 로그 + 그때 서버 자원의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 입력을 해석하고 설정을 읽는다(기존 loadLogTrace 와 같은 경계).
 * 기존 loadLogTrace · logTraceResponse 는 그대로 둔다(호출 수 · 응답 칸 그대로). 화면이 자원 칸을 함께 보이려면 이 진입을 쓴다.
 * 순서: 입력 거절이면 아무것도 부르지 않는다. 아니면 buildLogTrace(기존 그대로)와 collectTraceResources(atMilliseconds = query.selectedAtMilliseconds)를
 *   한꺼번에 시작한다 — service 는 고른 로그가 확인되는 대로(view.selected 가 성공이면 그 service, 실패 · not_found 면 null) 풀린다.
 *   (고른 로그 확인은 buildLogTrace 의 1단계 a 다 — 구현은 buildLogTrace 에 선택 인자로 그 결과를 알리는 길을 더해도 된다. 기존 호출 · 테스트의 꼴은 그대로.)
 * 설정: 기존 셋 + 같은 OBSERVE_URL · OBSERVE_SECRET(자원). 자원 칸의 실패는 upstreamFailureLogLine("log-trace", "resources:<location|host|container>", 결과) 1줄씩.
 * - loadLogTraceWithResources(searchParams): 세션이 없으면 /login. { outcome, resources }(outcome 은 loadLogTrace 와 같은 값, view 가 아니면 resources 는 null).
 * - logTraceWithResourcesResponse(request): 401 · 422 · 404 는 logTraceResponse 와 같은 본문, 그 밖은 200 `{success:true,data:{trace:LogTraceView, resources:TraceResourcesView|null}}`. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import { createIncidentClient } from "@/features/log-trace/lib/incident-client";
import { parseLogTraceQuery, type LogTraceQuery } from "@/features/log-trace/lib/log-trace-query";
import { buildLogTrace, type LogTraceDependencies, type LogTraceOutcome } from "@/features/log-trace/lib/log-trace-view";
import { collectTraceResources, type TraceResourcesView } from "@/features/log-trace/lib/trace-resources";
import { createLogClient } from "@/features/logs/lib/log-client";
import { readServerConfig, type ServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { errorResponse } from "@/shared/lib/responses";
import { screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import type { SearchParamsInput, UpstreamResult } from "@/shared/lib/upstream-result";

export interface LogTraceWithResources {
  outcome: LogTraceOutcome;
  resources: TraceResourcesView | null;
}

// 단순화: 아래 configured · dependenciesOf · logFailedCells 는 server/log-trace.ts 의 configured · currentDependencies · logFailedCells 와 같은 내용이다
//   (그 파일은 이번 범위 밖이라 내보내지 못했다). 그 파일을 고칠 수 있게 되면 그쪽 것을 내보내 이 사본을 지운다.
function configured(baseUrl: string, secret: string): boolean {
  return isHttpBaseUrl(baseUrl) && secret.length > 0;
}

function dependenciesOf(config: ServerConfig, networkFetch: (input: string, init: RequestInit) => Promise<Response>): LogTraceDependencies {
  return {
    logs: configured(config.observeUrl, config.observeSecret)
      ? createLogClient({ baseUrl: config.observeUrl, secret: config.observeSecret, fetch: networkFetch }) : null,
    deployHistory: configured(config.deployMasterUrl, config.deploySecret)
      ? createDeployHistoryClient({ baseUrl: config.deployMasterUrl, secret: config.deploySecret, fetch: networkFetch }) : null,
    incidents: configured(config.alertUrl, config.alertSecret)
      ? createIncidentClient({ baseUrl: config.alertUrl, secret: config.alertSecret, fetch: networkFetch }) : null,
  };
}

function logFailedCells(outcome: LogTraceOutcome, resources: TraceResourcesView | null) {
  if (outcome.kind !== "view") return;
  const { view } = outcome;
  const cells: [string, UpstreamResult<unknown> | null][] = [
    ["selected", view.selected], ["requestSummary", view.requestSummary], ["relatedLogs", view.relatedLogs],
    ["levelCounts", view.serverState.levelCounts], ["deployments", view.serverState.deployments], ["incidents", view.serverState.incidents],
  ];
  if (resources !== null) {
    cells.push(["resources:location", resources.location], ["resources:host", resources.host], ["resources:container", resources.container]);
  }
  for (const [cell, result] of cells) {
    if (result === null) continue;
    const logLine = upstreamFailureLogLine("log-trace", cell, result);
    if (logLine !== null) void log("screen-log-trace", logLine, "warning");
  }
}

/** 세션 검증과 입력 검증을 마친 뒤에만 부른다. 연관 로그와 자원 칸을 한꺼번에 시작한다 — 자원 칸은 고른 로그가 확인되는 대로 서비스를 받는다. */
async function buildWithResources(query: LogTraceQuery): Promise<LogTraceWithResources> {
  const config = readServerConfig();
  const networkFetch = (input: string, init: RequestInit) => fetch(input, init);
  let settleService: (service: string | null) => void = () => undefined;
  const service = new Promise<string | null>((resolve) => { settleService = resolve; });
  const outcomePromise = buildLogTrace(dependenciesOf(config, networkFetch), query, settleService)
    .finally(() => settleService(null));   // 알리기 전에 끝나는 일이 있어도 자원 칸이 서비스를 영영 기다리지 않게(이미 풀렸으면 아무 일도 없다)
  const resourcesPromise = collectTraceResources({
    observeUrl: config.observeUrl, observeSecret: config.observeSecret, fetch: networkFetch, atMilliseconds: query.selectedAtMilliseconds, service,
  });
  const [outcome, collected] = await Promise.all([outcomePromise, resourcesPromise]);
  const resources = outcome.kind === "view" ? collected : null;
  logFailedCells(outcome, resources);
  return { outcome, resources };
}

export async function loadLogTraceWithResources(searchParams: SearchParamsInput): Promise<LogTraceWithResources> {
  await requireSession();
  const parsed = parseLogTraceQuery(searchParams);
  if (!parsed.ok) return { outcome: { kind: "invalid_input", field: parsed.field ?? "" }, resources: null };
  return buildWithResources(parsed.query);
}

export async function logTraceWithResourcesResponse(request: Request): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  const parsed = parseLogTraceQuery(searchParamsInputFromUrl(new URL(request.url)));
  if (!parsed.ok) return screenDataResponse(null, parsed);
  const { outcome, resources } = await buildWithResources(parsed.query);
  if (outcome.kind === "not_found") return errorResponse(404, "not_found");
  if (outcome.kind === "invalid_input") return errorResponse(422, "invalid_input", { field: outcome.field });
  return screenDataResponse({ trace: outcome.view, resources }, null);
}
