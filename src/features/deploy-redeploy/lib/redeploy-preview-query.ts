/** 재배포 확인 화면의 입력 검증(순수) — 뼈대: 타입과 시그니처만. 구현 워커가 채운다.
 * 입력 이름: service(필수 — DEPLOY_SERVICES 만) · commit(필수 — 소문자 16진수 40자 전체 SHA만).
 * 없음 · 빈 값 · 배열 · 허용 목록 밖 · 짧은 SHA · 대문자 · 그 밖 글자는 invalid_input(field = "service" 또는 "commit" — service 를 먼저 본다). */
import type { DeployService } from "@/features/deploys/lib/deploy-history-query";
import type { SearchParamsInput, UpstreamFailure } from "@/shared/lib/upstream-result";

export interface RedeployPreviewQuery {
  service: DeployService;
  /** 고른 버전의 커밋(소문자 40자) */
  commitSha: string;
}

export function parseRedeployPreviewQuery(input: SearchParamsInput): { ok: true; query: RedeployPreviewQuery } | UpstreamFailure {
  void input;
  throw new Error("not implemented: parseRedeployPreviewQuery");
}
