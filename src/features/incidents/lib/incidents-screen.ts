/** 문제 화면의 조립(순수 — 설정은 options 로, 네트워크는 options.fetch, 시계는 options.now). 거부(reject)하지 않는다.
 *
 * 1단계(목록) — 네 호출을 **한꺼번에**(각 5초, 기존 클라이언트 그대로):
 *   알림 서버 `GET /monitors`(collectStatusOverview 의 감시 대상 칸과 같은 해석) · 관측 서버 `GET /metrics/latest`(createResourceMetricsClient) ·
 *   배포 마스터 `GET /deploys?limit=200`(createDeployHistoryClient, 서비스 거름 없음) ·
 *   관측 서버 `GET /logs?from=<now−10분>&to=<now>&level=error&limit=500`(createLogClient).
 *   → openIncidentsFrom. 설정이 빈 출처는 그 출처만 not_configured(호출 없음).
 * 2단계(incidentId 가 있을 때만) — 그 식별자가 목록에 있으면 buildIncidentEvidence → fitIncidentEvidence, 글은 incidentEvidenceText(맞춘 묶음).
 *   목록에 없으면: 그 종류의 출처가 실패했거나 오류 로그 문제인데 오류 로그가 상한(ERROR_LOG_COUNT_LIMIT)을 채웠으면(errorLogsTruncated — 빠진 서비스일 수 있다)
 *   { kind: "unchecked" }(열려 있는지 확인하지 못함), 아니면 { kind: "closed" }(지금 열려 있지 않음) — 2단계 호출 없음.
 * 호출 수: 목록 INCIDENT_LIST_CALLS + 근거 INCIDENT_EVIDENCE_MAXIMUM_CALLS 이하. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { createDeployGitClient, type DeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import { INCIDENT_DEPLOY_LOOKUP_LIMIT, ERROR_LOG_COUNT_LIMIT, ERROR_LOG_WINDOW_MILLISECONDS, openIncidentsFrom } from "@/features/incidents/lib/incident-list";
import type { IncidentList, IncidentSource, IncidentSources } from "@/features/incidents/lib/incident-list";
import { buildIncidentEvidence, type IncidentEvidence, type IncidentEvidenceDependencies } from "@/features/incidents/lib/incident-evidence";
import { fitIncidentEvidence, incidentEvidenceText } from "@/features/incidents/lib/incident-evidence-text";
import { incidentKindOfId, type IncidentKind } from "@/features/incidents/lib/incident-id";
import { createIncidentClient, type IncidentClient } from "@/features/log-trace/lib/incident-client";
import { collectTraceResources } from "@/features/log-trace/lib/trace-resources";
import { createLogClient, type LogClient } from "@/features/logs/lib/log-client";
import { createResourceMetricsClient } from "@/features/resources/lib/resource-metrics-client";
import { parseMonitors, type AlertMonitorsView } from "@/features/status/lib/status-overview";
import { getUpstream, isHttpBaseUrl, upstreamUrl } from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, upstreamFailure, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const INCIDENT_LIST_CALLS = 4;

export const SELECTED_INCIDENT_TEXT = {
  closed: "이 문제는 지금 열려 있지 않습니다",
  unchecked: "이 문제가 지금 열려 있는지 확인하지 못했습니다",
  toList: "문제 목록으로",
} as const;

export type SelectedIncident =
  | { kind: "evidence"; evidence: IncidentEvidence; text: string }
  | { kind: "closed"; incidentId: string }
  | { kind: "unchecked"; incidentId: string };

export interface IncidentsScreenData {
  /** 조회를 시작한 시각(ISO) */
  checkedAt: string;
  list: IncidentList;
  /** 식별자를 고르지 않았으면 null */
  selected: SelectedIncident | null;
}

export interface IncidentsScreenOptions {
  alertUrl: string;
  alertSecret: string;
  observeUrl: string;
  observeSecret: string;
  deployMasterUrl: string;
  deploySecret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
  now: () => number;
  /** 실패한 출처 · 칸마다 한 번(앱 로그용 — 칸 이름 · 실패). 없으면 남기지 않는다. */
  logFailure?: (cell: string, failure: UpstreamFailure) => void;
}

/** 문제의 종류 → 그 종류를 낸 출처(목록에 없을 때 닫힘 · 확인하지 못함을 가른다). */
const SOURCE_OF_KIND: Readonly<Record<IncidentKind, IncidentSource>> = {
  monitor_down: "monitors", deploy_failed: "deployments", resource_threshold: "thresholds", error_logs: "errorLogs",
};

const NOT_CONFIGURED = upstreamFailure("not_configured");

/** 설정의 주소 · 비밀값 쌍이 쓸 만한가(비었거나 http(s) 가 아니면 그 출처는 호출 없이 not_configured). */
function configured(baseUrl: string, secret: string): boolean {
  return isHttpBaseUrl(baseUrl) && secret.length > 0;
}

/** 거부하지 않게 — 뜻밖의 예외는 unparseable. */
function settled<Value>(work: () => Promise<UpstreamResult<Value>>): Promise<UpstreamResult<Value>> {
  return work().catch(() => upstreamFailure("unparseable"));
}

/** 알림 서버 `GET /monitors` — 상태 화면의 감시 대상 칸과 같은 해석(parseMonitors). */
async function fetchMonitors(options: IncidentsScreenOptions): Promise<UpstreamResult<AlertMonitorsView>> {
  const response = await getUpstream(upstreamUrl(options.alertUrl, "/monitors"), {
    fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers: { "X-Alert-Secret": options.alertSecret },
  });
  if (!response.ok) return response;
  if (response.status < 200 || response.status >= 300) return failureForHttpStatus(response.status);
  const view = parseMonitors(response);
  return view === null ? upstreamFailure("unparseable") : { ok: true, value: view };
}

