/** 재배포 확인 화면의 입력 검증과 주소(순수) — 접수(POST)도 같은 검증으로 본문의 service · commit 을 본다.
 * 입력 이름: service(필수 — DEPLOY_SERVICES 만) · commit(필수 — 소문자 16진수 40자 전체 SHA만 — master 이력이 주는 꼴, 버전 목록의 링크가 싣는 꼴).
 * 없음 · 빈 값 · 배열 · 허용 목록 밖 · 짧은 SHA · 대문자 · 그 밖 글자는 invalid_input(field = "service" 또는 "commit" — service 를 먼저 본다).
 * 문제의 조치(명세 ⑫ §24)는 parseRedeployPreviewRequest — service · incident · action 만 받고 commit 은 받지 않는다. */
import { DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import { isIncidentId } from "@/features/incidents/lib/incident-id";
import { singleValue } from "@/shared/lib/query-input";
import { invalidInput, type SearchParamsInput, type UpstreamFailure } from "@/shared/lib/upstream-result";

export const REDEPLOY_PREVIEW_PATH = "/deploys/redeploy";
/** 확인 화면의 접수 폼이 보내는 곳(POST · 쿼리 없음 — 확인 값은 본문으로만). */
export const REDEPLOY_ACCEPT_ACTION = "/api/deploys/redeploy";

const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface RedeployPreviewQuery {
  service: DeployService;
  /** 고른 버전의 커밋(소문자 40자) */
  commitSha: string;
}

export function parseRedeployPreviewQuery(input: SearchParamsInput): { ok: true; query: RedeployPreviewQuery } | UpstreamFailure {
  const service = singleValue(input, "service");
  if (service === null || service === "many" || !(DEPLOY_SERVICES as readonly string[]).includes(service)) return invalidInput("service");
  const commitSha = singleValue(input, "commit");
  if (commitSha === null || commitSha === "many" || !FULL_COMMIT_SHA_PATTERN.test(commitSha)) return invalidInput("commit");
  return { ok: true, query: { service: service as DeployService, commitSha } };
}

/** 확인 화면의 주소 — 버전 목록의 줄마다 단 링크가 쓴다. */
export function redeployPreviewHref(service: DeployService, commitSha: string): string {
  return `${REDEPLOY_PREVIEW_PATH}?${new URLSearchParams({ service, commit: commitSha }).toString()}`;
}

/** 확인 화면의 요청 — 버전 목록에서 고른 판(⑥ 그대로) · 문제의 조치(명세 ⑫ §24 — 판은 서버가 그 순간의 이력에서 다시 정한다). */
export type RedeployPreviewRequest =
  | { kind: "version"; query: RedeployPreviewQuery }
  | { kind: "incident"; service: DeployService; incidentId: string; action: "redeploy" | "rollback" };

const INCIDENT_ACTIONS: readonly string[] = ["redeploy", "rollback"];

/** 주소에 incident 가 있으면(빈 글자 · 여러 개 포함) 문제의 조치 — service(허용 목록) · incident(isIncidentId) · action(redeploy | rollback)을 이 차례로 보고,
 * commit 이 함께 오면 거절한다(판은 브라우저가 정하지 않는다). 없으면 ⑥ 그대로(parseRedeployPreviewQuery). 거절은 invalid_input(field). */
export function parseRedeployPreviewRequest(input: SearchParamsInput): { ok: true; request: RedeployPreviewRequest } | UpstreamFailure {
  if (input.incident === undefined) {
    const parsed = parseRedeployPreviewQuery(input);
    return parsed.ok ? { ok: true, request: { kind: "version", query: parsed.query } } : parsed;
  }
  const service = singleValue(input, "service");
  if (service === null || service === "many" || !(DEPLOY_SERVICES as readonly string[]).includes(service)) return invalidInput("service");
  const incidentId = singleValue(input, "incident");
  if (incidentId === null || incidentId === "many" || !isIncidentId(incidentId)) return invalidInput("incident");
  const action = singleValue(input, "action");
  if (action === null || action === "many" || !INCIDENT_ACTIONS.includes(action)) return invalidInput("action");
  if (input.commit !== undefined) return invalidInput("commit");
  return { ok: true, request: { kind: "incident", service: service as DeployService, incidentId, action: action as "redeploy" | "rollback" } };
}

/** 문제의 조치 → 확인 화면의 주소(`/deploys/redeploy?service=&incident=&action=` — commit 을 싣지 않는다). */
export function incidentRedeployPreviewHref(service: DeployService, incidentId: string, action: "redeploy" | "rollback"): string {
  return `${REDEPLOY_PREVIEW_PATH}?${new URLSearchParams({ service, incident: incidentId, action }).toString()}`;
}

/** 문제의 조치로 들어온 확인 화면 · 접수의 고정 글(명세 ⑫ §24). */
/** 접수 직전의 다시 정하기(문제 모드) 전체의 기한 — 절대(명세 ⑫ §26). 넘으면 409 `recheck_timeout`. */
export const INCIDENT_RECHECK_TIMEOUT_MILLISECONDS = 8_000;

export const REDEPLOY_INCIDENT_TEXT = {
  /** 다시 정하기가 기한을 넘었을 때 409 화면의 까닭 한 줄(명세 ⑫ §26) */
  recheckTimeout: "상태를 제때 확인하지 못했습니다",
  /** 확인 화면 · 결과에 한 줄 — `문제 <ID> 의 조치` */
  headingPrefix: "문제 ",
  headingSuffix: " 의 조치",
  back: "문제 화면으로 돌아가기",
  closed: "이 문제는 지금 열려 있지 않습니다 — 조치하지 않습니다",
  unchecked: "이 문제가 지금 열려 있는지 확인하지 못했습니다 — 조치하지 않습니다",
  serviceMismatch: "이 문제의 서비스가 아닙니다 — 조치하지 않습니다",
  /** 접수 직전에 다시 정한 문제 · 대상이 확인 화면 때와 다르다(명세 ⑫ §25 — 409 의 제목) */
  changed: "그 사이 배포나 문제의 상태가 바뀌었습니다 — 문제 화면에서 다시 확인하세요",
  accountTooLong: "계정 이름이 길어 이 문제의 조치를 접수에 남길 수 없습니다(admin:계정:incident:ID 가 128자를 넘습니다)",
} as const;
