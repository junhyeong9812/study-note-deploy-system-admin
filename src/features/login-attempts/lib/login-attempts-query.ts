/** 로그인 시도 기록 화면의 입력 검증과 이어 보기 — 관측 서버 `GET /auth/attempts?from=&to=&before=&limit=` 의 규칙
 * (observe auth/AuthAttemptController.kt:198-212, 239-251)과 같은 꼴을 어드민 쪽에서 먼저 적용한다(순수). 형식이 틀리면 호출하지 않는다. */
import { parseIsoUtc, parseLimit, singleValue } from "@/shared/lib/query-input";
import { invalidInput, type SearchParamsInput, type UpstreamFailure } from "@/shared/lib/upstream-result";

/** 기록의 결과 낱말(observe auth/AuthAttempt.kt:61-68) — 이 밖의 값은 unparseable. */
export const LOGIN_ATTEMPT_OUTCOMES = ["success", "failure", "locked", "rate_limited", "origin_rejected", "malformed"] as const;
export type LoginAttemptOutcome = (typeof LOGIN_ATTEMPT_OUTCOMES)[number];

export const LOGIN_ATTEMPTS_DEFAULT_LIMIT = 50;
/** 관측 서버의 상한(MAX_LIMIT 200)과 같거나 작다. */
export const LOGIN_ATTEMPTS_MAXIMUM_LIMIT = 200;
/** 관측 서버의 상한(MAX_RANGE 90일)과 같거나 작다. */
export const LOGIN_ATTEMPTS_MAXIMUM_RANGE_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;

export interface LoginAttemptsQuery {
  /** ISO-8601 UTC 또는 null(관측 서버의 기본 — 지금까지 90일) */
  from: string | null;
  to: string | null;
  /** 앞 응답의 next_before(`<ISO-8601>_<UUID>` — AuthAttempt.kt:111-123) */
  before: string | null;
  limit: number;
}

/** 규칙(어긋나면 invalid_input, field = 입력 이름): from · to 는 ISO-8601 UTC 꼴만, from > to 거절, 기간 상한 90일(from 만 있으면 now 까지로 잰다)
 * · before 는 `<ISO>_<UUID>` 꼴이고 from 과 to 가 둘 다 있어야 한다 · limit 없음 = 50, 1~200 · 배열 거절. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `<ISO-8601 UTC>_<UUID>` 꼴인가. */
function isAttemptCursor(value: string): boolean {
  const separator = value.indexOf("_");
  if (separator < 0) return false;
  return parseIsoUtc(value.slice(0, separator)) !== null && UUID_PATTERN.test(value.slice(separator + 1));
}

export function parseLoginAttemptsQuery(input: SearchParamsInput, now: number): { ok: true; query: LoginAttemptsQuery } | UpstreamFailure {
  const values: Record<string, string | null> = {};
  for (const name of ["from", "to", "before", "limit"]) {
    const value = singleValue(input, name);
    if (value === "many") return invalidInput(name);
    values[name] = value;
  }
  const { from, to, before, limit: limitText } = values;
  const fromEpoch = from === null ? null : parseIsoUtc(from);
  if (from !== null && fromEpoch === null) return invalidInput("from");
  const toEpoch = to === null ? null : parseIsoUtc(to);
  if (to !== null && toEpoch === null) return invalidInput("to");
  if (fromEpoch !== null && toEpoch !== null && fromEpoch > toEpoch) return invalidInput("from");
  if (fromEpoch !== null && (toEpoch ?? now) - fromEpoch > LOGIN_ATTEMPTS_MAXIMUM_RANGE_MILLISECONDS) return invalidInput("from");
  if (before !== null && (!isAttemptCursor(before) || from === null || to === null)) return invalidInput("before");
  let limit = LOGIN_ATTEMPTS_DEFAULT_LIMIT;
  if (limitText !== null) {
    const parsed = parseLimit(limitText, LOGIN_ATTEMPTS_MAXIMUM_LIMIT);
    if (parsed === null) return invalidInput("limit");
    limit = parsed;
  }
  return { ok: true, query: { from, to, before, limit } };
}

/** 화면 한 줄 — id · 시각 · 결과 · IP · User-Agent · replayed 만(AuthAttemptController.kt:216-219). */
export interface LoginAttemptView {
  id: string;
  at: string;
  outcome: LoginAttemptOutcome;
  ip: string;
  userAgent: string;
  replayed: boolean;
}

export interface LoginAttemptsPage {
  attempts: LoginAttemptView[];
  nextBefore: string | null;   // 빈 글자면 null
  from: string;
  to: string;
}

/** 지금의 잠금 상태(`GET /auth/lock` — AuthAttemptController.kt:228-237). 화면 표시용. */
export interface LockStatusView {
  locked: boolean;
  lockedUntil: string | null;
  failures: number;
}

/** 다음 쪽 — 같은 limit, before = page.nextBefore, from · to = 응답의 from · to. 끝이면 null. */
export function nextLoginAttemptsPageQuery(query: LoginAttemptsQuery, page: LoginAttemptsPage): LoginAttemptsQuery | null {
  if (page.nextBefore === null) return null;
  return { ...query, before: page.nextBefore, from: page.from, to: page.to };
}
