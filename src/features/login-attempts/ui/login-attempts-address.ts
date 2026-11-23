/** 로그인 시도 기록 화면의 주소(순수) — 조건을 주소에 담는다(새로 고침 · 뒤로 가기 · 주소 공유가 그대로 된다). 로그 조회 화면(logs-address)과 같은 방식.
 * 주소의 인자:
 * - from · to · before · limit — 데이터 계층(parseLoginAttemptsQuery)과 같은 이름 · 같은 뜻. from · to 는 ISO-8601 UTC(관측 서버가 준 값 그대로) — "더 보기"가 쓴다.
 * - from_kst · to_kst — 조회 폼의 시각 칸(`<input type="datetime-local">`, KST `YYYY-MM-DDTHH:MM[:SS]`). 진입 함수에 넘기기 전에 UTC 의 from · to 로 바꾼다. */
import { LOGIN_ATTEMPTS_DEFAULT_LIMIT, type LoginAttemptsQuery } from "@/features/login-attempts/lib/login-attempts-query";
import { isoUtcToKstInput, kstInputToIsoUtc } from "@/features/logs/ui/logs-address";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const LOGIN_ATTEMPTS_PATH = "/login-attempts";

/** 시각 칸의 글자를 읽을 수 없을 때 진입 함수에 넘기는 값 — ISO-8601 UTC 꼴이 아니므로 parseLoginAttemptsQuery 가 그 이름(from · to)으로 거절한다. */
const UNREADABLE_TIME = "unreadable-kst-time";

function stringOf(input: SearchParamsInput, name: string): string | null {
  const value = input[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 주소의 시각 하나 → 진입 함수의 값. 폼 칸(KST)이 없으면 UTC 값 그대로, 있으면 UTC 로 바꾼 값(읽을 수 없으면 거절될 값).
 * 폼 칸이 여러 번 오거나 폼 칸과 UTC 값이 함께 오면 배열로 넘겨 진입 함수가 "여러 번"으로 거절하게 한다(조용히 하나를 고르지 않는다). */
function timeInput(input: SearchParamsInput, name: "from" | "to"): string | string[] | undefined {
  const kstValue = input[`${name}_kst`];
  if (Array.isArray(kstValue)) return kstValue;
  if (kstValue === undefined || kstValue === "") return input[name];
  const converted = kstInputToIsoUtc(kstValue) ?? UNREADABLE_TIME;
  const utcValue = input[name];
  if (utcValue === undefined || utcValue === "") return converted;
  return [converted, ...(Array.isArray(utcValue) ? utcValue : [utcValue])];
}

/** 화면 주소의 인자 → 진입 함수(loadLoginAttempts)의 입력. 폼의 KST 시각 칸을 UTC 의 from · to 로 바꾸고 before · limit 은 그대로 옮긴다(다른 이름은 넘기지 않는다).
 * 빈 글자(빈 칸으로 제출)는 진입 함수가 "없음"으로 읽는다(singleValue). */
export function loginAttemptsInput(input: SearchParamsInput): SearchParamsInput {
  return { from: timeInput(input, "from"), to: timeInput(input, "to"), before: input.before, limit: input.limit };
}

/** 조회 폼에 다시 채울 값 — 입력이 틀렸어도 사용자가 넣은 글자를 그대로 보여 준다(주소의 글자 기준). */
export interface LoginAttemptsFormValues {
  fromKst: string;
  toKst: string;
  limit: string;
}

export function loginAttemptsFormValues(input: SearchParamsInput): LoginAttemptsFormValues {
  const timeValue = (name: "from" | "to") => stringOf(input, `${name}_kst`) ?? isoUtcToKstInput(stringOf(input, name) ?? "");
  return { fromKst: timeValue("from"), toKst: timeValue("to"), limit: stringOf(input, "limit") ?? "" };
}

/** 조건 → 화면 주소(null 인 조건은 넣지 않는다, 건수는 기본값이면 뺀다). from · to 는 UTC 이름으로. */
export function loginAttemptsHref(query: LoginAttemptsQuery): string {
  const search = new URLSearchParams();
  const pairs: [string, string | null][] = [
    ["from", query.from], ["to", query.to], ["before", query.before],
    ["limit", query.limit === LOGIN_ATTEMPTS_DEFAULT_LIMIT ? null : String(query.limit)],
  ];
  for (const [name, value] of pairs) if (value !== null) search.set(name, value);
  const text = search.toString();
  return text.length > 0 ? `${LOGIN_ATTEMPTS_PATH}?${text}` : LOGIN_ATTEMPTS_PATH;
}
