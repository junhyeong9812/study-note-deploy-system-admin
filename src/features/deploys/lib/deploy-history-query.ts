/** 배포 이력 화면의 입력 검증 — master `GET /deploys?service=&limit=` 을 부르기 **전에** 어드민 쪽에서 거절한다(순수).
 * master 는 모르는 service 를 빈 목록으로, 틀린 limit 을 50 으로 바꿔 받아 주므로 어드민이 먼저 막는다(명세 ② 세부 "목록 화면의 건수 상한은 어드민 서버 쪽에서도 강제"). */
import { parseLimit, singleValue } from "@/shared/lib/query-input";
import { invalidInput, type SearchParamsInput, type UpstreamFailure } from "@/shared/lib/upstream-result";

/** 고를 수 있는 서비스 — master 의 허용 목록(ci-cd internal/master/master.go:59 front·backend·llm·alert·observe) + 로드맵 task 05 에서 더할 admin. */
export const DEPLOY_SERVICES = ["front", "backend", "llm", "alert", "observe", "admin"] as const;
export type DeployService = (typeof DEPLOY_SERVICES)[number];

export const DEPLOY_HISTORY_DEFAULT_LIMIT = 50;
/** master 의 상한(master.go:342 — 200 넘으면 200)과 같거나 작아야 한다. */
export const DEPLOY_HISTORY_MAXIMUM_LIMIT = 200;

export interface DeployHistoryQuery {
  /** null = 전체 서비스 */
  service: DeployService | null;
  limit: number;
}

/** 입력 이름: service(빈 값·없음 = 전체) · limit(없음·빈 값 = 50, 1~200 의 10진 정수 글자만).
 * 허용 목록 밖 · 대소문자 다름 · 앞뒤 공백 · 배열(같은 이름 여러 번) · 범위 밖은 invalid_input(field = 그 이름). */
export function parseDeployHistoryQuery(input: SearchParamsInput): { ok: true; query: DeployHistoryQuery } | UpstreamFailure {
  const serviceText = singleValue(input, "service");
  if (serviceText === "many") return invalidInput("service");
  let service: DeployService | null = null;
  if (serviceText !== null) {
    if (!(DEPLOY_SERVICES as readonly string[]).includes(serviceText)) return invalidInput("service");
    service = serviceText as DeployService;
  }
  const limitText = singleValue(input, "limit");
  if (limitText === "many") return invalidInput("limit");
  let limit = DEPLOY_HISTORY_DEFAULT_LIMIT;
  if (limitText !== null) {
    const parsed = parseLimit(limitText, DEPLOY_HISTORY_MAXIMUM_LIMIT);
    if (parsed === null) return invalidInput("limit");
    limit = parsed;
  }
  return { ok: true, query: { service, limit } };
}
