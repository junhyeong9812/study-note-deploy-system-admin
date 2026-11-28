/** 문제 화면의 주소와 입력 검증(순수). 입력 이름은 `incident` 하나 — 없음 · 빈 글자 = 목록만, 있으면 그 문제의 근거 묶음.
 * 형식(isIncidentId)이 틀리거나 같은 이름이 여러 번이면 invalid_input(field "incident") — 다른 서버를 부르지 않는다. */
import { isIncidentId } from "@/features/incidents/lib/incident-id";
import { singleValue } from "@/shared/lib/query-input";
import { invalidInput, type SearchParamsInput, type UpstreamFailure } from "@/shared/lib/upstream-result";

export const INCIDENTS_PATH = "/incidents";

export interface IncidentsQuery {
  /** null = 목록만 */
  incidentId: string | null;
}

export function parseIncidentsQuery(input: SearchParamsInput): { ok: true; query: IncidentsQuery } | UpstreamFailure {
  const value = singleValue(input, "incident");
  if (value === "many") return invalidInput("incident");
  if (value === null) return { ok: true, query: { incidentId: null } };
  if (!isIncidentId(value)) return invalidInput("incident");
  return { ok: true, query: { incidentId: value } };
}

/** null → `/incidents`, 식별자 → `/incidents?incident=<URLSearchParams 로 인코딩한 식별자>`(`:` 은 `%3A`). */
export function incidentHref(incidentId: string | null): string {
  if (incidentId === null) return INCIDENTS_PATH;
  return `${INCIDENTS_PATH}?${new URLSearchParams({ incident: incidentId }).toString()}`;
}
