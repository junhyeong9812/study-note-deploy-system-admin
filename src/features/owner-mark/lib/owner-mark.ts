/** 주인 표시(쿠키 `study_owner`) — 값을 만들고(서명) 읽는다(검증). 순수: 설정 · 환경 변수 · Next 를 읽지 않는다(열쇠 · 도메인은 부르는 쪽이 준다).
 * backend(2a) `owner/domain/OwnerMark.kt` 와 **바이트까지 같은** 계약(명세 §17):
 * - 값 `ow1.<만든 시각 ms — 앞 0 없는 10진 1~16자리>.<서명>`.
 * - 서명 = HMAC-SHA256(열쇠 = OWNER_COOKIE_SECRET 의 UTF-8 바이트 **그대로 — 다듬지 않는다**,
 *   줄 = `study-owner` LF `ow1` LF `<만든 시각의 10진 글자>` — 끝 줄바꿈 없음)의 base64url(채움 없음 · 43자).
 * - 쓸 수 있는 열쇠: 공백뿐이 아니고 UTF-8 로 32바이트 이상(backend usableSecret 과 같다).
 * - 판정의 차례(backend verify 와 같은 낱말): no_secret → no_cookie → 둘 이상 · 꼴(malformed) → 서명(bad_signature, 상수 시간)
 *   → 미래(만든 시각 > 지금 + 60초 → malformed) → 수명(지금 > 만든 시각 + 30일 → expired; 정확히 30일은 통한다).
 * - 쿠키의 속성: `Domain=<OWNER_COOKIE_DOMAIN>; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax` — 지우기는 같은 이름 · Domain · Path 에 `Max-Age=0`.
 * - 도메인 설정의 꼴(isValidOwnerCookieDomain): 소문자 호스트 이름 · 조각 둘 이상 · 조각마다 [a-z0-9-] 1~63자(앞뒤 하이픈 없음) · 마지막 조각은 숫자만이 아님(IP 거절)
 *   · 전체 253자 이하 · 앞의 점 · 포트 · 경로 · 공백 · 대문자는 거절.
 * - 어드민의 호스트(ADMIN_ORIGIN 의 호스트)가 그 도메인과 같거나 그 아래(`.<도메인>` 으로 끝남 — 조각 단위)여야 브라우저가 쿠키를 받는다.
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 함수의 몸은 구현 워커가 채운다. */

export const OWNER_COOKIE_NAME = "study_owner";
export const OWNER_MARK_VERSION = "ow1";
export const OWNER_MARK_PURPOSE = "study-owner";
export const OWNER_SECRET_MINIMUM_BYTES = 32;
/** 수명 — 만든 시각에서 30일(쿠키의 Max-Age 와 같다). */
export const OWNER_MARK_LIFETIME_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
export const OWNER_COOKIE_MAX_AGE_SECONDS = 2_592_000;
/** 만든 시각이 지금보다 이만큼까지 앞서도 받는다(시계 차) — 넘으면 malformed. */
export const OWNER_MARK_FUTURE_TOLERANCE_MILLISECONDS = 60_000;

/** 판정 — backend OwnerReason 의 낱말 그대로. */
export type OwnerMarkReason = "no_secret" | "no_cookie" | "malformed" | "bad_signature" | "expired";

export type OwnerMarkVerdict =
  | { owner: true; createdAt: number; expiresAt: number }
  | { owner: false; reason: OwnerMarkReason };

/** 설정의 문제 — secret_unusable: OWNER_COOKIE_SECRET 이 없음 · 빈 · 공백뿐 · 32바이트 미만 / domain_invalid: OWNER_COOKIE_DOMAIN 이 없음 · 꼴이 틀림 /
 * admin_outside_domain: ADMIN_ORIGIN 의 호스트가 그 도메인과 같지도 아래도 아님(ADMIN_ORIGIN 을 해석하지 못해도) — 도메인이 맞을 때만 본다. */
export type OwnerMarkSettingsProblem = "secret_unusable" | "domain_invalid" | "admin_outside_domain";

export type OwnerMarkSettings =
  | { ok: true; domain: string }
  /** clearableDomain: 열쇠가 없어도 도메인이 맞고 어드민이 그 아래면 지우기는 된다(그 도메인) — 아니면 null(지울 수 없다) */
  | { ok: false; problems: OwnerMarkSettingsProblem[]; clearableDomain: string | null };

export function ownerMarkSignature(_secret: string, _createdAtMilliseconds: number): string {
  throw new Error("not implemented: ownerMarkSignature");
}

export function ownerMarkValue(_secret: string, _createdAtMilliseconds: number): string {
  throw new Error("not implemented: ownerMarkValue");
}

export function isUsableOwnerSecret(_secret: string | undefined): boolean {
  throw new Error("not implemented: isUsableOwnerSecret");
}

export function isValidOwnerCookieDomain(_domain: string): boolean {
  throw new Error("not implemented: isValidOwnerCookieDomain");
}

/** host 가 domain 과 같거나 그 아래인가(조각 단위 — `badexample.test` 는 `example.test` 의 아래가 아니다). */
export function isHostWithinDomain(_host: string, _domain: string): boolean {
  throw new Error("not implemented: isHostWithinDomain");
}

/** 문제의 차례: secret_unusable → domain_invalid → admin_outside_domain(도메인이 맞을 때만). */
export function checkOwnerMarkSettings(_input: { secret: string | undefined; domain: string; adminOrigin: string }): OwnerMarkSettings {
  throw new Error("not implemented: checkOwnerMarkSettings");
}

/** cookieValues = 요청에 실려 온 study_owner 의 값들(없으면 빈 목록). */
export function verifyOwnerMark(_cookieValues: readonly string[], _secret: string | undefined, _nowMilliseconds: number): OwnerMarkVerdict {
  throw new Error("not implemented: verifyOwnerMark");
}

/** `study_owner=<값>; Domain=<도메인>; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax` */
export function buildOwnerMarkCookieHeader(_value: string, _domain: string): string {
  throw new Error("not implemented: buildOwnerMarkCookieHeader");
}

/** `study_owner=; Domain=<도메인>; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` */
export function buildClearedOwnerMarkCookieHeader(_domain: string): string {
  throw new Error("not implemented: buildClearedOwnerMarkCookieHeader");
}
