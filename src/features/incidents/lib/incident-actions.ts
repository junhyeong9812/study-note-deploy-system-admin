/** 문제 하나의 조치 둘(되돌리기 · 다시 배포 — 명세 ⑫ §24)의 순수 판정. 뼈대: 상수 · 형만 — 함수는 구현 워커가 채운다. 계약: incident-actions.test.ts 머리 주석.
 * 조치는 ⑥ 의 확인 화면으로 넘어갈 뿐이다(새 접수 길 없음) — 판은 화면이 아니라 ⑥ 의 첫 걸음이 그 순간의 이력에서 다시 정한다. */
import type { AnalysisAction } from "@/features/incident-analysis/lib/analysis-answer";
import type { IncidentEvidence } from "@/features/incidents/lib/incident-evidence";
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import type { DeployService } from "@/features/deploys/lib/deploy-history-query";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

/** 조치의 종류 — 화면의 단추 차례(다시 배포 · 되돌리기). ⑥ 의 첫 걸음 주소의 `action` 값. */
export const INCIDENT_ACTION_KINDS = ["redeploy", "rollback"] as const;
export type IncidentActionKind = (typeof INCIDENT_ACTION_KINDS)[number];

export const INCIDENT_ACTION_LABELS: Readonly<Record<IncidentActionKind, string>> = { redeploy: "다시 배포", rollback: "되돌리기" };

export type IncidentActionServiceReason = "unmapped" | "not_deploy_service" | "services_not_found" | "several_services" | "services_unknown";

export type IncidentActionService = { ok: true; service: DeployService } | { ok: false; reason: IncidentActionServiceReason };

export type IncidentActionTargetReason = "history_unavailable" | "no_succeeded" | "single_succeeded" | "same_as_current";

export type IncidentActionTarget = { ok: true; commitSha: string } | { ok: false; reason: IncidentActionTargetReason };

/** 화면의 고정 글. */
export const INCIDENT_ACTION_TEXT = {
  title: "조치",
  recommended: "Claude 가 권함",
  actionsTitle: "이 문제에서 접수한 조치",
  noActions: "이 문제에서 접수한 조치가 없습니다",
  actionsUnavailable: "배포 이력을 읽지 못해 이 문제에서 접수한 조치를 보이지 못합니다",
  serviceReasons: {
    unmapped: "감시 대상이 대응 표에 없어 서비스를 정할 수 없습니다",
    not_deploy_service: "배포하는 서비스가 아니라 조치할 수 없습니다",
    services_not_found: "그 서버의 서비스를 찾지 못해 조치할 서비스를 정할 수 없습니다",
    several_services: "그 서버에 서비스가 둘 이상이라 조치할 서비스를 하나로 정할 수 없습니다",
    services_unknown: "그 서버의 서비스를 확인하지 못해 조치할 서비스를 정할 수 없습니다",
  } satisfies Record<IncidentActionServiceReason, string>,
  targetReasons: {
    history_unavailable: "배포 이력을 읽지 못했습니다",
    no_succeeded: "성공한 배포가 없습니다",
    single_succeeded: "성공한 배포가 하나뿐이라 되돌릴 판이 없습니다",
    same_as_current: "바로 앞의 성공한 배포가 지금과 같은 판입니다",
  } satisfies Record<IncidentActionTargetReason, string>,
} as const;

/** 문제의 근거에서 조치할 서비스 하나(DEPLOY_SERVICES 안) — 하나로 정할 수 없으면 까닭. */
export function incidentActionService(evidence: IncidentEvidence): IncidentActionService {
  void evidence;
  throw new Error("incidentActionService: 구현 전");
}

/** 그 서비스의 배포 이력(master 의 최신순)에서 조치마다의 판. */
export function incidentActionTargets(history: UpstreamResult<readonly DeploymentSummary[]>, service: DeployService): Record<IncidentActionKind, IncidentActionTarget> {
  void history; void service;
  throw new Error("incidentActionTargets: 구현 전");
}

/** 분석(12-4)의 권하는 조치 → 그 단추(정해진 낱말과 정확히 같을 때만). */
export function recommendedIncidentAction(action: AnalysisAction | null | undefined): IncidentActionKind | null {
  void action;
  throw new Error("recommendedIncidentAction: 구현 전");
}

/** 배포 이력에서 이 문제에서 접수한 것만(요청한 사람이 정확히 `admin:<계정>:incident:<이 ID>`). */
export function incidentActionDeployments(deployments: readonly DeploymentSummary[], incidentId: string): DeploymentSummary[] {
  void deployments; void incidentId;
  throw new Error("incidentActionDeployments: 구현 전");
}
