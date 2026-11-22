/** 다른 서버가 정상 응답 안에 담아 준 사유 글자(alert 감시의 reason · backend 의존성의 detail · observe 헬스의 failure)를
 * 화면에 넘기기 전에 가린다(순수). 운영자는 DOWN 사유를 보되, 내부 주소 · IP · 포트는 보지 않는다.
 * (오류 응답 본문은 이 함수로 넘기지 않는다 — 그것은 아예 넘기지 않는다. upstream-result 참고.)
 *
 * 규칙(순서대로):
 * 1. `http://` · `https://`(scheme 대소문자 무관)로 시작하는 주소의 **scheme + [사용자정보@] + host + [:port]** 를 `(주소)` 로 바꾼다
 *    — host 는 이름 · IPv4 · 대괄호 IPv6 모두. 그 뒤의 경로 · 쿼리는 남긴다(예: `http://10.0.0.5:9200/_cluster/health` → `(주소)/_cluster/health`).
 * 2. scheme 없이 맨 IPv4(`a.b.c.d`, 뒤에 `:port` 가 붙으면 포트까지)를 `(주소)` 로 바꾼다.
 * 3. 줄바꿈(`\r\n` · `\n` · `\r`)을 하나씩 공백 한 칸으로 바꾼다.
 * 4. 앞 120자(코드 포인트 기준 — 서로게이트 쌍을 가르지 않는다)로 자른다. 가린 뒤에 자르므로 잘린 조각에 주소가 되살아나지 않는다.
 * 빈 글자는 빈 글자. 주소가 없으면(줄바꿈 · 길이 말고는) 그대로. 앞뒤 공백은 다듬지 않는다. */

export const MASKED_ADDRESS = "(주소)";
export const UPSTREAM_REASON_MAXIMUM_LENGTH = 120;

/** http(s) 주소의 scheme + [사용자정보@] + host(이름 · IPv4 · 대괄호 IPv6) + [:port] — 경로 · 쿼리는 남긴다. */
const SCHEME_ADDRESS_PATTERN = /https?:\/\/(?:[^\s/?#@]*@)?(?:\[[0-9A-Fa-f:.]*\]|[^\s/?#:@\[\]]+)(?::\d*)?/gi;
/** scheme 없는 맨 IPv4(앞뒤가 숫자 · 점이 아닌 자리) + [:port]. */
const BARE_IPV4_PATTERN = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?![\d.])/g;
const LINE_BREAK_PATTERN = /\r\n|\n|\r/g;

export function maskUpstreamReason(reason: string): string {
  const masked = reason
    .replace(SCHEME_ADDRESS_PATTERN, MASKED_ADDRESS)
    .replace(BARE_IPV4_PATTERN, MASKED_ADDRESS)
    .replace(LINE_BREAK_PATTERN, " ");
  const codePoints = Array.from(masked);
  return codePoints.length > UPSTREAM_REASON_MAXIMUM_LENGTH ? codePoints.slice(0, UPSTREAM_REASON_MAXIMUM_LENGTH).join("") : masked;
}
