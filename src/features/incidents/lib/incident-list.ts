/** 지금 열려 있는 문제의 목록(순수) — 네 출처의 조회 결과를 받아 목록으로. 명세 ⑫ §2 "열린 문제의 출처는 넷".
 *
 * 출처와 열려 있음의 기준:
 * - 감시 대상 DOWN(알림 서버 `GET /monitors`): status 가 DOWN 인 대상마다 하나. UNKNOWN · UP 은 아니다.
 *   service = serviceForMonitor(이름)(대응 표에 없으면 null). since = downSince.
 * - 자원 임계값(관측 서버 `GET /metrics/latest` 의 firing): 울리는 규칙마다 하나. latest 가 실패하거나 firing 칸이 없으면(null) 그 출처는 "확인하지 못함".
 *   since = firing.since. 심한 정도 = severity 가 critical 이면 위험, 그 밖(warning · 모르는 낱말)은 경고.
 * - 배포 실패(배포 마스터 `GET /deploys?limit=200`, 서비스 거름 없음 — 최신순): 서비스마다 **가장 최근**(목록에서 처음 나오는) 배포가 failed 일 때만 하나.
 *   그 뒤에 성공한 배포가 있으면(가장 최근이 succeeded) 열린 문제가 아니다. 가장 최근이 진행 중(accepted · ci_running · cd_running)이면 열린 문제가 아니다
 *   (다시 배포하는 중 — 그 결과를 기다린다. 그 앞의 실패도 문제로 치지 않는다). since = finishedAt ?? acceptedAt. 심한 정도 = 경고(마스터가 보내는 알림과 같다).
 * - 오류 로그(관측 서버 `GET /logs?level=error`, 최근 ERROR_LOG_WINDOW_MILLISECONDS, limit ERROR_LOG_COUNT_LIMIT): 줄의 service 마다 센 수가 0 보다 큰 서비스마다 하나.
 *   수만 보인다 — 급증 판정을 짓지 않는다("급증"이라는 낱말을 쓰지 않는다). 응답이 상한을 채웠으면(nextBefore 가 null 이 아님) 수는 "이상"(countIsLowerBound)이고
 *   목록 전체에 errorLogsTruncated — 일부 서비스는 빠졌을 수 있다. since = null(언제부터인지 모른다 — "최근 10분"). 심한 정도 = 경고.
 * 한 출처의 실패는 그 출처의 문제만 "확인하지 못함"으로(unchecked — 출처 순서 monitors · thresholds · deployments · errorLogs) — 다른 출처의 문제는 그대로 보인다.
 * 정렬: 위험 먼저 → since 가 이른 것 먼저(since 가 없으면 뒤) → 종류 순서(INCIDENT_KINDS) → 식별자의 글자 코드 순.
 * 확인한 범위(scopeNotes — 이 차례, 해당하는 것만 한 줄씩. 출처가 실패했으면 그 출처의 줄은 없다 — 확인하지 못함 줄이 이미 있다):
 * - 감시 대상 가운데 상태를 아직 모르는 것(UNKNOWN)이 N개면 `감시 대상 N개는 아직 상태를 모름`.
 * - 배포 이력이 상한(INCIDENT_DEPLOY_LOOKUP_LIMIT)을 채웠고 그 안에 한 번도 보이지 않은 서비스가 있으면
 *   `배포: 최근 200건 안에서만 확인 — <서비스들(DEPLOY_SERVICES 차례, ", ")> 은 확인하지 못함`(그 서비스의 실패는 목록에 나올 수 없다).
 * 빈 목록: 출처가 모두 성공이고 확인한 범위의 줄도 없으면 emptyText "열린 문제가 없습니다", 아니면 "확인된 범위에서는 열린 문제가 없습니다". 문제가 있으면 null. */
import type { AlertMonitorView, AlertMonitorsView } from "@/features/status/lib/status-overview";
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import { DEPLOY_SERVICES } from "@/features/deploys/lib/deploy-history-query";
import type { FiringRule, LatestResources } from "@/features/resources/lib/resource-metrics-client";
import type { LogPage } from "@/features/logs/lib/log-query";
import {
  INCIDENT_KINDS, deployIncidentId, errorLogsIncidentId, monitorIncidentId, resourceIncidentId, type IncidentKind,
} from "@/features/incidents/lib/incident-id";
import { serviceForMonitor } from "@/features/incidents/lib/monitor-services";
import { FIRING_RULE_LABELS, byCharacterCode } from "@/features/resources/lib/resources-screen";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

export const ERROR_LOG_WINDOW_MILLISECONDS = 10 * 60 * 1000;
export const ERROR_LOG_COUNT_LIMIT = 500;
/** 배포 마스터의 상한(master.go:345). */
export const INCIDENT_DEPLOY_LOOKUP_LIMIT = 200;

