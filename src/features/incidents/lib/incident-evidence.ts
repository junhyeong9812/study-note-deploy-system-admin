/** 문제 하나의 근거 묶음(순수 — 클라이언트는 주입, 거부(reject)하지 않는다). 지금 있는 조회만 다시 쓴다(새 조회 경로 없음).
 * 입력: 고른 문제(목록의 것) · 목록을 만든 네 출처의 결과(sources — 배포 이력 · latest 를 다시 부르지 않는다) · 지금 시각.
 * 칸 다섯: 무엇이 · 언제부터(facts) · 관련 알림(alertHistory) · 로그(logs) · 배포(deployments) · 자원(resources).
 * 칸마다 따로 실패한다 — 한 칸의 조회가 실패해도 다른 칸은 값이 있다. 칸들의 호출은 **한꺼번에** 시작한다(서로 기다리지 않는다).
 *
 * 무엇이 · 언제부터(facts — { label, value } 순서 고정, 시각은 받은 글자 그대로):
 * - 감시 대상 DOWN: 대상 · 상태("DOWN") · 이유(없으면 "—") · DOWN 시각(없으면 "모름") · 서비스(대응 표에 없으면 "대응 표에 없음").
 * - 배포 실패: 서비스 · 커밋 · 요청 ID · 실패 단계(`<낱말>(<이름>)` — failedStageLabel, 이름이 없으면 낱말만, 없으면 "—") · 접수 시각 · 끝난 시각(없으면 "—").
 *   (마스터 이력의 detail — 출력 끝부분 — 은 어드민의 배포 이력 클라이언트가 넘기지 않으므로 이번 조각에서는 싣지 않는다.)
 * - 자원 임계값: 서버 · 규칙(이름) · 대상(없으면 "—") · 심각도(이름) · 값(disk_warning · disk_critical · memory · cpu 는 formatPercent, 그 밖은 수 그대로, 없으면 "없음") · 언제부터.
 * - 오류 로그: 서비스 · 최근 10분의 오류 수(errorCountText).
 *
 * 기준 시각 T: 감시 대상 DOWN = downSince(없으면 now) · 배포 실패 = finishedAt ?? acceptedAt · 자원 임계값 = firing.since · 오류 로그 = now.
 * 시각 글자는 `new Date(밀리초).toISOString()`(밀리초 3자리, Z).
 *
 * 관련 알림(알림 서버 `GET /incidents?limit=200` 한 번 — 최신 기록부터. 거를 질의가 없어 받은 200건 안에서 거른다):
 * - 감시 대상 DOWN: kind 가 `monitor_` 로 시작하고 key 를 `,` 로 나눈 것 중 하나가 대상 이름과 같은 기록, at ∈ [T − 1시간, T + 1시간].
 * - 배포 실패: key 가 `deploy-failed:<서비스>:<커밋>`(마스터가 보내는 key) 인 기록, at ∈ [acceptedAt, (finishedAt ?? acceptedAt) + 10분].
 * - 자원 임계값: key 가 `resource:<서버>:<규칙>[:<대상>]`(관측 서버의 key — 대상이 있는 규칙이면 대상까지) 이거나 그 뒤에 `:resolved` 가 붙은 기록, at ∈ [since − 1시간, now].
 * - 오류 로그: 해당 없음(not_applicable — 이 문제에는 알림이 없다).
 * 양끝 포함. 알림 서버 순서 그대로. coversWindow = 받은 기록이 200건 미만이거나 가장 이른 at < from(아니면 200건이 창의 앞쪽에 닿지 못했다 — 화면 · 글에 드러낸다).
 *
 * 로그(관측 서버 `GET /logs`, 각 limit 500):
 * - 감시 대상 DOWN: 그 서비스의 warning · error 두 번, [T − 10분, T + 10분]. 대응 표에 없는 대상이면 unmapped(부르지 않는다).
 * - 배포 실패: request_id = 그 배포의 요청 ID 한 번(수준 거름 없음 — 그 요청으로 묶은 모든 줄), [acceptedAt − 10분, (finishedAt ?? acceptedAt) + 10분].
 *   받은 줄 가운데 requestId 가 그 요청 ID 와 같은 줄만 남긴다(다른 요청의 줄을 섞지 않는다).
 * - 자원 임계값: warning · error 두 번(서비스 거름 없음), [T − 10분, T + 10분] → 그 서버의 서비스들의 줄만 남긴다. 그 서버의 서비스 = DEPLOY_SERVICES 가운데
 *   sources.latest 의 그 서버 컨테이너(계열 이름)에 containerBelongsToService 가 참인 것(DEPLOY_SERVICES 순서). services 에 그 이름들.
 *   그 서버의 서비스를 하나도 찾지 못하면(서버가 latest 에 없음 · 컨테이너 목록이 빔 · 배포 서비스의 컨테이너가 없음) 칸은 services_not_found
 *   (EVIDENCE_TEXT.servicesNotFound — "없음"이라고 말하지 않는다, 부르지 않는다).
 * - 오류 로그: 그 서비스의 error 한 번, [now − 10분, now].
 * 두 번 부르는 칸은 하나라도 실패면 칸 전체가 그 실패(warning 쪽을 먼저 본다). 받은 줄을 합쳐 최신 EVIDENCE_LOG_LINE_LIMIT 줄만 남기고 시간순(옛것부터)으로 —
 * 합친 줄이 상한을 넘거나 어느 응답이 limit 을 채웠으면(nextBefore 가 null 이 아님) truncated true, noticeText `최근 ${EVIDENCE_LOG_LINE_LIMIT}줄만 보입니다 — 더 있음`.
 * 조용히 자르지 않는다. 줄마다 href = 로그 화면의 그 줄(logsHref({ service: 줄의 service, from · to: 칸의 창, 나머지 null, limit 기본 }, 줄의 id)).
 *
 * 배포:
 * - 배포 실패: 범위(findDeployRange(sources.deployments, 요청 ID)) — range 면 master git `GET /deploys/git/commits` 한 번(서비스 · A · B),
 *   no_previous(앞 성공 배포가 받은 200건 안에 없음) · same_commit 이면 부르지 않고 커밋 없음. detailHref = 배포 이력 화면의 그 배포(deploysHref).
 * - 그 밖: 창 [T − 1시간, T] 에 acceptedAt 이 드는 배포(모든 서비스 — sources.deployments 를 다시 거른다, 호출 없음). coversWindow = 받은 목록이 200건 미만이거나
 *   가장 오래된 항목의 acceptedAt < from. 배포 이력이 실패였으면 이 칸도 그 실패.
 *
 * 자원:
 * - 감시 대상 DOWN(서비스를 알 때) · 배포 실패 · 오류 로그: 그 서비스가 T 에 있던 서버의 그때 값 — 로그 추적의 자원 칸(collectTraceResources)을 그대로 쓴다
 *   (서비스의 컨테이너가 그때 보인 서버를 관측 서버에 물어 고른다 — 서버를 짐작하지 않는다). location 이 실패면 칸 전체가 그 실패.
 *   대응 표에 없는 감시 대상이면 unmapped(부르지 않는다).
 * - 자원 임계값: 그 서버의 지금 값(sources.latest 의 그 서버 — CPU · 메모리 · 디스크 글자) + 서버 자원 화면의 그 서버로 가는 링크(그래프는 거기서). 호출 없음.
 *
 * 호출 수의 상한(이 함수 — 목록의 네 호출은 따로): 알림 1 + 로그 2 + 커밋 1 + 자원(TRACE_RESOURCE_MAXIMUM_CALLS) 가운데 그 종류가 쓰는 것 —
 * 어느 종류든 INCIDENT_EVIDENCE_MAXIMUM_CALLS 이하. 각 호출은 5초 기한(클라이언트의 것), 자원 칸은 전체 8초 상한(collectTraceResources 의 것). */
