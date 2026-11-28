/** 재배포 확인 화면의 서버 쪽 진입 — 세션 검증을 **직접** 부른 뒤에만 입력을 해석하고 설정을 읽고 master 를 부른다.
 * 순서: 세션 → 입력(틀리면 invalid_input, 설정을 읽지 않고 부르지 않음) → 설정 → master 호출(전부 GET). 아무것도 바꾸지 않는다.
 * 비교가 되면 접수 폼의 확인 값을 만든다(submission — 서명만, 저장하지 않는다). 접수는 redeploy-accept 가 한다.
 * 설정: DEPLOY_MASTER_URL · DEPLOY_SECRET(버전 목록과 같은 것 — readServerConfig, 부를 때마다 읽는다). 둘 중 하나라도 비었거나 주소가 http(s) 가 아니면
 * preview = not_configured(호출 없음). 네트워크는 부를 때의 전역 fetch. src/app 은 이 모듈만 쓴다.
 * 실패한 칸(이력 · 방향 조회)은 앱 로그 1줄(upstreamFailureLogLine — 이유 낱말 · 상태 코드만).
 * 문제의 조치(명세 ⑫ §24 · §26 — `?service=&incident=&action=`, commit 없음): 입력 → 그 순간 열린 문제에 그 ID 가 있는가(그 종류를 가르는 목록의 출처 하나)
 * → 그 문제의 서비스(incidentActionService)가 요청의 서비스와 같은가 → 판은 그 서비스의 이력(⑥ 과 같은 출처 — /deploys?service=&limit=200)에서
 * incidentActionTargets 로 다시 정한다(브라우저가 보낸 판을 믿지 않는다) → 그 판으로 ⑥ 의 확인 화면 그대로 · 확인 값이 문제의 ID 를 묶는다.
 * 어느 단계에서 멈추면 그 까닭(incident.reason)만 — 폼 · git 조회 없음. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createDeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import { issueRedeployConfirmation, newRedeployRequestId } from "@/features/deploy-redeploy/lib/redeploy-confirmation";
import { buildRedeployPreview, type RedeployPreview } from "@/features/deploy-redeploy/lib/redeploy-preview";
import {
  REDEPLOY_INCIDENT_TEXT, parseRedeployPreviewRequest, type RedeployPreviewQuery, type RedeployPreviewRequest,
} from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import { incidentRequestedByFor, requestedByFor } from "@/features/deploy-redeploy/lib/redeploy-requester";
import { DEPLOY_VERSIONS_HISTORY_LIMIT } from "@/features/deploy-versions/lib/deploy-versions-view";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import { DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import { INCIDENT_ACTION_TEXT, incidentActionServiceOf, incidentActionTargets, type IncidentActionKind } from "@/features/incidents/lib/incident-actions";
import { lookupIncidentForAction } from "@/features/incidents/lib/incidents-screen";
import { readServerConfig, sessionSigningKey, type ServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { invalidInputOf, screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import { upstreamFailure, type SearchParamsInput, type UpstreamResult } from "@/shared/lib/upstream-result";

/** 확인 화면의 접수 폼 — comparison 이고 진행 중인 배포가 없을 때만. 계정 이름이 requested_by 로 쓸 수 없으면 account_not_allowed(폼 대신 안내).
 * 요청 ID 는 그릴 때마다 새로 정해 확인 값에 담는다(새로 고침 = 새 요청 ID). 세션 서명 키가 비면 폼을 내지 않는다(null). */
export type RedeployAcceptSubmission =
  | { kind: "form"; confirmation: string; requestId: string }
  | { kind: "account_not_allowed" }
  /** 문제의 조치인데 `admin:<계정>:incident:<ID>` 가 128자를 넘는다 */
  | { kind: "incident_account_too_long" };

/** 문제의 조치로 연 확인 화면 — 어느 문제의 어느 조치인가와, 확인 화면을 낼 수 없으면 그 까닭(고정 글). */
export interface RedeployIncidentContext {
  incidentId: string;
  action: IncidentActionKind;
  /** null 이면 확인 화면 그대로 · 글이면 확인 화면 대신 이 까닭(그때 preview 는 쓰지 않는 자리표) */
  reason: string | null;
}

