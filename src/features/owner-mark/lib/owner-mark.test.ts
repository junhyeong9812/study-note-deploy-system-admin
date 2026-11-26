/** 주인 표시의 값 · 판정 · 설정 — 명세 §17 · backend(2a) OwnerMark.kt 와 바이트까지 같은 계약.
 * 벡터 넷은 backend 테스트에 박힌 값 그대로다(어드민의 서명이 이 값을 내야 backend 가 받는다). */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OWNER_COOKIE_MAX_AGE_SECONDS, OWNER_COOKIE_NAME, OWNER_MARK_FUTURE_TOLERANCE_MILLISECONDS, OWNER_MARK_LIFETIME_MILLISECONDS, OWNER_SECRET_MINIMUM_BYTES,
  buildClearedOwnerMarkCookieHeader, buildOwnerMarkCookieHeader, checkOwnerMarkSettings, isHostWithinDomain, isUsableOwnerSecret, isValidOwnerCookieDomain,
  ownerMarkSignature, ownerMarkValue, verifyOwnerMark,
} from "@/features/owner-mark/lib/owner-mark";

const VECTOR_SECRET = "0123456789abcdef0123456789abcdef";
const KOREAN_SECRET = "주인-표시-열쇠-테스트용-가짜-값-0001";
const NOW = 1_764_000_000_000;

function attributesOf(header: string): { pair: string; attributes: string[] } {
  const [pair, ...attributes] = header.split(/;\s*/);
  return { pair, attributes };
}

describe("1 서명 — backend 의 벡터 넷이 그대로 나온다", () => {
  it.each([
    [VECTOR_SECRET, 1_764_000_000_000, "ow1.1764000000000.SsdDQjHHXxd2qHi5SeD58PoS0zumVJNEKlcZgUAgM54"],
    [VECTOR_SECRET, 1_767_225_600_000, "ow1.1767225600000.sN1bOvnOjkw-1Lzl0q8JZyAy4DOgxdihMeFWsU-ZkUU"],
    [VECTOR_SECRET, 1, "ow1.1._8DX2XdHgwNIJM_xiXI2zViKyiCJhtQzYppQC3l_JEs"],
    [KOREAN_SECRET, 1_764_000_000_000, "ow1.1764000000000.aDTdYf2XgdlZ_ST20FLwk-h6y6b7mS_JJyFiYHvpB-Q"],
  ] as const)("열쇠 %j · 시각 %d → %s", (secret, createdAt, expected) => {
    expect(ownerMarkValue(secret, createdAt)).toBe(expected);
    expect(ownerMarkSignature(secret, createdAt)).toBe(expected.split(".")[2]);
  });

  it("한글 열쇠는 UTF-8 로 49바이트", () => {
    expect(Buffer.byteLength(KOREAN_SECRET, "utf8")).toBe(49);
  });

  it("서명하는 줄 — `study-owner` LF `ow1` LF `<시각>`, 끝 줄바꿈 없음(끝에 LF 를 붙인 서명과 다르다)", () => {
    const line = "study-owner\now1\n1764000000000";
    expect(ownerMarkSignature(VECTOR_SECRET, NOW)).toBe(createHmac("sha256", Buffer.from(VECTOR_SECRET, "utf8")).update(line).digest("base64url"));
    expect(ownerMarkSignature(VECTOR_SECRET, NOW)).not.toBe(createHmac("sha256", VECTOR_SECRET).update(`${line}\n`).digest("base64url"));
  });

  it("열쇠를 다듬지 않는다 — 앞뒤 공백이 낀 열쇠는 그 바이트 그대로 서명한다(다듬은 열쇠의 서명과 다르다)", () => {
    const padded = `  ${VECTOR_SECRET}\t `;
    const expected = createHmac("sha256", Buffer.from(padded, "utf8")).update("study-owner\now1\n1764000000000").digest("base64url");
    expect(ownerMarkSignature(padded, NOW)).toBe(expected);
    expect(ownerMarkSignature(padded, NOW)).not.toBe(ownerMarkSignature(VECTOR_SECRET, NOW));
  });
});

describe("1 쓸 수 있는 열쇠 — 공백뿐이 아니고 UTF-8 32바이트 이상(backend 와 같은 판정)", () => {
  it.each([
    ["없음", undefined, false],
    ["빈 글자", "", false],
    ["공백뿐 40자", " ".repeat(40), false],
    ["줄바꿈 · 탭뿐", "\n\t".repeat(20), false],
    ["31바이트", "a".repeat(31), false],
    ["32바이트", "a".repeat(32), true],
    ["한글 11자 = 33바이트", "가".repeat(11), true],
    ["한글 10자 = 30바이트(글자 수는 10)", "가".repeat(10), false],
    ["앞뒤 공백 포함 32바이트(다듬으면 30)", ` ${"a".repeat(30)} `, true],
  ] as const)("%s → %s", (_label, secret, usable) => {
    expect(OWNER_SECRET_MINIMUM_BYTES).toBe(32);
    expect(isUsableOwnerSecret(secret)).toBe(usable);
  });
});

