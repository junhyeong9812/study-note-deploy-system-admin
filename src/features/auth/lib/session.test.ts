import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, buildClearedSessionCookieHeader,
  buildSessionCookieHeader, issueSessionToken, verifySessionToken,
} from "@/features/auth/lib/session";
import { FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";

const ISSUED_AT = Date.UTC(2026, 0, 1, 9, 0, 0);
const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";

function cookieAttributes(header: string): { name: string; value: string; attributes: string[] } {
  const [pair, ...rest] = header.split(";").map((part) => part.trim());
  const separator = pair.indexOf("=");
  return { name: pair.slice(0, separator), value: pair.slice(separator + 1), attributes: rest.map((part) => part.toLowerCase()) };
}

describe("세션 토큰", () => {
  it("12시간은 12 * 60 * 60 * 1000 밀리초", () => {
    expect(SESSION_LIFETIME_MILLISECONDS).toBe(43_200_000);
  });

  it("발급한 토큰은 같은 키로 검증되고 발급 시각을 돌려준다", () => {
    const token = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT);
    expect(verifySessionToken(token, FAKE_SIGNING_KEY, ISSUED_AT)).toEqual({ issuedAt: ISSUED_AT });
  });

  it("12시간 직전까지 유효하다", () => {
    const token = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT);
    expect(verifySessionToken(token, FAKE_SIGNING_KEY, ISSUED_AT + SESSION_LIFETIME_MILLISECONDS - 1)).not.toBeNull();
  });

  it("발급 뒤 정확히 12시간이 되면 무효(연장 없음)", () => {
    const token = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT);
    expect(verifySessionToken(token, FAKE_SIGNING_KEY, ISSUED_AT + SESSION_LIFETIME_MILLISECONDS)).toBeNull();
    expect(verifySessionToken(token, FAKE_SIGNING_KEY, ISSUED_AT + SESSION_LIFETIME_MILLISECONDS * 10)).toBeNull();
  });

  it("다른 키로 서명한 토큰은 세션 없음", () => {
    const token = issueSessionToken(OTHER_KEY, ISSUED_AT);
    expect(verifySessionToken(token, FAKE_SIGNING_KEY, ISSUED_AT)).toBeNull();
  });

  it("토큰의 어느 한 글자를 바꿔도 세션 없음(변조)", () => {
    const token = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT);
    for (let position = 0; position < token.length; position += 1) {
      const original = token[position];
      const replacement = original === "A" ? "B" : "A";
      const tampered = token.slice(0, position) + replacement + token.slice(position + 1);
      expect(verifySessionToken(tampered, FAKE_SIGNING_KEY, ISSUED_AT), `position ${position}`).toBeNull();
    }
  });

  it("뒤를 자르거나 덧붙인 토큰은 세션 없음", () => {
    const token = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT);
    expect(verifySessionToken(token.slice(0, -1), FAKE_SIGNING_KEY, ISSUED_AT)).toBeNull();
    expect(verifySessionToken(`${token}A`, FAKE_SIGNING_KEY, ISSUED_AT)).toBeNull();
  });

  it("다른 시각에 발급한 토큰의 조각을 섞으면 세션 없음", () => {
    const earlier = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT);
    const later = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT + 1000);
    expect(earlier).not.toBe(later);
    const half = Math.floor(earlier.length / 2);
    const spliced = later.slice(0, half) + earlier.slice(half);
    if (spliced !== earlier && spliced !== later) {
      expect(verifySessionToken(spliced, FAKE_SIGNING_KEY, ISSUED_AT + 1000)).toBeNull();
    }
  });

  it("발급 시각이 지금보다 미래면 세션 없음", () => {
    const token = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT + 60_000);
    expect(verifySessionToken(token, FAKE_SIGNING_KEY, ISSUED_AT)).toBeNull();
  });

  it.each([undefined, null, "", "abc", "a.b", "a.b.c", ".", "..", "%%%", " ".repeat(20)])(
    "형식 오류(%j) → 세션 없음", (malformed) => {
      expect(verifySessionToken(malformed, FAKE_SIGNING_KEY, ISSUED_AT)).toBeNull();
    });

  it("검증 키가 비면 어떤 토큰도 세션 없음", () => {
    const token = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT);
    expect(verifySessionToken(token, "", ISSUED_AT)).toBeNull();
  });

  it("빈 키로는 발급하지 않는다(빈 키가 아니면 발급된다)", () => {
    expect(issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT).length).toBeGreaterThan(0);
    expect(() => issueSessionToken("", ISSUED_AT)).toThrow();
  });
});

describe("세션 쿠키", () => {
  it("발급 쿠키 — HttpOnly · Secure · SameSite=Strict · Path=/ · 12시간", () => {
    const token = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT);
    const cookie = cookieAttributes(buildSessionCookieHeader(token));
    expect(cookie.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie.value).toBe(token);
    expect(cookie.attributes).toContain("httponly");
    expect(cookie.attributes).toContain("secure");
    expect(cookie.attributes).toContain("samesite=strict");
    expect(cookie.attributes).toContain("path=/");
    expect(cookie.attributes).toContain(`max-age=${SESSION_LIFETIME_MILLISECONDS / 1000}`);
    expect(cookie.attributes.some((attribute) => attribute.startsWith("domain="))).toBe(false);
  });

  it("삭제 쿠키 — 같은 이름 · 같은 경로 · 빈 값 · Max-Age=0 · 같은 보안 속성", () => {
    const cookie = cookieAttributes(buildClearedSessionCookieHeader());
    expect(cookie.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie.value).toBe("");
    expect(cookie.attributes).toContain("path=/");
    expect(cookie.attributes).toContain("max-age=0");
    expect(cookie.attributes).toContain("httponly");
    expect(cookie.attributes).toContain("secure");
    expect(cookie.attributes).toContain("samesite=strict");
  });
});