export interface RedeployPreviewView {
  /** 입력이 틀렸으면 null(그때 preview 는 invalid_input, master 를 부르지 않는다) */
  query: RedeployPreviewQuery | null;
  /** 돌아갈 버전 목록의 서비스 — 입력의 service 가 허용 목록 안의 글자 하나면 그것(commit 이 틀려도), 아니면 null */
  service: DeployService | null;
  preview: UpstreamResult<RedeployPreview>;
  /** 접수 폼 — 폼을 둘 수 없으면 null */
  submission: RedeployAcceptSubmission | null;
  /** 문제의 조치로 연 것이면(명세 ⑫ §24) — 아니면 칸이 없다(⑥ 의 결과와 같은 꼴) */
  incident?: RedeployIncidentContext;
}

/** 접수 폼 — 폼을 둘 수 없으면 null. 문제의 조치면 확인 값이 그 ID 와 조치의 종류를 묶는다. */
function submissionFor(query: RedeployPreviewQuery, preview: UpstreamResult<RedeployPreview>, config: ServerConfig, incident: RedeployIncidentContext | undefined): RedeployAcceptSubmission | null {
  const incidentId = incident?.incidentId ?? null;
  if (!preview.ok || preview.value.kind !== "comparison" || preview.value.inProgress !== null) return null;
  if (requestedByFor(config.adminUser) === null) return { kind: "account_not_allowed" };
  if (incidentId !== null && incidentRequestedByFor(config.adminUser, incidentId) === null) return { kind: "incident_account_too_long" };
  const signingKey = sessionSigningKey();
  if (signingKey.length === 0) return null;
  const requestId = newRedeployRequestId();
  const confirmation = issueRedeployConfirmation(signingKey, {
    service: query.service, commitSha: query.commitSha, requestId, issuedAt: Date.now(), account: config.adminUser,
    ...(incident === undefined ? {} : { incidentId: incident.incidentId, action: incident.action }),
  });
  return { kind: "form", confirmation, requestId };
}

type IncidentRequest = Extract<RedeployPreviewRequest, { kind: "incident" }>;

/** 문제의 조치를 정하지 못한 까닭의 낱말 — 접수 직전에 다시 정할 때 로그 `redeploy:incident_changed reason=<낱말>` 에 쓴다(명세 ⑫ §25). */
export type IncidentActionChangedReason = "target_changed" | "incident_closed" | "incident_unchecked" | "service_changed" | "history_unavailable";

/** 문제의 조치의 판 — 정했으면 그 커밋, 아니면 까닭의 낱말과 화면의 글. */
export type IncidentActionResolution = { ok: true; commitSha: string } | { ok: false; reason: IncidentActionChangedReason; text: string };

/** 문제의 조치 — 그 순간의 문제 · 서비스 · 이력에서 판을 정한다(확인 화면과 접수 직전이 같은 판정을 쓴다). master 설정이 없으면 history_unavailable.
 * 읽는 것은 둘뿐이다: 그 종류를 가르는 목록의 출처 하나(lookupIncidentForAction — 감시 대상 /monitors · 배포 실패 /deploys · 오류 로그 /logs · 자원 임계값 /metrics/latest)와
 * 그 서비스의 이력(/deploys?service=&limit=200). 근거 · 알림 기록 · 다른 출처는 읽지 않는다. */
export async function resolveIncidentAction(config: ServerConfig, request: Omit<IncidentRequest, "kind">): Promise<IncidentActionResolution> {
  if (!isHttpBaseUrl(config.deployMasterUrl) || config.deploySecret.length === 0) {
    return { ok: false, reason: "history_unavailable", text: INCIDENT_ACTION_TEXT.targetReasons.history_unavailable };
  }
  const fetchUpstream = (input: string, init: RequestInit) => fetch(input, init);
  const found = await lookupIncidentForAction({
    alertUrl: config.alertUrl, alertSecret: config.alertSecret, observeUrl: config.observeUrl, observeSecret: config.observeSecret,
    deployMasterUrl: config.deployMasterUrl, deploySecret: config.deploySecret, fetch: fetchUpstream, now: () => Date.now(),
    logFailure: (cell, failure) => {
      const logLine = upstreamFailureLogLine("deploy-redeploy", `incident:${cell}`, failure);
      if (logLine !== null) void log("screen-deploy-redeploy", logLine, "warning");
    },
  }, request.incidentId);
  if (found.kind === "closed") return { ok: false, reason: "incident_closed", text: REDEPLOY_INCIDENT_TEXT.closed };
  if (found.kind === "unchecked") return { ok: false, reason: "incident_unchecked", text: REDEPLOY_INCIDENT_TEXT.unchecked };
  const service = incidentActionServiceOf(found.incident, found.serverServices);
  if (!service.ok) return { ok: false, reason: "service_changed", text: INCIDENT_ACTION_TEXT.serviceReasons[service.reason] };
  if (service.service !== request.service) return { ok: false, reason: "service_changed", text: REDEPLOY_INCIDENT_TEXT.serviceMismatch };
  const history = await createDeployHistoryClient({ baseUrl: config.deployMasterUrl, secret: config.deploySecret, fetch: fetchUpstream })
    .listDeployments({ service: request.service, limit: DEPLOY_VERSIONS_HISTORY_LIMIT });
  const target = incidentActionTargets(history, request.service)[request.action];
  if (target.ok) return { ok: true, commitSha: target.commitSha };
  return { ok: false, reason: target.reason === "history_unavailable" ? "history_unavailable" : "target_changed", text: INCIDENT_ACTION_TEXT.targetReasons[target.reason] };
}

