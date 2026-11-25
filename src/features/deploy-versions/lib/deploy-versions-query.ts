/** 버전 목록 화면의 입력 검증(순수) — master 를 부르기 **전에** 어드민 쪽에서 거절한다.
 * 입력 이름: service(없음 · 빈 값 = 고르지 않음). 배포 이력 화면과 같은 허용 목록(DEPLOY_SERVICES)만, 배열 · 대소문자 다름 · 공백 · 그 밖 글자는 invalid_input(field "service"). */
import { DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import { singleValue } from "@/shared/lib/query-input";
import { invalidInput, type SearchParamsInput, type UpstreamFailure } from "@/shared/lib/upstream-result";

export interface DeployVersionsQuery {
  /** null = 아직 고르지 않음(master 를 부르지 않는다) */
  service: DeployService | null;
}

export function parseDeployVersionsQuery(input: SearchParamsInput): { ok: true; query: DeployVersionsQuery } | UpstreamFailure {
  const serviceText = singleValue(input, "service");
  if (serviceText === "many") return invalidInput("service");
  if (serviceText === null) return { ok: true, query: { service: null } };
  if (!(DEPLOY_SERVICES as readonly string[]).includes(serviceText)) return invalidInput("service");
  return { ok: true, query: { service: serviceText as DeployService } };
}