import type { IncidentClient, IncidentSummary } from "@/features/log-trace/lib/incident-client";
import { TRACE_RESOURCE_MAXIMUM_CALLS, containerBelongsToService, type TraceResourcesView } from "@/features/log-trace/lib/trace-resources";
import type { LogClient } from "@/features/logs/lib/log-client";
import { LOG_QUERY_DEFAULT_LIMIT, type LogEntryView, type LogLevel, type LogPage, type LogQuery } from "@/features/logs/lib/log-query";
import { logsHref } from "@/features/logs/ui/logs-address";
import type { DeployGitClient, GitCommit, GitRelation } from "@/features/deploy-detail/lib/deploy-git-client";
import { findDeployRange, type DeployRangeStatus } from "@/features/deploy-detail/lib/deploy-range";
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import { failedStageLabel } from "@/features/deploys/lib/deploy-format";
import { DEPLOY_HISTORY_DEFAULT_LIMIT, DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import { deploysHref } from "@/features/deploys/ui/deploys-address";
import { INCIDENT_DEPLOY_LOOKUP_LIMIT, errorCountText, type IncidentSources, type OpenIncident } from "@/features/incidents/lib/incident-list";
import type { LatestResources } from "@/features/resources/lib/resource-metrics-client";
import { RESOURCE_NO_VALUE_TEXT, formatPercent } from "@/features/resources/lib/resource-format";
import { resourcesHref } from "@/features/resources/lib/resources-query";
import { FIRING_SEVERITY_LABELS, currentReadings, serverFiringOf } from "@/features/resources/lib/resources-screen";
import { STATUS_RESOURCE_ANCHOR_PREFIX } from "@/features/status/lib/status-resources";
import { parseIsoUtc } from "@/shared/lib/query-input";
import { upstreamFailure, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const EVIDENCE_LOG_LINE_LIMIT = 100;
export const EVIDENCE_LOG_FETCH_LIMIT = 500;
export const EVIDENCE_LOG_WINDOW_MILLISECONDS = 10 * 60 * 1000;
export const EVIDENCE_ALERT_WINDOW_MILLISECONDS = 60 * 60 * 1000;
export const EVIDENCE_DEPLOY_WINDOW_MILLISECONDS = 60 * 60 * 1000;
/** 배포 실패의 알림 · 로그 창이 끝난 시각 뒤로 더 보는 길이 */
export const EVIDENCE_AFTER_DEPLOY_MILLISECONDS = 10 * 60 * 1000;
export const EVIDENCE_ALERT_LOOKUP_LIMIT = 200;
/** 근거 묶음 하나에 나가는 호출의 상한(목록의 네 호출 제외) — 알림 1 + 로그 2 + 자원 칸. 배포 실패는 알림 1 + 로그 1 + 커밋 1 + 자원 칸. */
export const INCIDENT_EVIDENCE_MAXIMUM_CALLS = 3 + TRACE_RESOURCE_MAXIMUM_CALLS;

/** 칸 제목(화면 · 글이 같은 낱말을 쓴다). */
export const EVIDENCE_SECTION_TITLES = {
  facts: "무엇이 · 언제부터",
  alertHistory: "관련 알림",
  logs: "로그",
  deployments: "배포",
  resources: "자원",
} as const;
export type EvidenceSection = keyof typeof EVIDENCE_SECTION_TITLES;

export const EVIDENCE_TEXT = {
  /** `${failed}${message}` — 예: "확인하지 못함 — 닿지 않음" */
  failed: "확인하지 못함 — ",
  unmapped: "확인할 수 없음 — 대응 표에 없음",
  notApplicable: "해당 없음",
  alertNotCovered: "알림 기록 최근 200건이 이 창의 앞쪽까지 닿지 않습니다",
  deployNotCovered: "배포 이력 최근 200건이 이 창의 앞쪽까지 닿지 않습니다",
  noPreviousDeploy: "앞 성공 배포가 배포 이력 최근 200건 안에 없습니다",
  sameCommit: "앞 성공 배포와 같은 커밋입니다",
  noRecords: "없음",
  servicesNotFound: "확인할 수 없음 — 그 서버의 서비스를 찾지 못함",
} as const;

export type EvidenceCell<Value> =
  | { state: "value"; value: Value }
  | { state: "failed"; failure: UpstreamFailure }
  | { state: "unmapped" }
  | { state: "services_not_found" }
  | { state: "not_applicable" };

export interface EvidenceFact {
  label: string;
  value: string;
}

export interface AlertHistoryView {
  from: string;
  to: string;
  /** 알림 서버 순서 그대로(최신 기록부터) — key · title 은 가린 값(incident-client) */
  records: IncidentSummary[];
  coversWindow: boolean;
}

export interface EvidenceLogLine extends LogEntryView {
  /** 로그 화면의 그 줄 */
  href: string;
}

export interface EvidenceLogsView {
  /** levels = warning · error 만 · request = 그 요청 ID 의 모든 줄 · errors = error 만 */
  scope: "levels" | "request" | "errors";
  from: string;
  to: string;
  /** 서비스 거름 — 감시 대상 · 오류 로그는 [그 서비스], 자원 임계값은 그 서버의 서비스들, 배포 실패는 null(요청 ID 로 거름) */
  services: string[] | null;
  requestId: string | null;
  /** 시간순(옛것부터), 최대 EVIDENCE_LOG_LINE_LIMIT 줄 */
  lines: EvidenceLogLine[];
  truncated: boolean;
  noticeText: string | null;
}

export interface EvidenceDeployment extends DeploymentSummary {
  /** 배포 이력 화면의 그 배포(상세) */
  href: string;
}

export type EvidenceDeploymentsView =
  | { kind: "window"; from: string; to: string; deployments: EvidenceDeployment[]; coversWindow: boolean }
  | {
    kind: "range"; status: DeployRangeStatus; baseRequestId: string | null; baseCommitSha: string | null; headCommitSha: string;
    /** master 순서 그대로(B 쪽이 먼저) */
    commits: GitCommit[]; truncated: boolean; relation: GitRelation | null;
    /** 배포 이력 화면의 그 배포(상세 — 커밋 · 파일별 변경은 거기서) */
    detailHref: string;
  };

export type EvidenceResourcesView =
  | { kind: "trace"; trace: TraceResourcesView }
  | {
    kind: "server"; server: string;
    /** 그 서버가 latest 에 없으면 false(값은 "없음") */
    found: boolean;
    cpuText: string; memoryText: string; diskText: string;
    receivedAt: string | null;
    /** 서버 자원 화면의 그 서버(`/resources?range=1h#resource-server-<서버>`) */
    resourcesHref: string;
  };

export interface IncidentEvidence {
  incident: OpenIncident;
  facts: EvidenceFact[];
  alertHistory: EvidenceCell<AlertHistoryView>;
  logs: EvidenceCell<EvidenceLogsView>;
  deployments: EvidenceCell<EvidenceDeploymentsView>;
  resources: EvidenceCell<EvidenceResourcesView>;
  /** 크기 상한 때문에 줄인 것(fitIncidentEvidence 가 채운다 — 처음에는 []) */
  reductions: string[];
  /** 크기 상한 때문에 글에 싣는 값 하나를 이 길이(코드 포인트)까지로(fitIncidentEvidence 가 채운다 — 없으면 자르지 않는다) */
  valueMaximumLength?: number;
  /** 크기 상한 때문에 글을 이 바이트(UTF-8)에 맞춰 끝을 자른다 — "줄인 것" 구역은 남긴다(fitIncidentEvidence 가 채운다 — 없으면 자르지 않는다) */
  textMaximumBytes?: number;
}

export interface IncidentEvidenceDependencies {
  alertRecords: IncidentClient;
  logs: LogClient;
  deployGit: DeployGitClient;
  /** 서비스가 T 에 있던 서버의 그때 값(collectTraceResources 를 감싼 것) */
  traceResources: (service: string, atMilliseconds: number) => Promise<TraceResourcesView | null>;
}

export interface IncidentEvidenceInput {
  incident: OpenIncident;
  sources: IncidentSources;
  nowMilliseconds: number;
}

/** 칸이 실패 · 대응 없음 · 해당 없음일 때의 글 — failed 는 `확인하지 못함 — <message>`. value 면 null. */
export function evidenceCellNotice(cell: EvidenceCell<unknown>): string | null {
  switch (cell.state) {
    case "value": return null;
    case "failed": return `${EVIDENCE_TEXT.failed}${cell.failure.message}`;
    case "unmapped": return EVIDENCE_TEXT.unmapped;
    case "services_not_found": return EVIDENCE_TEXT.servicesNotFound;
    case "not_applicable": return EVIDENCE_TEXT.notApplicable;
  }
}

/** 값이 퍼센트인 규칙(그 밖은 받은 수 그대로). */
const PERCENT_RULES: ReadonlySet<string> = new Set(["disk_warning", "disk_critical", "memory", "cpu"]);
const NOT_GIVEN_TEXT = "—";

function isoText(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

/** 다른 서버가 준 시각 글자 → 밀리초(Java Instant 의 소수 9자리까지 — 읽을 수 없으면 NaN). */
function instantMilliseconds(text: string): number {
  return parseIsoUtc(text) ?? Date.parse(text);
}

function within(text: string, fromMilliseconds: number, toMilliseconds: number): boolean {
  const at = instantMilliseconds(text);
  return at >= fromMilliseconds && at <= toMilliseconds;
}

function failedCell(failure: UpstreamFailure): EvidenceCell<never> {
  return { state: "failed", failure };
}

/** 칸 하나를 거부하지 않게 — 뜻밖의 예외는 그 칸만 unparseable. */
function settledCell<Value>(work: () => Promise<EvidenceCell<Value>>): Promise<EvidenceCell<Value>> {
  return work().catch(() => failedCell(upstreamFailure("unparseable")));
}

/** 기준 시각 T(밀리초). */
function referenceMilliseconds(incident: OpenIncident, nowMilliseconds: number): number {
  switch (incident.kind) {
    case "monitor_down": {
      const downSince = incident.monitor.downSince === null ? Number.NaN : instantMilliseconds(incident.monitor.downSince);
      return Number.isNaN(downSince) ? nowMilliseconds : downSince;
    }
    case "deploy_failed": return instantMilliseconds(incident.deployment.finishedAt ?? incident.deployment.acceptedAt);
    case "resource_threshold": return instantMilliseconds(incident.firing.since);
    case "error_logs": return nowMilliseconds;
  }
}

function factsOf(incident: OpenIncident): EvidenceFact[] {
  switch (incident.kind) {
    case "monitor_down": return [
      { label: "대상", value: incident.monitor.name }, { label: "상태", value: incident.monitor.status },
      { label: "이유", value: incident.monitor.reason === "" ? NOT_GIVEN_TEXT : incident.monitor.reason },
      { label: "DOWN 시각", value: incident.monitor.downSince ?? "모름" }, { label: "서비스", value: incident.service ?? "대응 표에 없음" },
    ];
    case "deploy_failed": {
      const { deployment } = incident;
      const stage = deployment.failedStage;
      const stageLabel = stage === null ? null : failedStageLabel(stage);
      return [
        { label: "서비스", value: deployment.service }, { label: "커밋", value: deployment.commitSha }, { label: "요청 ID", value: deployment.requestId },
        { label: "실패 단계", value: stage === null ? NOT_GIVEN_TEXT : stageLabel === null ? stage : `${stage}(${stageLabel})` },
        { label: "접수 시각", value: deployment.acceptedAt }, { label: "끝난 시각", value: deployment.finishedAt ?? NOT_GIVEN_TEXT },
      ];
    }
    case "resource_threshold": {
      const { firing } = incident;
      const value = PERCENT_RULES.has(firing.rule) ? formatPercent(firing.lastValue) : firing.lastValue === null ? RESOURCE_NO_VALUE_TEXT : String(firing.lastValue);
      return [
        { label: "서버", value: firing.server }, { label: "규칙", value: incident.ruleLabel }, { label: "대상", value: firing.target ?? NOT_GIVEN_TEXT },
        { label: "심각도", value: Object.hasOwn(FIRING_SEVERITY_LABELS, firing.severity) ? FIRING_SEVERITY_LABELS[firing.severity] : firing.severity },
        { label: "값", value }, { label: "언제부터", value: firing.since },
      ];
    }
    case "error_logs": return [
      { label: "서비스", value: incident.service }, { label: "최근 10분의 오류 수", value: errorCountText(incident.errorCount, incident.countIsLowerBound) },
    ];
  }
}

// ── 관련 알림 ──────────────────────────────────────────────

interface AlertFilter {
  fromMilliseconds: number;
  toMilliseconds: number;
  matches: (record: IncidentSummary) => boolean;
}

function alertFilterOf(incident: OpenIncident, referenceAt: number, nowMilliseconds: number): AlertFilter | null {
  switch (incident.kind) {
    case "monitor_down": return {
      fromMilliseconds: referenceAt - EVIDENCE_ALERT_WINDOW_MILLISECONDS, toMilliseconds: referenceAt + EVIDENCE_ALERT_WINDOW_MILLISECONDS,
      matches: (record) => record.kind.startsWith("monitor_") && record.key.split(",").includes(incident.monitor.name),
    };
    case "deploy_failed": {
      const key = `deploy-failed:${incident.deployment.service}:${incident.deployment.commitSha}`;
      return {
        fromMilliseconds: instantMilliseconds(incident.deployment.acceptedAt), toMilliseconds: referenceAt + EVIDENCE_AFTER_DEPLOY_MILLISECONDS,
        matches: (record) => record.key === key,
      };
    }
    case "resource_threshold": {
      const { server, rule, target } = incident.firing;
      const key = `resource:${server}:${rule}${target === null ? "" : `:${target}`}`;
      return {
        fromMilliseconds: referenceAt - EVIDENCE_ALERT_WINDOW_MILLISECONDS, toMilliseconds: nowMilliseconds,
        matches: (record) => record.key === key || record.key === `${key}:resolved`,
      };
    }
    case "error_logs": return null;
  }
}

async function alertHistoryCell(client: IncidentClient, filter: AlertFilter): Promise<EvidenceCell<AlertHistoryView>> {
  const result = await client.listIncidents(EVIDENCE_ALERT_LOOKUP_LIMIT);
  if (!result.ok) return failedCell(result);
  const received = result.value;
  const earliest = Math.min(...received.map((record) => instantMilliseconds(record.at)));
  return { state: "value", value: {
    from: isoText(filter.fromMilliseconds), to: isoText(filter.toMilliseconds),
    records: received.filter((record) => filter.matches(record) && within(record.at, filter.fromMilliseconds, filter.toMilliseconds)),
    coversWindow: received.length < EVIDENCE_ALERT_LOOKUP_LIMIT || earliest < filter.fromMilliseconds,
  } };
}

// ── 로그 ───────────────────────────────────────────────────

interface LogPlan {
  scope: EvidenceLogsView["scope"];
  fromMilliseconds: number;
  toMilliseconds: number;
  /** 관측 서버에 보내는 서비스 거름(null = 거름 없음) */
  service: string | null;
  levels: (LogLevel | null)[];
  requestId: string | null;
  /** 화면에 보이는 서비스 거름 */
  services: string[] | null;
  keep: (line: LogEntryView) => boolean;
}

/** 그 서버의 컨테이너(latest)가 속한 배포 서비스들(DEPLOY_SERVICES 순서). 서버가 없거나 컨테이너를 모르면 []. */
function servicesOnServer(latest: UpstreamResult<LatestResources>, server: string): string[] {
  if (!latest.ok) return [];
  const containers = latest.value.servers.find((entry) => entry.server === server)?.containers ?? [];
  return DEPLOY_SERVICES.filter((service) => containers.some((container) => containerBelongsToService(container.seriesName, service)));
}

/** 로그를 부르지 않는 칸 — 대응 표에 없음 · 그 서버의 서비스를 찾지 못함. */
type LogCellWithoutCall = Extract<EvidenceCell<never>, { state: "unmapped" | "services_not_found" }>;

function logPlanOf(incident: OpenIncident, referenceAt: number, sources: IncidentSources, nowMilliseconds: number): LogPlan | LogCellWithoutCall {
  const around = { fromMilliseconds: referenceAt - EVIDENCE_LOG_WINDOW_MILLISECONDS, toMilliseconds: referenceAt + EVIDENCE_LOG_WINDOW_MILLISECONDS };
  switch (incident.kind) {
    case "monitor_down":
      if (incident.service === null) return { state: "unmapped" };
      return { scope: "levels", ...around, service: incident.service, levels: ["warning", "error"], requestId: null, services: [incident.service], keep: () => true };
    case "deploy_failed": {
      const { requestId } = incident.deployment;
      return {
        scope: "request", fromMilliseconds: instantMilliseconds(incident.deployment.acceptedAt) - EVIDENCE_LOG_WINDOW_MILLISECONDS,
        toMilliseconds: referenceAt + EVIDENCE_AFTER_DEPLOY_MILLISECONDS, service: null, levels: [null], requestId, services: null,
        keep: (line) => line.requestId === requestId,
      };
    }
    case "resource_threshold": {
      const services = servicesOnServer(sources.latest, incident.firing.server);
      if (services.length === 0) return { state: "services_not_found" };
      return { scope: "levels", ...around, service: null, levels: ["warning", "error"], requestId: null, services, keep: (line) => services.includes(line.service) };
    }
    case "error_logs":
      return {
        scope: "errors", fromMilliseconds: nowMilliseconds - EVIDENCE_LOG_WINDOW_MILLISECONDS, toMilliseconds: nowMilliseconds,
        service: incident.service, levels: ["error"], requestId: null, services: [incident.service], keep: () => true,
      };
  }
}

async function logsCell(client: LogClient, plan: LogPlan): Promise<EvidenceCell<EvidenceLogsView>> {
  const from = isoText(plan.fromMilliseconds);
  const to = isoText(plan.toMilliseconds);
  // 두 번 부르는 칸도 한꺼번에 시작한다
  const pages = await Promise.all(plan.levels.map((level): Promise<UpstreamResult<LogPage>> => client.searchLogs({
    from, to, service: plan.service, level, requestId: plan.requestId, text: null, before: null, limit: EVIDENCE_LOG_FETCH_LIMIT,
  } satisfies LogQuery)));
  const received: LogEntryView[] = [];
  let moreOnServer = false;
  for (const page of pages) {
    if (!page.ok) return failedCell(page);   // warning 쪽을 먼저 본다(plan.levels 순서)
    received.push(...page.value.logs.filter(plan.keep));
    moreOnServer ||= page.value.nextBefore !== null;
  }
  const chronological = received
    .map((line) => ({ line, at: instantMilliseconds(line.at) }))
    .sort((left, right) => left.at - right.at)
    .map(({ line }) => line);
  const kept = chronological.slice(-EVIDENCE_LOG_LINE_LIMIT);
  const truncated = chronological.length > kept.length || moreOnServer;
  return { state: "value", value: {
    scope: plan.scope, from, to, services: plan.services, requestId: plan.requestId,
    lines: kept.map((line) => ({
      ...line,
      href: logsHref({ service: line.service, level: null, requestId: null, text: null, from, to, before: null, limit: LOG_QUERY_DEFAULT_LIMIT }, line.id),
    })),
    truncated, noticeText: truncated ? `최근 ${EVIDENCE_LOG_LINE_LIMIT}줄만 보입니다 — 더 있음` : null,
  } };
}

// ── 배포 ───────────────────────────────────────────────────

function deploymentHref(deployment: DeploymentSummary): string {
  return deploysHref({ service: null, limit: DEPLOY_HISTORY_DEFAULT_LIMIT }, { requestId: deployment.requestId, service: deployment.service });
}

/** 창 [T − 1시간, T] 에 접수된 배포(받은 이력을 다시 거른다 — 호출 없음). */
function deploymentWindowCell(history: UpstreamResult<DeploymentSummary[]>, referenceAt: number): EvidenceCell<EvidenceDeploymentsView> {
  if (!history.ok) return failedCell(history);
  const fromMilliseconds = referenceAt - EVIDENCE_DEPLOY_WINDOW_MILLISECONDS;
  const oldest = Math.min(...history.value.map((deployment) => instantMilliseconds(deployment.acceptedAt)));
  return { state: "value", value: {
    kind: "window", from: isoText(fromMilliseconds), to: isoText(referenceAt),
    deployments: history.value
      .filter((deployment) => within(deployment.acceptedAt, fromMilliseconds, referenceAt))
      .map((deployment) => ({ ...deployment, href: deploymentHref(deployment) })),
    coversWindow: history.value.length < INCIDENT_DEPLOY_LOOKUP_LIMIT || oldest < fromMilliseconds,
  } };
}

/** 앞 성공 배포와의 사이의 커밋(range 일 때만 master git 한 번). */
async function deploymentRangeCell(client: DeployGitClient, history: UpstreamResult<DeploymentSummary[]>, failed: DeploymentSummary): Promise<EvidenceCell<EvidenceDeploymentsView>> {
  if (!history.ok) return failedCell(history);
  const found = findDeployRange(history.value, failed.requestId);
  if (found === null) return failedCell(upstreamFailure("not_found"));
  const { range } = found;
  const base = { kind: "range" as const, status: range.status, baseRequestId: range.baseRequestId, baseCommitSha: range.baseCommitSha, headCommitSha: range.headCommitSha, detailHref: deploymentHref(failed) };
  if (range.status !== "range" || range.baseCommitSha === null) return { state: "value", value: { ...base, commits: [], truncated: false, relation: null } };
  const commits = await client.listCommits(failed.service as DeployService, range.baseCommitSha, range.headCommitSha);
  if (!commits.ok) return failedCell(commits);
  return { state: "value", value: { ...base, commits: commits.value.commits, truncated: commits.value.truncated, relation: commits.value.relation } };
}

// ── 자원 ───────────────────────────────────────────────────

/** 그 서버의 지금 값(sources.latest — 호출 없음). */
function serverResourcesCell(latest: UpstreamResult<LatestResources>, server: string): EvidenceCell<EvidenceResourcesView> {
  if (!latest.ok) return failedCell(latest);
  const resourcesScreenHref = `${resourcesHref({ range: "1h", container: null })}#${STATUS_RESOURCE_ANCHOR_PREFIX}${server}`;
  const entry = latest.value.servers.find((candidate) => candidate.server === server);
  if (entry === undefined) {
    return { state: "value", value: {
      kind: "server", server, found: false, cpuText: RESOURCE_NO_VALUE_TEXT, memoryText: RESOURCE_NO_VALUE_TEXT, diskText: RESOURCE_NO_VALUE_TEXT,
      receivedAt: null, resourcesHref: resourcesScreenHref,
    } };
  }
  const readings = currentReadings(entry, serverFiringOf([]));
  return { state: "value", value: {
    kind: "server", server, found: true, cpuText: readings.cpu.text, memoryText: readings.memory.text, diskText: readings.disk.text,
    receivedAt: entry.receivedAt, resourcesHref: resourcesScreenHref,
  } };
}

/** 그 서비스가 T 에 있던 서버의 그때 값 — 서버를 찾지 못한 실패(location)는 칸 전체의 실패. */
async function traceResourcesCell(dependencies: IncidentEvidenceDependencies, service: string, referenceAt: number): Promise<EvidenceCell<EvidenceResourcesView>> {
  const trace = await dependencies.traceResources(service, referenceAt);
  if (trace === null) return failedCell(upstreamFailure("unparseable"));
  if (!trace.location.ok) return failedCell(trace.location);
  return { state: "value", value: { kind: "trace", trace } };
}

function serviceOf(incident: OpenIncident): string | null {
  switch (incident.kind) {
    case "monitor_down": return incident.service;
    case "deploy_failed": return incident.deployment.service;
    case "resource_threshold": return null;
    case "error_logs": return incident.service;
  }
}

export async function buildIncidentEvidence(dependencies: IncidentEvidenceDependencies, input: IncidentEvidenceInput): Promise<IncidentEvidence> {
  const { incident, sources, nowMilliseconds } = input;
  const referenceAt = referenceMilliseconds(incident, nowMilliseconds);
  const alertFilter = alertFilterOf(incident, referenceAt, nowMilliseconds);
  const logPlan = logPlanOf(incident, referenceAt, sources, nowMilliseconds);
  const service = serviceOf(incident);
  // 칸들을 한꺼번에 시작한다(서로 기다리지 않는다)
  const [alertHistory, logs, deployments, resources] = await Promise.all([
    settledCell(async (): Promise<EvidenceCell<AlertHistoryView>> => (alertFilter === null ? { state: "not_applicable" } : alertHistoryCell(dependencies.alertRecords, alertFilter))),
    settledCell(async (): Promise<EvidenceCell<EvidenceLogsView>> => ("state" in logPlan ? logPlan : logsCell(dependencies.logs, logPlan))),
    settledCell(async (): Promise<EvidenceCell<EvidenceDeploymentsView>> => (incident.kind === "deploy_failed"
      ? deploymentRangeCell(dependencies.deployGit, sources.deployments, incident.deployment)
      : deploymentWindowCell(sources.deployments, referenceAt))),
    settledCell(async (): Promise<EvidenceCell<EvidenceResourcesView>> => {
      if (incident.kind === "resource_threshold") return serverResourcesCell(sources.latest, incident.firing.server);
      return service === null ? { state: "unmapped" } : traceResourcesCell(dependencies, service, referenceAt);
    }),
  ]);
  return { incident, facts: factsOf(incident), alertHistory, logs, deployments, resources, reductions: [] };
}