export const INCIDENT_KIND_LABELS: Readonly<Record<IncidentKind, string>> = {
  monitor_down: "감시 대상 DOWN", deploy_failed: "배포 실패", resource_threshold: "자원 임계값", error_logs: "오류 로그",
};

export const INCIDENT_SEVERITY_LABELS = { critical: "위험", warning: "경고" } as const;
export type IncidentSeverity = keyof typeof INCIDENT_SEVERITY_LABELS;

export const INCIDENT_SOURCES = ["monitors", "thresholds", "deployments", "errorLogs"] as const;
export type IncidentSource = (typeof INCIDENT_SOURCES)[number];

export const INCIDENT_SOURCE_LABELS: Readonly<Record<IncidentSource, string>> = {
  monitors: "알림 서버(감시 대상)", thresholds: "관측 서버(자원 임계값)", deployments: "배포 서버(배포 이력)", errorLogs: "관측 서버(오류 로그)",
};

export const INCIDENT_LIST_TEXT = {
  empty: "열린 문제가 없습니다",
  emptyWithinChecked: "확인된 범위에서는 열린 문제가 없습니다",
  /** firing 칸이 없을 때의 사유 */
  firingMissing: "임계값 칸 없음",
  errorLogsTruncated: "최근 10분의 오류가 500건을 넘어 일부 서비스만 셌습니다",
  errorLogsSince: "최근 10분",
} as const;

interface IncidentHeading {
  id: string;
  /** INCIDENT_KIND_LABELS[kind] */
  kindLabel: string;
  /** 대상 — 감시 대상 이름 · 서비스 · `서버 <서버> <규칙 이름>[ <대상>]` · 서비스 */
  target: string;
  severity: IncidentSeverity;
  /** INCIDENT_SEVERITY_LABELS[severity] */
  severityLabel: string;
  /** 언제부터(받은 글자) — 모르면 null */
  since: string | null;
}

export type OpenIncident =
  | (IncidentHeading & { kind: "monitor_down"; monitor: AlertMonitorView; service: string | null })
  | (IncidentHeading & { kind: "deploy_failed"; deployment: DeploymentSummary })
  | (IncidentHeading & { kind: "resource_threshold"; firing: FiringRule; ruleLabel: string })
  | (IncidentHeading & { kind: "error_logs"; service: string; errorCount: number; countIsLowerBound: boolean });

export interface IncidentSourceFailure {
  source: IncidentSource;
  /** INCIDENT_SOURCE_LABELS[source] */
  label: string;
  /** 실패의 고정 글자(UpstreamFailure.message) · firing 칸이 없으면 INCIDENT_LIST_TEXT.firingMissing */
  message: string;
  /** `${label}: 확인하지 못함 — ${message}` */
  text: string;
}

export interface IncidentList {
  incidents: OpenIncident[];
  unchecked: IncidentSourceFailure[];
  errorLogsTruncated: boolean;
  /** 목록이 확인한 범위의 줄(감시 대상 줄 · 배포 줄 차례 — 머리 주석) */
  scopeNotes: string[];
  emptyText: string | null;
}

export interface IncidentSources {
  monitors: UpstreamResult<AlertMonitorsView>;
  latest: UpstreamResult<LatestResources>;
  deployments: UpstreamResult<DeploymentSummary[]>;
  errorLogs: UpstreamResult<LogPage>;
}

function sourceFailure(source: IncidentSource, message: string): IncidentSourceFailure {
  const label = INCIDENT_SOURCE_LABELS[source];
  return { source, label, message, text: `${label}: 확인하지 못함 — ${message}` };
}

function heading(kind: IncidentKind, id: string, target: string, severity: IncidentSeverity, since: string | null): IncidentHeading {
  return { id, kindLabel: INCIDENT_KIND_LABELS[kind], target, severity, severityLabel: INCIDENT_SEVERITY_LABELS[severity], since };
}

function monitorIncidents(view: AlertMonitorsView): OpenIncident[] {
  return view.monitors.filter((monitor) => monitor.status === "DOWN").map((monitor: AlertMonitorView): OpenIncident => ({
    ...heading("monitor_down", monitorIncidentId(monitor.name), monitor.name, "critical", monitor.downSince),
    kind: "monitor_down", monitor, service: serviceForMonitor(monitor.name),
  }));
}

function thresholdIncidents(firing: FiringRule[]): OpenIncident[] {
  return firing.map((rule): OpenIncident => {
    const ruleLabel = Object.hasOwn(FIRING_RULE_LABELS, rule.rule) ? FIRING_RULE_LABELS[rule.rule] : rule.rule;
    const target = `서버 ${rule.server} ${ruleLabel}${rule.target === null ? "" : ` ${rule.target}`}`;
    const severity: IncidentSeverity = rule.severity === "critical" ? "critical" : "warning";
    return {
      ...heading("resource_threshold", resourceIncidentId(rule.server, rule.rule, rule.target), target, severity, rule.since),
      kind: "resource_threshold", firing: rule, ruleLabel,
    };
  });
}

