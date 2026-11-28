/** 접수의 requested_by(순수).
 * `admin:<계정>` — 계정은 영문 · 숫자 · . _ - 만(콜론은 ⑫ 의 `:incident:<id>` 자리라 받지 않는다), 전체가 REQUESTED_BY_PATTERN(명세 §10) 안. 아니면 null. */

/** master 가 받는 requested_by(명세 §10 — `@` 없음). */
export const REQUESTED_BY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 계정 이름에 허용하는 글자 — 콜론은 뒤에 붙일 자리라 받지 않는다. */
const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function requestedByFor(account: string): string | null {
  if (!ACCOUNT_PATTERN.test(account)) return null;
  const requestedBy = `admin:${account}`;
  return REQUESTED_BY_PATTERN.test(requestedBy) ? requestedBy : null;
}
