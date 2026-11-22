/** 목록 화면의 입력 검증이 함께 쓰는 조각(순수) — 하나의 값 꺼내기 · ISO-8601 UTC 시각 · 건수 · 요청 주소의 인자.
 * 거절은 다른 서버를 부르기 전에 한다(명세 ② 세부 5 "입력의 상한을 넘는 값은 줄여서 받지 않고 거절"). */
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

/** 하나의 값 — 없음 · 빈 글자 = null, 같은 이름이 여러 번(배열)이면 "many". */
export function singleValue(input: SearchParamsInput, name: string): string | null | "many" {
  const value = input[name];
  if (Array.isArray(value)) return "many";
  if (value === undefined || value === "") return null;
  return value;
}

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/** `YYYY-MM-DDTHH:MM:SS[.fraction]Z` 이고 달력에 있는 시각이면 epoch 밀리초, 아니면 null. */
export function parseIsoUtc(value: string): number | null {
  const match = ISO_UTC_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(epoch);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;   // 11월 31일 같은 날
  const fraction = match[7] ?? "";
  return epoch + (fraction.length > 0 ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0);
}

/** 1 ~ maximum 의 10진 정수 글자만(앞의 0 · 부호 · 공백 · 소수 · 지수 거절). */
export function parseLimit(value: string, maximum: number): number | null {
  if (!/^[1-9]\d{0,5}$/.test(value)) return null;
  const limit = Number(value);
  return limit <= maximum ? limit : null;
}

/** 요청 주소의 인자 → SearchParamsInput(같은 이름이 여러 번이면 배열 — 검증이 거절한다). */
export function searchParamsInputFromUrl(url: URL): SearchParamsInput {
  const input: Record<string, string | string[]> = {};
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    input[name] = values.length === 1 ? values[0] : values;
  }
  return input;
}
