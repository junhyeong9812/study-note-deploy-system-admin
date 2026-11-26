/** 재배포 확인 화면의 입력 검증과 주소(순수) — 접수(POST)도 같은 검증으로 본문의 service · commit 을 본다.
 * 입력 이름: service(필수 — DEPLOY_SERVICES 만) · commit(필수 — 소문자 16진수 40자 전체 SHA만 — master 이력이 주는 꼴, 버전 목록의 링크가 싣는 꼴).
 * 없음 · 빈 값 · 배열 · 허용 목록 밖 · 짧은 SHA · 대문자 · 그 밖 글자는 invalid_input(field = "service" 또는 "commit" — service 를 먼저 본다). */
import { DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
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

/** 확인 화면의 요청 — 버전 목록에서 고른 판(⑥ 그대로) · 문제의 조치(명세 ⑫ §24 — 판은 서버가 그 순간의 이력에서 다시 정한다). 뼈대. */
export type RedeployPreviewRequest =
  | { kind: "version"; query: RedeployPreviewQuery }
  | { kind: "incident"; service: DeployService; incidentId: string; action: "redeploy" | "rollback" };

export function parseRedeployPreviewRequest(input: SearchParamsInput): { ok: true; request: RedeployPreviewRequest } | UpstreamFailure {
  void input;
  throw new Error("parseRedeployPreviewRequest: 구현 전");
}

/** 문제의 조치 → 확인 화면의 주소(`/deploys/redeploy?service=&incident=&action=` — commit 을 싣지 않는다). 뼈대. */
export function incidentRedeployPreviewHref(service: DeployService, incidentId: string, action: "redeploy" | "rollback"): string {
  void service; void incidentId; void action;
  throw new Error("incidentRedeployPreviewHref: 구현 전");
}

/** 문제의 조치로 들어온 확인 화면 · 접수의 고정 글(명세 ⑫ §24). */
export const REDEPLOY_INCIDENT_TEXT = {
  /** 확인 화면 · 결과에 한 줄 — `문제 <ID> 의 조치` */
  headingPrefix: "문제 ",
  headingSuffix: " 의 조치",
  back: "문제 화면으로 돌아가기",
  closed: "이 문제는 지금 열려 있지 않습니다 — 조치하지 않습니다",
  unchecked: "이 문제가 지금 열려 있는지 확인하지 못했습니다 — 조치하지 않습니다",
  serviceMismatch: "이 문제의 서비스가 아닙니다 — 조치하지 않습니다",
  evidenceUnavailable: "이 문제의 근거를 모으지 못해 조치할 서비스를 정할 수 없습니다",
  accountTooLong: "계정 이름이 길어 이 문제의 조치를 접수에 남길 수 없습니다(admin:계정:incident:ID 가 128자를 넘습니다)",
} as const;
