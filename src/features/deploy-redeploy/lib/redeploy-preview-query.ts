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
