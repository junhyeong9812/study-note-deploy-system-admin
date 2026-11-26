/** 문제 하나의 조치 둘(되돌리기 · 다시 배포 — 명세 ⑫ §24)의 순수 판정. 계약: incident-actions.test.ts 머리 주석.
 * 조치는 ⑥ 의 확인 화면으로 넘어갈 뿐이다(새 접수 길 없음) — 판은 화면이 아니라 ⑥ 의 첫 걸음이 그 순간의 이력에서 다시 정한다. */
import type { AnalysisAction } from "@/features/incident-analysis/lib/analysis-answer";
import type { IncidentEvidence } from "@/features/incidents/lib/incident-evidence";
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import { DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
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

/** 요청한 사람의 계정 칸에 오는 글자(redeploy-requester 의 계정 꼴과 같다 — 콜론 없음). */
const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]+$/;
const REQUESTED_BY_PREFIX = "admin:";

function deployServiceOf(service: string | null): IncidentActionService {
  if (service === null) return { ok: false, reason: "unmapped" };
  return (DEPLOY_SERVICES as readonly string[]).includes(service) ? { ok: true, service: service as DeployService } : { ok: false, reason: "not_deploy_service" };
}

/** 문제의 근거에서 조치할 서비스 하나(DEPLOY_SERVICES 안) — 하나로 정할 수 없으면 까닭.
 * 자원 임계값은 근거의 로그 칸이 그 서버의 서비스로 찾은 것(12-1 — 컨테이너로 찾은 배포 서비스들)이 정확히 하나일 때만. */
export function incidentActionService(evidence: IncidentEvidence): IncidentActionService {
  const { incident } = evidence;
  switch (incident.kind) {
    case "monitor_down": return deployServiceOf(incident.service);
    case "deploy_failed": return deployServiceOf(incident.deployment.service);
    case "error_logs": return deployServiceOf(incident.service);
    case "resource_threshold": {
      const { logs } = evidence;
      if (logs.state === "services_not_found") return { ok: false, reason: "services_not_found" };
      if (logs.state !== "value" || logs.value.services === null) return { ok: false, reason: "services_unknown" };
      const { services } = logs.value;
      if (services.length === 0) return { ok: false, reason: "services_not_found" };
      if (services.length > 1) return { ok: false, reason: "several_services" };
      return deployServiceOf(services[0]);
    }
  }
}

/** 그 서비스의 배포 이력(master 의 최신순)에서 조치마다의 판 — ⑥ 의 버전 목록과 같은 규칙(그 서비스의 성공한 배포만 · 첫 줄이 지금 판).
 * 되돌리기는 지금 판의 바로 앞 성공 배포 — 그것이 지금과 같은 커밋이면 더 앞으로 건너가지 않고 까닭(같은 판을 두 번 올린 이력에서 엉뚱한 옛 판을 고르지 않게). */
export function incidentActionTargets(history: UpstreamResult<readonly DeploymentSummary[]>, service: DeployService): Record<IncidentActionKind, IncidentActionTarget> {
  if (!history.ok) return { redeploy: { ok: false, reason: "history_unavailable" }, rollback: { ok: false, reason: "history_unavailable" } };
  const succeeded = history.value.filter((deployment) => deployment.service === service && deployment.state === "succeeded");
  if (succeeded.length === 0) return { redeploy: { ok: false, reason: "no_succeeded" }, rollback: { ok: false, reason: "no_succeeded" } };
  const [current, previous] = succeeded;
  const redeploy: IncidentActionTarget = { ok: true, commitSha: current.commitSha };
  if (previous === undefined) return { redeploy, rollback: { ok: false, reason: "single_succeeded" } };
  if (previous.commitSha.toLowerCase() === current.commitSha.toLowerCase()) return { redeploy, rollback: { ok: false, reason: "same_as_current" } };
  return { redeploy, rollback: { ok: true, commitSha: previous.commitSha } };
}

/** 분석(12-4)의 권하는 조치 → 그 단추(정해진 낱말과 정확히 같을 때만). 표시일 뿐 — 단추의 주소에 실리지 않는다. */
export function recommendedIncidentAction(action: AnalysisAction | null | undefined): IncidentActionKind | null {
  return action === "rollback" || action === "redeploy" ? action : null;
}

/** 배포 이력에서 이 문제에서 접수한 것만(요청한 사람이 정확히 `admin:<계정>:incident:<이 ID>` — 계정은 콜론 없는 계정 꼴). 차례 그대로. */
export function incidentActionDeployments(deployments: readonly DeploymentSummary[], incidentId: string): DeploymentSummary[] {
  const suffix = `:incident:${incidentId}`;
  return deployments.filter(({ requestedBy }) => typeof requestedBy === "string" && requestedBy.startsWith(REQUESTED_BY_PREFIX) && requestedBy.endsWith(suffix)
    && ACCOUNT_PATTERN.test(requestedBy.slice(REQUESTED_BY_PREFIX.length, requestedBy.length - suffix.length)));
}

/** 문제 하나의 근거 화면에 보이는 조치 구역(명세 ⑫ §24). */
export interface IncidentActionsView {
  service: IncidentActionService;
  /** 서비스가 정해졌을 때만 — 조치마다의 판(링크의 글에만 보이고 주소에 싣지 않는다) */
  targets: Record<IncidentActionKind, IncidentActionTarget> | null;
  /** "Claude 가 권함" 의 조치(표시일 뿐) */
  recommended: IncidentActionKind | null;
  /** 이 문제에서 접수한 배포 — 배포 이력을 읽지 못했으면 ok: false */
  taken: { ok: true; deployments: DeploymentSummary[] } | { ok: false };
}

/** 근거 · 목록이 이미 읽은 배포 이력(모든 서비스 · 최신순) · 같은 발생의 가장 최근 분석의 권하는 조치 → 조치 구역. 새 호출 없음. */
export function incidentActionsView(evidence: IncidentEvidence, history: UpstreamResult<readonly DeploymentSummary[]>, recommendedAction: AnalysisAction | null): IncidentActionsView {
  const service = incidentActionService(evidence);
  return {
    service,
    targets: service.ok ? incidentActionTargets(history, service.service) : null,
    recommended: recommendedIncidentAction(recommendedAction),
    taken: history.ok ? { ok: true, deployments: incidentActionDeployments(history.value, evidence.incident.id) } : { ok: false },
  };
}
