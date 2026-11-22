/** 배포 이력 화면의 주소(순수) — 목록 조건과 상세 선택을 주소에 담는다(새로 고침 · 뒤로 가기 · 주소 공유가 그대로 된다 — 명세 §10.2).
 * 인자: service(목록의 서비스 선택 — 없으면 전체) · limit(목록 건수) · selected(고른 배포의 요청 ID) · selectedService(고른 줄의 서비스 —
 * "전체" 보기에서도 상세의 데이터 조회에 쓴다) · commit(상세에서 고른 커밋의 40자 SHA).
 * 상세 데이터 경로(/api/deploys/detail)의 입력 이름은 service · selected · commit 이므로 detailInput 이 이름을 옮긴다. */
import { DEPLOY_HISTORY_DEFAULT_LIMIT, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const DEPLOYS_PATH = "/deploys";

/** 목록 조건(입력이 틀렸으면 전체 · 기본 건수). */
export interface DeployListAddress {
  service: DeployService | null;
  limit: number;
}

/** 상세에서 고른 배포. */
export interface DeploySelectionAddress {
  requestId: string;
  service: string;
  commitSha?: string | null;
}

export function deploysHref(list: DeployListAddress, selection: DeploySelectionAddress | null = null): string {
  const search = new URLSearchParams();
  if (list.service !== null) search.set("service", list.service);
  if (list.limit !== DEPLOY_HISTORY_DEFAULT_LIMIT) search.set("limit", String(list.limit));
  if (selection !== null) {
    search.set("selected", selection.requestId);
    search.set("selectedService", selection.service);
    if (selection.commitSha) search.set("commit", selection.commitSha);
  }
  const query = search.toString();
  return query.length > 0 ? `${DEPLOYS_PATH}?${query}` : DEPLOYS_PATH;
}

/** 상세를 열었는가(selected 인자가 있다 — 빈 글자는 열지 않음, 형식 검사는 상세 진입이 한다). */
export function hasDetailSelection(input: SearchParamsInput): boolean {
  return input.selected !== undefined && input.selected !== "";
}

/** 목록에서 강조할 요청 ID(하나의 글자일 때만). */
export function selectedRequestIdOf(input: SearchParamsInput): string | null {
  return typeof input.selected === "string" && input.selected.length > 0 ? input.selected : null;
}

/** 화면 주소의 인자 → 상세 진입의 입력(service = 고른 줄의 서비스, 없으면 목록의 서비스). */
export function detailInput(input: SearchParamsInput): SearchParamsInput {
  return {
    service: input.selectedService !== undefined ? input.selectedService : input.service,
    selected: input.selected,
    commit: input.commit,
  };
}
