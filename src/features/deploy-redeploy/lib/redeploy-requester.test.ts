/** 접수의 requested_by — `admin:<계정>`, 명세 §10 의 허용 글자(`@` 없음) 안이어야 하고 아니면 master 를 부르기 전에 거절한다(null). */
import { describe, expect, it } from "vitest";
import { REQUESTED_BY_PATTERN, requestedByFor } from "@/features/deploy-redeploy/lib/redeploy-requester";

describe("requestedByFor", () => {
  it.each(["fake-admin-id-zq", "jun", "jun.kim_01", "A-Z.a-z_0-9"])("%s → admin:%s", (account) => {
    expect(requestedByFor(account)).toBe(`admin:${account}`);
    expect(`admin:${account}`).toMatch(REQUESTED_BY_PATTERN);
  });

  it.each([
    ["@ (메신저 멘션)", "jun@example.com"],
    ["@everyone", "@everyone"],
    ["공백", "jun kim"],
    ["한글", "준형"],
    ["콜론(⑫ 의 자리)", "jun:incident:1"],
    ["빈 값", ""],
    ["줄바꿈", "jun\nadmin"],
    ["슬래시", "jun/x"],
  ])("%s → null", (_label, account) => {
    expect(requestedByFor(account)).toBeNull();
  });

  it("전체 128자까지 — 계정 122자는 받고 123자는 거절", () => {
    expect(requestedByFor("a".repeat(122))).toBe(`admin:${"a".repeat(122)}`);
    expect(requestedByFor("a".repeat(123))).toBeNull();
  });

  it("허용 글자는 명세 §10 그대로 — @ 를 받지 않는다", () => {
    expect(REQUESTED_BY_PATTERN.source).toBe("^[A-Za-z0-9._:-]{1,128}$");
    expect("admin:a@b").not.toMatch(REQUESTED_BY_PATTERN);
  });
});