describe("5 판정 — backend verify 와 같은 차례 · 같은 낱말", () => {
  /** 뼈대에서 모듈을 읽을 때 던지지 않게 — 사례 안에서 만든다. */
  const valueNow = () => ownerMarkValue(VECTOR_SECRET, NOW);

  it("맞는 값 → 주인 · 만든 시각 · 끝나는 시각(만든 시각 + 30일)", () => {
    expect(OWNER_MARK_LIFETIME_MILLISECONDS).toBe(2_592_000_000);
    expect(verifyOwnerMark([valueNow()], VECTOR_SECRET, NOW + 1_000)).toEqual({ owner: true, createdAt: NOW, expiresAt: NOW + 2_592_000_000 });
  });

  it.each([
    ["열쇠 없음", () => [valueNow()], undefined, "no_secret"],
    ["열쇠가 31바이트", () => [valueNow()], "a".repeat(31), "no_secret"],
    ["쿠키 없음", () => [], VECTOR_SECRET, "no_cookie"],
    ["열쇠가 없으면 쿠키가 없어도 no_secret(차례)", () => [], undefined, "no_secret"],
    ["같은 이름이 둘", () => [valueNow(), valueNow()], VECTOR_SECRET, "malformed"],
    ["판이 다름", () => [valueNow().replace(/^ow1/, "ow2")], VECTOR_SECRET, "malformed"],
    ["시각에 앞 0", () => [`ow1.0${NOW}.${ownerMarkSignature(VECTOR_SECRET, NOW)}`], VECTOR_SECRET, "malformed"],
    ["시각 17자리", () => [`ow1.12345678901234567.${"A".repeat(43)}`], VECTOR_SECRET, "malformed"],
    ["서명 42자", () => [valueNow().slice(0, -1)], VECTOR_SECRET, "malformed"],
    ["서명에 +(base64 표준)", () => [valueNow().slice(0, -1) + "+"], VECTOR_SECRET, "malformed"],
    ["빈 값", () => [""], VECTOR_SECRET, "malformed"],
    ["다른 열쇠로 서명", () => [ownerMarkValue("fedcba9876543210fedcba9876543210", NOW)], VECTOR_SECRET, "bad_signature"],
    ["시각을 고침(서명은 그대로)", () => [`ow1.${NOW + 1}.${ownerMarkSignature(VECTOR_SECRET, NOW)}`], VECTOR_SECRET, "bad_signature"],
    ["다듬은 열쇠로 확인(만든 쪽은 공백이 낀 열쇠)", () => [ownerMarkValue(`  ${VECTOR_SECRET}  `, NOW)], VECTOR_SECRET, "bad_signature"],
  ] as [string, () => string[], string | undefined, string][])("%s → %s", (_label, makeValues, secret, reason) => {
    expect(verifyOwnerMark(makeValues(), secret, NOW + 1_000)).toEqual({ owner: false, reason });
  });

  it("미래 — 60초까지는 받고, 넘으면 malformed", () => {
    expect(OWNER_MARK_FUTURE_TOLERANCE_MILLISECONDS).toBe(60_000);
    expect(verifyOwnerMark([valueNow()], VECTOR_SECRET, NOW - 60_000)).toMatchObject({ owner: true });
    expect(verifyOwnerMark([valueNow()], VECTOR_SECRET, NOW - 60_001)).toEqual({ owner: false, reason: "malformed" });
  });

  it("수명 — 정확히 30일은 받고, 1ms 넘으면 expired", () => {
    expect(verifyOwnerMark([valueNow()], VECTOR_SECRET, NOW + OWNER_MARK_LIFETIME_MILLISECONDS)).toMatchObject({ owner: true });
    expect(verifyOwnerMark([valueNow()], VECTOR_SECRET, NOW + OWNER_MARK_LIFETIME_MILLISECONDS + 1)).toEqual({ owner: false, reason: "expired" });
  });

  it("16자리 시각(안전한 정수 너머)도 던지지 않고 판정한다 — 서명은 글자 그대로의 시각에", () => {
    const createdText = "9007199254740993";
    const signature = createHmac("sha256", VECTOR_SECRET).update(`study-owner\now1\n${createdText}`).digest("base64url");
    expect(verifyOwnerMark([`ow1.${createdText}.${signature}`], VECTOR_SECRET, NOW)).toEqual({ owner: false, reason: "malformed" });   // 먼 미래
  });
});