/** 입력이 틀렸을 때 돌아갈 버전 목록의 서비스 — service 를 먼저 보므로 field 가 service 가 아니면 service 는 허용 목록 안의 글자 하나다. */
function serviceOfRejected(searchParams: SearchParamsInput, field: string | undefined): DeployService | null {
  const service = searchParams.service;
  return field !== "service" && typeof service === "string" && (DEPLOY_SERVICES as readonly string[]).includes(service) ? (service as DeployService) : null;
}

/** 세션 검증을 마친 뒤에만 부른다. */
async function buildRedeployPreviewView(searchParams: SearchParamsInput): Promise<RedeployPreviewView> {
  const parsed = parseRedeployPreviewRequest(searchParams);
  if (!parsed.ok) return { query: null, service: serviceOfRejected(searchParams, parsed.field), preview: parsed, submission: null };
  const { request } = parsed;
  const config = readServerConfig();
  const masterConfigured = isHttpBaseUrl(config.deployMasterUrl) && config.deploySecret.length > 0;
  let query: RedeployPreviewQuery;
  let incident: RedeployIncidentContext | undefined;
  if (request.kind === "version") {
    query = request.query;
  } else {
    const context = { incidentId: request.incidentId, action: request.action };
    if (!masterConfigured) {
      return { query: null, service: request.service, preview: upstreamFailure("not_configured"), submission: null, incident: { ...context, reason: null } };
    }
    const target = await resolveIncidentAction(config, request);
    if (!target.ok) {
      // 확인 화면을 내지 않는다 — preview 는 화면이 그리지 않는 자리표(까닭이 먼저)
      return { query: null, service: request.service, preview: upstreamFailure("not_found"), submission: null, incident: { ...context, reason: target.text } };
    }
    query = { service: request.service, commitSha: target.commitSha };
    incident = { ...context, reason: null };
  }
  let preview: UpstreamResult<RedeployPreview>;
  if (!masterConfigured) {
    preview = upstreamFailure("not_configured");
  } else {
    const options = { baseUrl: config.deployMasterUrl, secret: config.deploySecret, fetch: (input: string, init: RequestInit) => fetch(input, init) };
    preview = await buildRedeployPreview({ deployHistory: createDeployHistoryClient(options), deployGit: createDeployGitClient(options) }, query);
  }
  const cells: [string, UpstreamResult<unknown>][] = [["preview", preview]];
  if (preview.ok && preview.value.kind === "comparison" && preview.value.direction.kind === "unknown" && preview.value.direction.failure !== null) {
    cells.push(["direction", preview.value.direction.failure]);
  }
  for (const [cell, result] of cells) {
    const logLine = upstreamFailureLogLine("deploy-redeploy", cell, result);
    if (logLine !== null) void log("screen-deploy-redeploy", logLine, "warning");
  }
  const submission = submissionFor(query, preview, config, incident);
  return incident === undefined ? { query, service: query.service, preview, submission } : { query, service: query.service, preview, submission, incident };
}

/** 화면용 — 세션이 없으면 requireSession 이 /login 으로 보낸다(다른 서버를 한 번도 부르지 않는다). */
export async function loadRedeployPreview(searchParams: SearchParamsInput): Promise<RedeployPreviewView> {
  await requireSession();
  return buildRedeployPreviewView(searchParams);
}

/** 데이터 경로용(Route Handler 의 GET 이 그대로 돌려준다) — 세션이 없으면 401(requireApiSession).
 * 입력이 틀리면 422 `{success:false,error:{code:"invalid_input",field}}`, 그 밖은 200 `{success:true,data:RedeployPreviewView}`. 언제나 no-store. */
export async function redeployPreviewResponse(request: Request): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  const view = await buildRedeployPreviewView(searchParamsInputFromUrl(new URL(request.url)));
  return screenDataResponse(view, invalidInputOf(view.preview));
}
