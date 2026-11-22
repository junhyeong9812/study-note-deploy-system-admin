/** 배포 상세의 입력 검증(순수) — master · GitHub 를 부르기 **전에** 거절한다(명세 §10.2 "SHA 는 16진수 7~40자만, 요청 ID 는 기존 형식만 — 그 밖은 GitHub 를 부르지 않고 422 invalid_input" — 11-22 정정).
 * 입력 이름: service(필수 — 배포 이력의 허용 목록 DEPLOY_SERVICES) · selected(필수 — 요청 ID) · commit(선택 — 고른 커밋의 SHA).
 * 대소문자 다름 · 앞뒤 공백 · 배열(같은 이름 여러 번) · 형식 밖은 invalid_input(field = 그 이름). 빈 commit 은 "고르지 않음"(null). */
import { DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import { singleValue } from "@/shared/lib/query-input";
import { invalidInput, type SearchParamsInput, type UpstreamFailure } from "@/shared/lib/upstream-result";

/** 커밋 SHA — 16진수(대소문자) 7~40자. */
export const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;

/** 배포 요청 ID — master 가 받아들이는 형식(ci-cd internal/shared/logger.go:91 AcceptOrIssue — 영문 · 숫자 · `-` · `_`, 1~64자). */
export const DEPLOY_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface DeployDetailQuery {
  service: DeployService;
  /** 선택한 배포의 요청 ID(selected) */
  selectedRequestId: string;
  /** 고른 커밋(commit) — 없으면 null. 받은 글자 그대로(대소문자를 바꾸지 않는다). */
  commitSha: string | null;
}

/** 16진수 7~40자인가. */
export function isCommitSha(value: string): boolean {
  return COMMIT_SHA_PATTERN.test(value);
}

export function parseDeployDetailQuery(input: SearchParamsInput): { ok: true; query: DeployDetailQuery } | UpstreamFailure {
  const service = singleValue(input, "service");
  if (service === null || service === "many" || !(DEPLOY_SERVICES as readonly string[]).includes(service)) return invalidInput("service");
  const selected = singleValue(input, "selected");
  if (selected === null || selected === "many" || !DEPLOY_REQUEST_ID_PATTERN.test(selected)) return invalidInput("selected");
  const commit = singleValue(input, "commit");
  if (commit === "many" || (commit !== null && !isCommitSha(commit))) return invalidInput("commit");
  return { ok: true, query: { service: service as DeployService, selectedRequestId: selected, commitSha: commit } };
}
