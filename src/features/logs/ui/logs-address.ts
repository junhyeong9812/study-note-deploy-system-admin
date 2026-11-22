/** 로그 조회 화면의 주소(순수) — 조건을 주소에 담는다(새로 고침 · 뒤로 가기 · 주소 공유가 그대로 된다).
 * 주소의 인자:
 * - service · level · request_id · q · limit · before · from · to — 데이터 계층(parseLogQuery)과 같은 이름 · 같은 뜻.
 *   from · to 는 ISO-8601 UTC(관측 서버가 준 값 그대로) — "더 보기" · 요청 ID 링크가 쓴다.
 * - from_kst · to_kst — 조회 폼의 시각 칸(`<input type="datetime-local">`, KST `YYYY-MM-DDTHH:MM[:SS]`). 진입 함수에 넘기기 전에
 *   UTC 의 from · to 로 바꾼다(logSearchInput). 폼은 브라우저 스크립트 없이 GET 으로 제출되므로 시각 칸의 글자는 이 꼴로 온다. */
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import { LOG_QUERY_DEFAULT_LIMIT, type LogQuery } from "@/features/logs/lib/log-query";
import { parseIsoUtc } from "@/shared/lib/query-input";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const LOGS_PATH = "/logs";

const KST_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000;
const KST_INPUT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/;
/** 시각 칸의 글자를 읽을 수 없을 때 진입 함수에 넘기는 값 — ISO-8601 UTC 꼴이 아니므로 parseLogQuery 가 그 이름(from · to)으로 거절한다. */
const UNREADABLE_TIME = "unreadable-kst-time";

/** KST `YYYY-MM-DDTHH:MM[:SS]` → ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ`. 꼴이 다르거나 달력에 없는 시각이면 null. */
export function kstInputToIsoUtc(value: string): string | null {
  const match = KST_INPUT_PATTERN.exec(value);
  if (!match) return null;
  const epoch = parseIsoUtc(`${match[1]}${match[2] ?? ":00"}Z`);
  if (epoch === null) return null;
  return new Date(epoch - KST_OFFSET_MILLISECONDS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** ISO-8601 UTC → 시각 칸의 값(KST `YYYY-MM-DDTHH:MM:SS`, 초 아래는 버린다). 읽을 수 없으면 빈 글자. */
export function isoUtcToKstInput(value: string): string {
  if (parseIsoUtc(value) === null) return "";
  return formatKoreanTime(value).replace(" ", "T");
}

function stringOf(input: SearchParamsInput, name: string): string | null {
  const value = input[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 주소의 시각 하나 → 진입 함수의 값. 폼 칸(KST)이 없으면 UTC 값 그대로. 폼 칸이 있으면 UTC 로 바꾼 값(읽을 수 없으면 거절될 값).
 * 폼 칸이 여러 번 오거나 폼 칸과 UTC 값이 함께 오면 배열로 넘겨 parseLogQuery 가 "여러 번"으로 거절하게 한다(조용히 하나를 고르지 않는다). */
function timeInput(input: SearchParamsInput, name: "from" | "to"): string | string[] | undefined {
  const kstValue = input[`${name}_kst`];
  if (Array.isArray(kstValue)) return kstValue;
  if (kstValue === undefined || kstValue === "") return input[name];
  const converted = kstInputToIsoUtc(kstValue) ?? UNREADABLE_TIME;
  const utcValue = input[name];
  if (utcValue === undefined || utcValue === "") return converted;
  return [converted, ...(Array.isArray(utcValue) ? utcValue : [utcValue])];
}

/** 화면 주소의 인자 → 로그 조회 진입(loadLogSearch)의 입력. 폼의 KST 시각 칸을 UTC 의 from · to 로 바꾸고, 나머지 이름은 그대로 옮긴다. */
export function logSearchInput(input: SearchParamsInput): SearchParamsInput {
  return {
    from: timeInput(input, "from"),
    to: timeInput(input, "to"),
    service: input.service,
    level: input.level,
    request_id: input.request_id,
    q: input.q,
    before: input.before,
    limit: input.limit,
  };
}

/** 조회 폼에 다시 채울 값 — 입력이 틀렸어도 사용자가 넣은 글자를 그대로 보여 준다(주소의 글자 기준). */
export interface LogFormValues {
  fromKst: string;
  toKst: string;
  service: string;
  level: string;
  requestId: string;
  text: string;
  limit: string;
}

export function logFormValues(input: SearchParamsInput): LogFormValues {
  const timeValue = (name: "from" | "to") => stringOf(input, `${name}_kst`) ?? isoUtcToKstInput(stringOf(input, name) ?? "");
  return {
    fromKst: timeValue("from"),
    toKst: timeValue("to"),
    service: stringOf(input, "service") ?? "",
    level: stringOf(input, "level") ?? "",
    requestId: stringOf(input, "request_id") ?? "",
    text: stringOf(input, "q") ?? "",
    limit: stringOf(input, "limit") ?? "",
  };
}

/** 조건 → 화면 주소(null 인 조건은 넣지 않는다, 건수는 기본값이면 뺀다). from · to 는 UTC 이름으로. */
export function logsHref(query: Pick<LogQuery, "from" | "to" | "service" | "level" | "requestId" | "text" | "before" | "limit">): string {
  const search = new URLSearchParams();
  const pairs: [string, string | null][] = [
    ["service", query.service], ["level", query.level], ["request_id", query.requestId], ["q", query.text],
    ["from", query.from], ["to", query.to], ["before", query.before],
    ["limit", query.limit === LOG_QUERY_DEFAULT_LIMIT ? null : String(query.limit)],
  ];
  for (const [name, value] of pairs) if (value !== null) search.set(name, value);
  const text = search.toString();
  return text.length > 0 ? `${LOGS_PATH}?${text}` : LOGS_PATH;
}

/** 요청 ID 하나의 흐름을 따라가는 주소 — 그 요청 ID 와 지금 쪽의 조회 범위(응답의 from · to)만 남긴다(서비스 · 수준 · 낱말 · 이어 보기 위치는 뺀다 —
 * 한 요청이 여러 서비스에 걸쳐 남긴 줄을 모두 보려고). 건수는 그대로. */
export function requestFlowHref(requestId: string, range: { from: string; to: string }, limit: number): string {
  return logsHref({ requestId, from: range.from, to: range.to, service: null, level: null, text: null, before: null, limit });
}

/** 서비스 하나로 걸러 보는 주소 — 지금 조건(수준 · 요청 ID · 낱말 · 건수)과 지금 쪽의 조회 범위(응답의 from · to)를 그대로 두고 service 만 그 값으로 바꾼다.
 * 이어 보기 위치(before)는 뺀다(그 범위의 첫 쪽 — 최신부터). */
export function serviceFilterHref(service: string, query: Pick<LogQuery, "level" | "requestId" | "text" | "limit">, range: { from: string; to: string }): string {
  return logsHref({
    service, level: query.level, requestId: query.requestId, text: query.text, limit: query.limit,
    from: range.from, to: range.to, before: null,
  });
}
