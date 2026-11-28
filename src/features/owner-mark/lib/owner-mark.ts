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
 */
import { createHmac, timingSafeEqual } from "node:crypto";

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

/** 설정의 문제 → 화면 · 응답에 보이는 환경 변수의 이름(값은 보이지 않는다). */
export const OWNER_MARK_PROBLEM_SETTING_NAMES: Readonly<Record<OwnerMarkSettingsProblem, readonly string[]>> = {
  secret_unusable: ["OWNER_COOKIE_SECRET"],
  domain_invalid: ["OWNER_COOKIE_DOMAIN"],
  admin_outside_domain: ["ADMIN_ORIGIN", "OWNER_COOKIE_DOMAIN"],
};

/** 쿠키 값의 꼴 — 판 · 앞 0 없는 만든 시각(1~16자리) · 서명 43글자(backend VALUE_PATTERN 과 같다). */
const OWNER_MARK_VALUE_PATTERN = /^ow1\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_MAXIMUM_LENGTH = 253;

/** 만든 시각의 10진 글자에 서명한다 — 16자리 시각도 글자 그대로(수로 바꾸며 자리가 바뀌지 않게). */
function signatureOfText(secret: string, createdAtText: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${OWNER_MARK_PURPOSE}\n${OWNER_MARK_VERSION}\n${createdAtText}`)
    .digest("base64url");
}

export function ownerMarkSignature(secret: string, createdAtMilliseconds: number): string {
  return signatureOfText(secret, String(createdAtMilliseconds));
}

export function ownerMarkValue(secret: string, createdAtMilliseconds: number): string {
  return `${OWNER_MARK_VERSION}.${createdAtMilliseconds}.${ownerMarkSignature(secret, createdAtMilliseconds)}`;
}

export function isUsableOwnerSecret(secret: string | undefined): boolean {
  return secret !== undefined && secret.trim().length > 0 && Buffer.byteLength(secret, "utf8") >= OWNER_SECRET_MINIMUM_BYTES;
}

export function isValidOwnerCookieDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > DOMAIN_MAXIMUM_LENGTH) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

/** host 가 domain 과 같거나 그 아래인가(조각 단위 — `badexample.test` 는 `example.test` 의 아래가 아니다). */
export function isHostWithinDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** 문제의 차례: secret_unusable → domain_invalid → admin_outside_domain(도메인이 맞을 때만). */
export function checkOwnerMarkSettings(input: { secret: string | undefined; domain: string; adminOrigin: string }): OwnerMarkSettings {
  const problems: OwnerMarkSettingsProblem[] = [];
  if (!isUsableOwnerSecret(input.secret)) problems.push("secret_unusable");
  const domainValid = isValidOwnerCookieDomain(input.domain);
  if (!domainValid) problems.push("domain_invalid");
  else {
    const adminHost = URL.canParse(input.adminOrigin) ? new URL(input.adminOrigin).hostname : null;
    if (adminHost === null || !isHostWithinDomain(adminHost, input.domain)) problems.push("admin_outside_domain");
  }
  if (problems.length === 0) return { ok: true, domain: input.domain };
  const clearable = domainValid && !problems.includes("admin_outside_domain");
  return { ok: false, problems, clearableDomain: clearable ? input.domain : null };
}

/** 날 `Cookie` 머리글에서 이름이 정확히 study_owner 인 조각의 값들(명세 §18 — Next 의 cookies() 는 같은 이름이면 마지막 값 하나만 준다).
 * 조각은 `;` 로 나누고 앞뒤 공백을 다듬는다 · 이름은 첫 `=` 앞(글자까지 같아야 — 대소문자 · 접두 · 접미가 다르면 세지 않는다) · 값은 첫 `=` 뒤 그대로
 * (`=` · 따옴표가 들어 있어도 — 꼴은 verifyOwnerMark 가 본다) · 빈 값(`study_owner=`)도 하나로 센다 · `=` 없이 이름만인 조각(`study_owner`)은 빈 값으로 센다(닫힌 쪽)
 * · 머리글이 없으면 빈 목록. */
export function ownerCookieValuesFromHeader(cookieHeader: string | null): string[] {
  if (cookieHeader === null) return [];
  const values: string[] = [];
  for (const piece of cookieHeader.split(";")) {
    const trimmed = piece.trim();
    const equalsAt = trimmed.indexOf("=");
    const name = equalsAt < 0 ? trimmed : trimmed.slice(0, equalsAt);
    if (name === OWNER_COOKIE_NAME) values.push(equalsAt < 0 ? "" : trimmed.slice(equalsAt + 1));
  }
  return values;
}

/** cookieValues = 요청에 실려 온 study_owner 의 값들(없으면 빈 목록). */
export function verifyOwnerMark(cookieValues: readonly string[], secret: string | undefined, nowMilliseconds: number): OwnerMarkVerdict {
  if (secret === undefined || !isUsableOwnerSecret(secret)) return { owner: false, reason: "no_secret" };
  if (cookieValues.length === 0) return { owner: false, reason: "no_cookie" };
  if (cookieValues.length > 1) return { owner: false, reason: "malformed" };
  const match = OWNER_MARK_VALUE_PATTERN.exec(cookieValues[0]);
  if (match === null) return { owner: false, reason: "malformed" };
  const [, createdAtText, signature] = match;
  // 서명은 글자 그대로 상수 시간에 견준다 — 풀어서 바이트로 견주면 마지막 글자의 남는 비트만 다른 값도 같다고 본다
  const expected = Buffer.from(signatureOfText(secret, createdAtText), "ascii");
  const actual = Buffer.from(signature, "ascii");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { owner: false, reason: "bad_signature" };
  const createdAt = BigInt(createdAtText);
  if (createdAt > BigInt(nowMilliseconds) + BigInt(OWNER_MARK_FUTURE_TOLERANCE_MILLISECONDS)) return { owner: false, reason: "malformed" };
  if (BigInt(nowMilliseconds) > createdAt + BigInt(OWNER_MARK_LIFETIME_MILLISECONDS)) return { owner: false, reason: "expired" };
  const createdAtMilliseconds = Number(createdAtText);
  return { owner: true, createdAt: createdAtMilliseconds, expiresAt: createdAtMilliseconds + OWNER_MARK_LIFETIME_MILLISECONDS };
}

const OWNER_COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

/** `study_owner=<값>; Domain=<도메인>; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax` */
export function buildOwnerMarkCookieHeader(value: string, domain: string): string {
  return `${OWNER_COOKIE_NAME}=${value}; Domain=${domain}; Max-Age=${OWNER_COOKIE_MAX_AGE_SECONDS}; ${OWNER_COOKIE_ATTRIBUTES}`;
}

/** `study_owner=; Domain=<도메인>; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` */
export function buildClearedOwnerMarkCookieHeader(domain: string): string {
  return `${OWNER_COOKIE_NAME}=; Domain=${domain}; Max-Age=0; ${OWNER_COOKIE_ATTRIBUTES}`;
}
