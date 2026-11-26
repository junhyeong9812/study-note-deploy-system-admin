/** 방문 기록 화면의 글자(순수) — 명세 §13 "(메인) 경로의 빈칸은 front 가 `%20` 으로, `%` 는 `%25` 로 써서 보낸다 … V5 의 화면이 보일 때 푼다" ·
 * §14 "누구나 `/wiki/<무엇이든>` · 호스트 꼴의 아무 글을 상위 목록에 올릴 수 있다". 경로 · 들어온 곳은 **방문자가 보낸 글자**다.
 *
 * - decodeVisitPath(raw): 왼쪽부터 한 번 훑어 `%20` → 빈칸, `%25` → `%` 만 푼다(front 가 쓴 두 가지의 거꾸로 — 그 밖의 `%XX` · 깨진 `%` 는 받은 글자 그대로).
 *   던지지 않는다. 한 번만 푼다(`%2520` → `%20` — 빈칸이 아니다).
 * - displayVisitPath(raw): decodeVisitPath → 보이지 않는 글자(제어 문자 Cc · 서식 문자 Cf(방향 뒤집기 · 폭 없는 빈칸) · 줄/문단 구분 Zl · Zp)를
 *   하나마다 VISIT_HIDDEN_CHARACTER_REPLACEMENT 로 바꾼다 → 코드 포인트 VISIT_TEXT_MAXIMUM_LENGTH 개를 넘으면 그만큼 남기고 VISIT_TEXT_ELLIPSIS 를 붙인다
 *   (서로게이트 쌍을 가르지 않는다).
 * - displayReferrerHost(host): null · 빈 글자 → VISIT_DIRECT_TEXT. 그 밖은 풀지 않고 보이지 않는 글자 바꾸기 → 자르기(displayVisitPath 와 같은 규칙).
 * - parseSiteOrigin(value): 앞뒤 공백을 뗀 값이 http(s) 이고 출처 꼴 그대로(`new URL(값).origin === 값` — 끝의 `/` · 경로 · 대문자 호스트는 틀림)면 그 값, 아니면 null.
 * - siteHostOf(origin): parseSiteOrigin 을 지난 출처의 호스트 이름(소문자 · 포트 없음 — 관측 서버의 referrer_host 와 같은 꼴).
 * - visitPathHref(siteOrigin, raw): 사이트의 그 글로 가는 주소 또는 null(링크를 걸지 않는다).
 *   siteOrigin 이 null 이거나, raw 가 `/` 로 시작하지 않거나, `//` 로 시작하거나, `\` · 보이지 않는 글자(위와 같은 갈래)를 담으면 null.
 *   그 밖은 `<siteOrigin><raw>`(받은 경로를 풀지 않고 그대로 붙인다) — 그 주소의 출처가 siteOrigin 과 다르면 null.
 * - formatVisitCount(n): 천 단위 쉼표(`1,234,567` — 지역 설정에 기대지 않는다).
 * - formatVisitRatio(ratio): null → VISIT_NO_RATIO_TEXT("—" — 0% 로 꾸미지 않는다), 그 밖은 퍼센트 소수 한 자리(`0.25` → `25.0%` · `0` → `0.0%`). */

import { formatPercent } from "@/features/resources/lib/resource-format";

export const VISIT_TEXT_MAXIMUM_LENGTH = 120;
export const VISIT_TEXT_ELLIPSIS = "…";
export const VISIT_HIDDEN_CHARACTER_REPLACEMENT = "\uFFFD";
export const VISIT_DIRECT_TEXT = "직접";
export const VISIT_NO_RATIO_TEXT = "—";

/** 보이지 않는 글자 — 제어(Cc) · 서식(Cf — 방향 뒤집기 · 폭 없는 빈칸 · BOM) · 줄 구분(Zl) · 문단 구분(Zp). */
const HIDDEN_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const HIDDEN_CHARACTERS_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** 보이지 않는 글자를 바꾸고 코드 포인트 VISIT_TEXT_MAXIMUM_LENGTH 개에서 자른다. */
function visibleText(text: string): string {
  const codePoints = Array.from(text.replace(HIDDEN_CHARACTERS_PATTERN, VISIT_HIDDEN_CHARACTER_REPLACEMENT));
  if (codePoints.length <= VISIT_TEXT_MAXIMUM_LENGTH) return codePoints.join("");
  return `${codePoints.slice(0, VISIT_TEXT_MAXIMUM_LENGTH).join("")}${VISIT_TEXT_ELLIPSIS}`;
}

export function decodeVisitPath(raw: string): string {
  // 정규식은 왼쪽부터 겹치지 않게 한 번 훑는다 — 바꾼 글자를 다시 보지 않는다(%2520 → %20)
  return raw.replace(/%(?:20|25)/g, (encoded) => (encoded === "%20" ? " " : "%"));
}

export function displayVisitPath(raw: string): string {
  return visibleText(decodeVisitPath(raw));
}

export function displayReferrerHost(host: string | null): string {
  if (host === null || host === "") return VISIT_DIRECT_TEXT;
  return visibleText(host);
}

export function parseSiteOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!URL.canParse(trimmed)) return null;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin === trimmed ? trimmed : null;
}

export function siteHostOf(origin: string): string {
  return new URL(origin).hostname;
}

export function visitPathHref(siteOrigin: string | null, raw: string): string | null {
  if (siteOrigin === null) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || HIDDEN_CHARACTER_PATTERN.test(raw)) return null;
  const href = `${siteOrigin}${raw}`;
  if (!URL.canParse(href) || new URL(href).origin !== siteOrigin) return null;
  return href;
}

export function formatVisitCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatVisitRatio(ratio: number | null): string {
  return ratio === null ? VISIT_NO_RATIO_TEXT : formatPercent(ratio * 100);
}