describe("2 도메인 설정의 꼴", () => {
  it.each(["example.test", "study.example.test", "a-b.example.test", "x1.example.test", "xn--3e0b707e.test"])("%s → 받는다", (domain) => {
    expect(isValidOwnerCookieDomain(domain)).toBe(true);
  });

  it.each([
    ["빈 글자", ""], ["한 조각(com)", "com"], ["앞의 점", ".example.test"], ["끝의 점", "example.test."], ["IPv4", "192.168.0.10"],
    ["포트", "example.test:443"], ["경로", "example.test/path"], ["scheme", "https://example.test"], ["공백", "example .test"],
    ["앞뒤 공백", " example.test "], ["대문자", "Example.test"], ["앞 하이픈", "-a.example.test"], ["뒤 하이픈", "a-.example.test"],
    ["빈 조각", "a..example.test"], ["밑줄", "a_b.example.test"], ["64자 조각", `${"a".repeat(64)}.test`], ["255자(63자 조각 넷)", ["a", "b", "c", "d"].map((letter) => letter.repeat(63)).join(".")],
    ["IPv6", "[::1]"], ["와일드카드", "*.example.test"],
  ])("%s → 거절", (_label, domain) => {
    expect(isValidOwnerCookieDomain(domain)).toBe(false);
  });

  it("호스트가 도메인과 같거나 그 아래 — 조각 단위로", () => {
    expect(isHostWithinDomain("admin.example.test", "example.test")).toBe(true);
    expect(isHostWithinDomain("example.test", "example.test")).toBe(true);
    expect(isHostWithinDomain("a.b.example.test", "example.test")).toBe(true);
    expect(isHostWithinDomain("badexample.test", "example.test")).toBe(false);
    expect(isHostWithinDomain("admin.example.test", "n.example.test")).toBe(false);
    expect(isHostWithinDomain("example.test", "admin.example.test")).toBe(false);
    expect(isHostWithinDomain("admin.other.test", "example.test")).toBe(false);
  });
});

describe("2 설정의 판정 — 열쇠 · 도메인 · 어드민의 주소", () => {
  const good = { secret: VECTOR_SECRET, domain: "example.test", adminOrigin: "https://admin.example.test" };

  it("모두 맞으면 ok · 도메인", () => {
    expect(checkOwnerMarkSettings(good)).toEqual({ ok: true, domain: "example.test" });
  });

  it.each([
    ["열쇠 없음", { secret: undefined }, ["secret_unusable"], "example.test"],
    ["열쇠 짧음", { secret: "short" }, ["secret_unusable"], "example.test"],
    ["도메인 없음", { domain: "" }, ["domain_invalid"], null],
    ["도메인 꼴이 틀림", { domain: ".example.test" }, ["domain_invalid"], null],
    ["어드민이 그 도메인 밖", { domain: "other.test" }, ["admin_outside_domain"], null],
    ["어드민 주소를 해석하지 못함", { adminOrigin: "" }, ["admin_outside_domain"], null],
    ["열쇠 없음 + 도메인 없음", { secret: "", domain: "" }, ["secret_unusable", "domain_invalid"], null],
    ["열쇠 없음 + 어드민 밖", { secret: undefined, domain: "other.test" }, ["secret_unusable", "admin_outside_domain"], null],
  ] as [string, Partial<typeof good>, string[], string | null][])("%s → %j · 지울 수 있는 도메인 %j", (_label, override, problems, clearableDomain) => {
    expect(checkOwnerMarkSettings({ ...good, ...override })).toEqual({ ok: false, problems, clearableDomain });
  });
});

describe("3 · 4 쿠키의 머리글 — 속성을 하나씩 값으로", () => {
  it("심기: study_owner=<값>; Domain; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax — 다른 속성 없음", () => {
    expect(OWNER_COOKIE_NAME).toBe("study_owner");
    expect(OWNER_COOKIE_MAX_AGE_SECONDS).toBe(2_592_000);
    const value = ownerMarkValue(VECTOR_SECRET, NOW);
    const { pair, attributes } = attributesOf(buildOwnerMarkCookieHeader(value, "example.test"));
    expect(pair).toBe(`study_owner=${value}`);
    expect(new Set(attributes)).toEqual(new Set(["Domain=example.test", "Path=/", "Max-Age=2592000", "Secure", "HttpOnly", "SameSite=Lax"]));
    expect(attributes).toHaveLength(6);
  });

  it("지우기: 같은 이름 · 같은 Domain · Path 에 빈 값 · Max-Age=0", () => {
    const { pair, attributes } = attributesOf(buildClearedOwnerMarkCookieHeader("example.test"));
    expect(pair).toBe("study_owner=");
    expect(new Set(attributes)).toEqual(new Set(["Domain=example.test", "Path=/", "Max-Age=0", "Secure", "HttpOnly", "SameSite=Lax"]));
    expect(attributes).toHaveLength(6);
  });
});
