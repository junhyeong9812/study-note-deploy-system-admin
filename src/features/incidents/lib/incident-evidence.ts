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
 * - 자원 임계값: key 가 `resource:<서버>:<규칙>` 이거나 그 뒤에 `:` 로 이어지는 기록(관측 서버의 key — 대상 · `:resolved`), at ∈ [since − 1시간, now].
 * - 오류 로그: 해당 없음(not_applicable — 이 문제에는 알림이 없다).
 * 양끝 포함. 알림 서버 순서 그대로. coversWindow = 받은 기록이 200건 미만이거나 가장 이른 at < from(아니면 200건이 창의 앞쪽에 닿지 못했다 — 화면 · 글에 드러낸다).
 *
 * 로그(관측 서버 `GET /logs`, 각 limit 500):
 * - 감시 대상 DOWN: 그 서비스의 warning · error 두 번, [T − 10분, T + 10분]. 대응 표에 없는 대상이면 unmapped(부르지 않는다).
 * - 배포 실패: request_id = 그 배포의 요청 ID 한 번(수준 거름 없음 — 그 요청으로 묶은 모든 줄), [acceptedAt − 10분, (finishedAt ?? acceptedAt) + 10분].
 *   받은 줄 가운데 requestId 가 그 요청 ID 와 같은 줄만 남긴다(다른 요청의 줄을 섞지 않는다).
 * - 자원 임계값: warning · error 두 번(서비스 거름 없음), [T − 10분, T + 10분] → 그 서버의 서비스들의 줄만 남긴다. 그 서버의 서비스 = DEPLOY_SERVICES 가운데
 *   sources.latest 의 그 서버 컨테이너(계열 이름)에 containerBelongsToService 가 참인 것(DEPLOY_SERVICES 순서). services 에 그 이름들.
 *   서버가 latest 에 없거나 컨테이너를 모르면(latest 실패 포함) services [] 이고 줄도 없다(그래도 두 번 부른다 — 칸의 실패를 드러내려고).
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
import type { TraceResourcesView } from "@/features/log-trace/lib/trace-resources";
import { TRACE_RESOURCE_MAXIMUM_CALLS } from "@/features/log-trace/lib/trace-resources";
import type { LogClient } from "@/features/logs/lib/log-client";
import type { LogEntryView } from "@/features/logs/lib/log-query";
import type { DeployGitClient, GitCommit, GitRelation } from "@/features/deploy-detail/lib/deploy-git-client";
import type { DeployRangeStatus } from "@/features/deploy-detail/lib/deploy-range";
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import type { IncidentSources, OpenIncident } from "@/features/incidents/lib/incident-list";
import type { UpstreamFailure } from "@/shared/lib/upstream-result";

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
} as const;

export type EvidenceCell<Value> =
  | { state: "value"; value: Value }
  | { state: "failed"; failure: UpstreamFailure }
  | { state: "unmapped" }
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
  void cell;
  throw new Error("not implemented");
}

export async function buildIncidentEvidence(dependencies: IncidentEvidenceDependencies, input: IncidentEvidenceInput): Promise<IncidentEvidence> {
  void dependencies; void input;
  throw new Error("not implemented");
}