/** 서비스마다 가장 최근(목록에서 처음 나오는) 배포만 본다 — 그것이 failed 일 때만 열린 문제(성공 · 진행 중이면 그 앞의 실패는 보지 않는다). */
function deployIncidents(deployments: DeploymentSummary[]): OpenIncident[] {
  const seen = new Set<string>();
  const incidents: OpenIncident[] = [];
  for (const deployment of deployments) {
    if (seen.has(deployment.service)) continue;
    seen.add(deployment.service);
    if (deployment.state !== "failed") continue;
    incidents.push({
      ...heading("deploy_failed", deployIncidentId(deployment.service, deployment.requestId), deployment.service, "warning", deployment.finishedAt ?? deployment.acceptedAt),
      kind: "deploy_failed", deployment,
    });
  }
  return incidents;
}

/** 확인한 범위의 줄 — 상태를 모르는 감시 대상 · 배포 이력 상한 안에 보이지 않은 서비스(성공한 출처만). */
function scopeNotesOf(sources: IncidentSources): string[] {
  const notes: string[] = [];
  if (sources.monitors.ok) {
    const unknownCount = sources.monitors.value.monitors.filter((monitor) => monitor.status === "UNKNOWN").length;
    if (unknownCount > 0) notes.push(`감시 대상 ${unknownCount}개는 아직 상태를 모름`);
  }
  if (sources.deployments.ok && sources.deployments.value.length >= INCIDENT_DEPLOY_LOOKUP_LIMIT) {
    const seen = new Set(sources.deployments.value.map((deployment) => deployment.service));
    const unseen = DEPLOY_SERVICES.filter((service) => !seen.has(service));
    if (unseen.length > 0) notes.push(`배포: 최근 ${INCIDENT_DEPLOY_LOOKUP_LIMIT}건 안에서만 확인 — ${unseen.join(", ")} 은 확인하지 못함`);
  }
  return notes;
}

function errorLogIncidents(page: LogPage): OpenIncident[] {
  const counts = new Map<string, number>();
  for (const line of page.logs) counts.set(line.service, (counts.get(line.service) ?? 0) + 1);
  const countIsLowerBound = page.nextBefore !== null;
  return [...counts].map(([service, errorCount]): OpenIncident => ({
    ...heading("error_logs", errorLogsIncidentId(service), service, "warning", null),
    kind: "error_logs", service, errorCount, countIsLowerBound,
  }));
}

/** 언제부터의 밀리초 — 모르거나 읽을 수 없으면 null(뒤로 간다). */
function sinceMilliseconds(incident: OpenIncident): number | null {
  if (incident.since === null) return null;
  const parsed = Date.parse(incident.since);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareIncidents(left: OpenIncident, right: OpenIncident): number {
  const severityOrder = Number(right.severity === "critical") - Number(left.severity === "critical");
  if (severityOrder !== 0) return severityOrder;
  const leftSince = sinceMilliseconds(left);
  const rightSince = sinceMilliseconds(right);
  if (leftSince !== rightSince) {
    if (leftSince === null) return 1;
    if (rightSince === null) return -1;
    return leftSince - rightSince;
  }
  return INCIDENT_KINDS.indexOf(left.kind) - INCIDENT_KINDS.indexOf(right.kind) || byCharacterCode(left.id, right.id);
}

export function openIncidentsFrom(sources: IncidentSources): IncidentList {
  const incidents: OpenIncident[] = [];
  const unchecked: IncidentSourceFailure[] = [];
  const collect = <Value>(source: IncidentSource, result: UpstreamResult<Value>, open: (value: Value) => OpenIncident[]) => {
    if (result.ok) incidents.push(...open(result.value));
    else unchecked.push(sourceFailure(source, result.message));
  };
  collect("monitors", sources.monitors, monitorIncidents);
  if (sources.latest.ok && sources.latest.value.firing === null) unchecked.push(sourceFailure("thresholds", INCIDENT_LIST_TEXT.firingMissing));
  else collect("thresholds", sources.latest, (latest) => thresholdIncidents(latest.firing ?? []));
  collect("deployments", sources.deployments, deployIncidents);
  collect("errorLogs", sources.errorLogs, errorLogIncidents);
  incidents.sort(compareIncidents);
  const scopeNotes = scopeNotesOf(sources);
  const emptyText = incidents.length > 0 ? null : unchecked.length === 0 && scopeNotes.length === 0 ? INCIDENT_LIST_TEXT.empty : INCIDENT_LIST_TEXT.emptyWithinChecked;
  return { incidents, unchecked, errorLogsTruncated: sources.errorLogs.ok && sources.errorLogs.value.nextBefore !== null, scopeNotes, emptyText };
}

/** 오류 수의 글 — `오류 N건` · 상한이면 `오류 N건 이상`. */
export function errorCountText(errorCount: number, countIsLowerBound: boolean): string {
  return `오류 ${errorCount}건${countIsLowerBound ? " 이상" : ""}`;
}
