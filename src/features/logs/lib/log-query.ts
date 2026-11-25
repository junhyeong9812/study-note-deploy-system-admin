/** 로그 조회 화면의 입력 검증과 이어 보기 — 관측 서버 `GET /logs` 의 규칙(observe api/LogController.kt:88-108, 146-153)과 같은 꼴을
 * 어드민 쪽에서 먼저 적용한다(순수). 형식이 틀리면 호출하지 않는다.
 * 입력 이름(관측 서버와 같다): from · to · service · level · request_id · q · before · limit. 빈 글자는 없는 것과 같다(q 만 예외 — 아래). */
import { parseIsoUtc, parseLimit, singleValue } from "@/shared/lib/query-input";
import { invalidInput, type SearchParamsInput, type UpstreamFailure } from "@/shared/lib/upstream-result";

export const LOG_LEVELS = ["debug", "info", "warning", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_QUERY_DEFAULT_LIMIT = 100;
/** 관측 서버의 상한(MAX_LIMIT 500)과 같거나 작다. */
export const LOG_QUERY_MAXIMUM_LIMIT = 500;
/** 관측 서버의 상한(MAX_RANGE 31일)과 같거나 작다. */
export const LOG_QUERY_MAXIMUM_RANGE_MILLISECONDS = 31 * 24 * 60 * 60 * 1000;
export const LOG_SEARCH_TEXT_MINIMUM_LENGTH = 2;
export const LOG_SEARCH_TEXT_MAXIMUM_LENGTH = 200;

export interface LogQuery {
  /** ISO-8601 UTC(`YYYY-MM-DDTHH:MM:SS[.fraction]Z`) 또는 null(관측 서버의 기본 — 최근 1시간) */
  from: string | null;
  to: string | null;
  /** `^[a-z0-9-]{1,40}$` */
  service: string | null;
  level: LogLevel | null;
  /** `^[A-Za-z0-9_.-]{1,80}$` */
  requestId: string | null;
  /** 검색어 — 앞뒤 공백을 뺀 길이 2자 이상, 전체 200자 이하(보낼 때는 받은 글자 그대로) */
  text: string | null;
  /** 앞 응답의 next_before(`^\d{1,15}-\d{1,9}$`) */
  before: string | null;
  limit: number;
}

/** 규칙(어긋나면 invalid_input, field = 입력 이름):
 * - from · to: ISO-8601 UTC 꼴만. from > to 거절. 기간 상한 31일 — from 만 있으면 now 까지로, to 만 있으면 그 앞 1시간으로 잰다.
 * - before: 있으면 from 과 to 가 **둘 다** 있어야 한다(before 만 넘기지 않는다 — 쪽마다 창이 밀려 로그가 빠지는 것을 막는다).
 * - q: 빈 글자가 아니면 trim 길이 2 이상 · 200자 이하(공백만 있는 q 는 거절).
 * - limit: 없음·빈 값 = 100, 1~500 의 10진 정수 글자만.
 * - 같은 이름이 여러 번(배열)이면 거절. */
const LOG_SERVICE_PATTERN = /^[a-z0-9-]{1,40}$/;
export const LOG_REQUEST_ID_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;
const LOG_CURSOR_PATTERN = /^\d{1,15}-\d{1,9}$/;
/** to 만 있을 때 관측 서버가 쓰는 기간(그 앞 1시간). */
const LOG_DEFAULT_RANGE_MILLISECONDS = 60 * 60 * 1000;

export function parseLogQuery(input: SearchParamsInput, now: number): { ok: true; query: LogQuery } | UpstreamFailure {
  const values: Record<string, string | null> = {};
  for (const name of ["from", "to", "service", "level", "request_id", "q", "before", "limit"]) {
    const value = singleValue(input, name);
    if (value === "many") return invalidInput(name);
    values[name] = value;
  }
  const { from, to, service, level, request_id: requestId, q: text, before, limit: limitText } = values;

  const fromEpoch = from === null ? null : parseIsoUtc(from);
  if (from !== null && fromEpoch === null) return invalidInput("from");
  const toEpoch = to === null ? null : parseIsoUtc(to);
  if (to !== null && toEpoch === null) return invalidInput("to");
  if (fromEpoch !== null && toEpoch !== null && fromEpoch > toEpoch) return invalidInput("from");
  const rangeStart = fromEpoch ?? (toEpoch !== null ? toEpoch - LOG_DEFAULT_RANGE_MILLISECONDS : null);
  const rangeEnd = toEpoch ?? now;
  if (rangeStart !== null && rangeEnd - rangeStart > LOG_QUERY_MAXIMUM_RANGE_MILLISECONDS) return invalidInput("from");

  if (service !== null && !LOG_SERVICE_PATTERN.test(service)) return invalidInput("service");
  if (level !== null && !(LOG_LEVELS as readonly string[]).includes(level)) return invalidInput("level");
  if (requestId !== null && !LOG_REQUEST_ID_PATTERN.test(requestId)) return invalidInput("request_id");
  if (text !== null) {
    const length = Array.from(text).length;
    if (Array.from(text.trim()).length < LOG_SEARCH_TEXT_MINIMUM_LENGTH || length > LOG_SEARCH_TEXT_MAXIMUM_LENGTH) return invalidInput("q");
  }
  if (before !== null && (!LOG_CURSOR_PATTERN.test(before) || from === null || to === null)) return invalidInput("before");

  let limit = LOG_QUERY_DEFAULT_LIMIT;
  if (limitText !== null) {
    const parsed = parseLimit(limitText, LOG_QUERY_MAXIMUM_LIMIT);
    if (parsed === null) return invalidInput("limit");
    limit = parsed;
  }
  return { ok: true, query: { from, to, service, level: level as LogLevel | null, requestId, text, before, limit } };
}

/** 응답 한 쪽의 화면 꼴(observe LogController.kt:110-121 의 칸 그대로, camelCase). */
export interface LogEntryView {
  id: string;
  at: string;
  level: LogLevel;
  service: string;
  /** 요청 ID 가 없는 줄은 빈 글자 */
  requestId: string;
  message: string;
}

export interface LogPage {
  logs: LogEntryView[];
  /** 빈 글자면 null(끝) */
  nextBefore: string | null;
  /** 관측 서버가 실제로 쓴 기간 — 이어 보기에 그대로 넘긴다 */
  from: string;
  to: string;
}

/** 다음 쪽의 조건 — 같은 조건에 before = page.nextBefore, from · to = **응답의** from · to. nextBefore 가 null 이면 null. */
export function nextLogPageQuery(query: LogQuery, page: LogPage): LogQuery | null {
  if (page.nextBefore === null) return null;
  return { ...query, before: page.nextBefore, from: page.from, to: page.to };
}