/** 목록의 네 호출을 한꺼번에(각 5초). */
async function collectIncidentSources(options: IncidentsScreenOptions, nowMilliseconds: number): Promise<IncidentSources> {
  const client = { fetch: options.fetch, timeoutSignal: options.timeoutSignal };
  const observeConfigured = configured(options.observeUrl, options.observeSecret);
  const [monitors, latest, deployments, errorLogs] = await Promise.all([
    configured(options.alertUrl, options.alertSecret) ? settled(() => fetchMonitors(options)) : Promise.resolve(NOT_CONFIGURED),
    // 설정이 없으면 클라이언트가 호출 없이 not_configured 를 돌려준다
    settled(() => createResourceMetricsClient({ baseUrl: options.observeUrl, secret: options.observeSecret, ...client }).latest()),
    configured(options.deployMasterUrl, options.deploySecret)
      ? settled(() => createDeployHistoryClient({ baseUrl: options.deployMasterUrl, secret: options.deploySecret, ...client })
        .listDeployments({ service: null, limit: INCIDENT_DEPLOY_LOOKUP_LIMIT }))
      : Promise.resolve(NOT_CONFIGURED),
    observeConfigured
      ? settled(() => createLogClient({ baseUrl: options.observeUrl, secret: options.observeSecret, ...client }).searchLogs({
        from: new Date(nowMilliseconds - ERROR_LOG_WINDOW_MILLISECONDS).toISOString(), to: new Date(nowMilliseconds).toISOString(),
        service: null, level: "error", requestId: null, text: null, before: null, limit: ERROR_LOG_COUNT_LIMIT,
      }))
      : Promise.resolve(NOT_CONFIGURED),
  ]);
  return { monitors, latest, deployments, errorLogs };
}

/** 근거 묶음의 클라이언트 — 기존 클라이언트 그대로. 설정이 없는 출처는 호출 없이 not_configured. */
function evidenceDependencies(options: IncidentsScreenOptions): IncidentEvidenceDependencies {
  const client = { fetch: options.fetch, timeoutSignal: options.timeoutSignal };
  const alertRecords: IncidentClient = configured(options.alertUrl, options.alertSecret)
    ? createIncidentClient({ baseUrl: options.alertUrl, secret: options.alertSecret, ...client })
    : { listIncidents: async () => NOT_CONFIGURED };
  const logs: LogClient = configured(options.observeUrl, options.observeSecret)
    ? createLogClient({ baseUrl: options.observeUrl, secret: options.observeSecret, ...client })
    : { searchLogs: async () => NOT_CONFIGURED };
  const deployGit: DeployGitClient = configured(options.deployMasterUrl, options.deploySecret)
    ? createDeployGitClient({ baseUrl: options.deployMasterUrl, secret: options.deploySecret, ...client })
    : { listCommits: async () => NOT_CONFIGURED, getCommit: async () => NOT_CONFIGURED };
  return {
    alertRecords, logs, deployGit,
    traceResources: (service, atMilliseconds) => collectTraceResources({
      observeUrl: options.observeUrl, observeSecret: options.observeSecret, ...client, atMilliseconds, service: Promise.resolve(service),
    }),
  };
}

function logFailures(options: IncidentsScreenOptions, sources: IncidentSources, evidence: IncidentEvidence | null) {
  if (options.logFailure === undefined) return;
  const results: [string, UpstreamResult<unknown>][] = [
    ["monitors", sources.monitors], ["latest", sources.latest], ["deployments", sources.deployments], ["errorLogs", sources.errorLogs],
  ];
  for (const [cell, result] of results) if (!result.ok) options.logFailure(cell, result);
  if (evidence === null) return;
  const cells = [
    ["evidence:alertHistory", evidence.alertHistory], ["evidence:logs", evidence.logs], ["evidence:deployments", evidence.deployments], ["evidence:resources", evidence.resources],
  ] as const;
  for (const [cell, value] of cells) if (value.state === "failed") options.logFailure(cell, value.failure);
}

/** 2단계 — 고른 문제가 목록에 있으면 근거 묶음(맞춘 묶음과 그 글), 없으면 닫힘 · 확인하지 못함(호출 없음). */
async function selectedIncident(options: IncidentsScreenOptions, incidentId: string, list: IncidentList, sources: IncidentSources,
                                 nowMilliseconds: number): Promise<SelectedIncident> {
  const incident = list.incidents.find((candidate) => candidate.id === incidentId);
  if (incident === undefined) {
    const kind = incidentKindOfId(incidentId);
    const unchecked = kind !== null
      && (list.unchecked.some((failure) => failure.source === SOURCE_OF_KIND[kind]) || (kind === "error_logs" && list.errorLogsTruncated));
    return { kind: unchecked ? "unchecked" : "closed", incidentId };
  }
  const evidence = fitIncidentEvidence(await buildIncidentEvidence(evidenceDependencies(options), { incident, sources, nowMilliseconds }));
  return { kind: "evidence", evidence, text: incidentEvidenceText(evidence) };
}

export async function collectIncidentsScreen(options: IncidentsScreenOptions, incidentId: string | null): Promise<IncidentsScreenData> {
  const nowMilliseconds = options.now();
  const sources = await collectIncidentSources(options, nowMilliseconds);
  const list = openIncidentsFrom(sources);
  const selected = incidentId === null ? null : await selectedIncident(options, incidentId, list, sources, nowMilliseconds);
  logFailures(options, sources, selected?.kind === "evidence" ? selected.evidence : null);
  return { checkedAt: new Date(nowMilliseconds).toISOString(), list, selected };
}
