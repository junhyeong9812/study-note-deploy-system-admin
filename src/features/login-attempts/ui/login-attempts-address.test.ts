/** 로그인 시도 기록 화면의 주소(순수) — 화면 주소 → 진입 함수의 입력(KST 칸 → UTC), 폼에 다시 채울 값, 조건 → 주소(더 보기). */
import { describe, expect, it } from "vitest";
import { parseLoginAttemptsQuery, type LoginAttemptsQuery } from "@/features/login-attempts/lib/login-attempts-query";
import {
  LOGIN_ATTEMPTS_PATH, loginAttemptsFormValues, loginAttemptsHref, loginAttemptsInput,
} from "@/features/login-attempts/ui/login-attempts-address";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const CURSOR = "2026-11-22T10:00:00.123Z_0f8fad5b-d9cb-469f-a165-70867728950e";

describe("loginAttemptsInput — 화면 주소 → 진입 함수의 입력", () => {
  it("KST 칸을 UTC 의 from · to 로 바꾸고 before · limit 은 그대로, 다른 이름은 넘기지 않는다", () => {
    expect(loginAttemptsInput({ from_kst: "2026-11-22T09:00", to_kst: "2026-11-22T10:30:15", before: CURSOR, limit: "20", service: "front", q: "x" }))
      .toEqual({ from: "2026-11-22T00:00:00Z", to: "2026-11-22T01:30:15Z", before: CURSOR, limit: "20" });
  });

  it("KST 칸이 비면 UTC 값 그대로(더 보기 주소)", () => {
    expect(loginAttemptsInput({ from_kst: "", from: "2026-11-22T00:00:00Z", to: "2026-11-22T01:00:00Z" }))
      .toEqual({ from: "2026-11-22T00:00:00Z", to: "2026-11-22T01:00:00Z", before: undefined, limit: undefined });
  });

  it("빈 칸으로 제출한 폼은 조건 없음으로 읽힌다(기본 건수 50)", () => {
    const parsed = parseLoginAttemptsQuery(loginAttemptsInput({ from_kst: "", to_kst: "", limit: "" }), NOW);
    expect(parsed).toEqual({ ok: true, query: { from: null, to: null, before: null, limit: 50 } });
  });

  it.each([
    ["읽을 수 없는 KST 칸", { from_kst: "2026-11-22T09:00Z" }, "from"],
    ["달력에 없는 시각", { to_kst: "2026-02-30T00:00" }, "to"],
    ["KST 칸과 UTC 값이 함께", { from_kst: "2026-11-22T09:00", from: "2026-11-22T00:00:00Z" }, "from"],
    ["KST 칸이 여러 번", { to_kst: ["2026-11-22T09:00", "2026-11-22T10:00"] }, "to"],
  ])("%s → 진입 함수가 그 이름으로 거절할 값(조용히 고르지 않는다)", (_label, input, field) => {
    const parsed = parseLoginAttemptsQuery(loginAttemptsInput(input), NOW);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.field).toBe(field);
  });
});

describe("loginAttemptsFormValues — 폼에 다시 채울 값", () => {
  it("KST 칸의 글자가 있으면 그대로(틀린 글자도), 없으면 UTC 값을 KST 로", () => {
    expect(loginAttemptsFormValues({ from_kst: "어제", to: "2026-11-22T01:00:00Z", limit: "999" }))
      .toEqual({ fromKst: "어제", toKst: "2026-11-22T10:00:00", limit: "999" });
    expect(loginAttemptsFormValues({})).toEqual({ fromKst: "", toKst: "", limit: "" });
  });
});

describe("loginAttemptsHref — 조건 → 주소", () => {
  it("null 인 조건 · 기본 건수는 넣지 않는다", () => {
    expect(loginAttemptsHref({ from: null, to: null, before: null, limit: 50 })).toBe(LOGIN_ATTEMPTS_PATH);
    expect(loginAttemptsHref({ from: null, to: null, before: null, limit: 20 })).toBe("/login-attempts?limit=20");
  });

  it("더 보기 주소 → 다시 읽으면 같은 조건(from · to · before · limit 을 잃지 않는다)", () => {
    const query: LoginAttemptsQuery = { from: "2026-11-01T00:00:00Z", to: "2026-11-22T12:00:00Z", before: CURSOR, limit: 7 };
    const href = loginAttemptsHref(query);
    const url = new URL(href, "https://admin.example.test");
    expect(url.pathname).toBe(LOGIN_ATTEMPTS_PATH);
    expect(Object.fromEntries(url.searchParams)).toEqual({ from: query.from, to: query.to, before: CURSOR, limit: "7" });
    expect(parseLoginAttemptsQuery(Object.fromEntries(url.searchParams), NOW)).toEqual({ ok: true, query });
  });
});
