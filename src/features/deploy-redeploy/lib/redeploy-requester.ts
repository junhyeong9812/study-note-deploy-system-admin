/** 접수의 requested_by(순수) — 뼈대. 구현 워커가 채운다.
 * `admin:<계정>` — 계정은 영문 · 숫자 · . _ - 만(콜론은 ⑫ 의 `:incident:<id>` 자리라 받지 않는다), 전체가 REQUESTED_BY_PATTERN(명세 §10) 안. 아니면 null. */

/** master 가 받는 requested_by(명세 §10 — `@` 없음). */
export const REQUESTED_BY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestedByFor(account: string): string | null {
  void account;
  throw new Error("not implemented: requestedByFor");
}
