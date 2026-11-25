/** 버전 목록 화면의 입력 검증(순수) — 뼈대: 타입과 시그니처만. 구현 워커가 채운다.
 * 입력 이름: service(없음 · 빈 값 = 고르지 않음). 배포 이력 화면과 같은 허용 목록(DEPLOY_SERVICES)만, 배열 · 대소문자 다름 · 공백 · 그 밖 글자는 invalid_input(field "service"). */
import type { DeployService } from "@/features/deploys/lib/deploy-history-query";
import type { SearchParamsInput, UpstreamFailure } from "@/shared/lib/upstream-result";

export interface DeployVersionsQuery {
  /** null = 아직 고르지 않음(master 를 부르지 않는다) */
  service: DeployService | null;
}

export function parseDeployVersionsQuery(input: SearchParamsInput): { ok: true; query: DeployVersionsQuery } | UpstreamFailure {
  void input;
  throw new Error("not implemented: parseDeployVersionsQuery");
}
