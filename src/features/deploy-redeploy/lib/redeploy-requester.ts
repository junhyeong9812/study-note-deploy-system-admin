/** 접수의 requested_by(순수).
 * `admin:<계정>` — 계정은 영문 · 숫자 · . _ - 만(콜론은 ⑫ 의 `:incident:<id>` 자리라 받지 않는다), 전체가 REQUESTED_BY_PATTERN(명세 §10) 안. 아니면 null.
 * 문제에서 온 접수는 `admin:<계정>:incident:<문제의 ID>`(명세 ⑫ §24) — ID 는 12-1 의 꼴(isIncidentId), 전체가 128자를 넘으면 null(접수하지 않는다).
 * master(ci-cd internal/master/master.go)가 같은 꼴 `^[A-Za-z0-9._:-]{1,128}$` 를 검사한다. */
import { isIncidentId } from "@/features/incidents/lib/incident-id";

/** master 가 받는 requested_by(명세 §10 — `@` 없음). */
export const REQUESTED_BY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 계정 이름에 허용하는 글자 — 콜론은 뒤에 붙일 자리라 받지 않는다. */
const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 문제에서 온 접수의 requested_by — `admin:<계정>:incident:<문제의 ID>`(명세 ⑫ §24). 계정 · ID 의 꼴이 틀리거나 128자를 넘으면 null. */
export function incidentRequestedByFor(account: string, incidentId: string): string | null {
  const person = requestedByFor(account);
  if (person === null || !isIncidentId(incidentId)) return null;
  const requestedBy = `${person}:incident:${incidentId}`;
  return REQUESTED_BY_PATTERN.test(requestedBy) ? requestedBy : null;
}

export function requestedByFor(account: string): string | null {
  if (!ACCOUNT_PATTERN.test(account)) return null;
  const requestedBy = `admin:${account}`;
  return REQUESTED_BY_PATTERN.test(requestedBy) ? requestedBy : null;
}
