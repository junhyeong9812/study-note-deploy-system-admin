import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "@/features/auth/lib/origin";
import { FAKE_ORIGIN } from "@/features/auth/lib/test-fakes";

describe("isAllowedOrigin", () => {
  it("설정값과 글자까지 같으면 통과", () => {
    expect(isAllowedOrigin(FAKE_ORIGIN, FAKE_ORIGIN)).toBe(true);
  });

  it.each([
    ["없음(null)", null],
    ["없음(undefined)", undefined],
    ["빈 문자열", ""],
    ["문자열 null", "null"],
    ["http", FAKE_ORIGIN.replace("https://", "http://")],
    ["다른 서브도메인", FAKE_ORIGIN.replace("admin.", "evil.admin.")],
    ["형제 서브도메인", FAKE_ORIGIN.replace("admin.", "www.")],
    ["뒤에 붙인 경로", `${FAKE_ORIGIN}/`],
    ["뒤에 붙인 경로 2", `${FAKE_ORIGIN}/login`],
    ["뒤에 붙인 도메인", `${FAKE_ORIGIN}.attacker.test`],
    ["포트 추가", `${FAKE_ORIGIN}:443`],
    ["대문자", FAKE_ORIGIN.toUpperCase()],
    ["앞뒤 공백", ` ${FAKE_ORIGIN} `],
  ])("거절 — %s", (_label, origin) => {
    expect(isAllowedOrigin(origin, FAKE_ORIGIN)).toBe(false);
  });

  it("설정값이 비면 무엇이든 거절(빈 Origin 포함)", () => {
    expect(isAllowedOrigin("", "")).toBe(false);
    expect(isAllowedOrigin(null, "")).toBe(false);
    expect(isAllowedOrigin(FAKE_ORIGIN, "")).toBe(false);
  });
});
