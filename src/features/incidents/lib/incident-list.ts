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
 * 빈 목록: 출처가 모두 성공이면 emptyText "열린 문제가 없습니다", 하나라도 실패면 "확인된 범위에서는 열린 문제가 없습니다". 문제가 있으면 null. */
import type { AlertMonitorView, AlertMonitorsView } from "@/features/status/lib/status-overview";
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import type { FiringRule, LatestResources } from "@/features/resources/lib/resource-metrics-client";
import type { LogPage } from "@/features/logs/lib/log-query";
import type { IncidentKind } from "@/features/incidents/lib/incident-id";
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
  emptyText: string | null;
}

export interface IncidentSources {
  monitors: UpstreamResult<AlertMonitorsView>;
  latest: UpstreamResult<LatestResources>;
  deployments: UpstreamResult<DeploymentSummary[]>;
  errorLogs: UpstreamResult<LogPage>;
}

export function openIncidentsFrom(sources: IncidentSources): IncidentList {
  void sources;
  throw new Error("not implemented");
}

/** 오류 수의 글 — `오류 N건` · 상한이면 `오류 N건 이상`. */
export function errorCountText(errorCount: number, countIsLowerBound: boolean): string {
  void errorCount; void countIsLowerBound;
  throw new Error("not implemented");
}
