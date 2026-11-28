/** 방문 기록 화면의 주소 입력 — 명세 §10.2 "`days=7|30|90`(기본 7)". 이 화면은 서버 자원 화면처럼 틀린 입력을 거절하지 않고 기본값(7)으로 —
 * 관측 서버에는 허용 목록의 값만 간다(observe VisitController.kt: 목록 밖은 422). */
import { describe, expect, it } from "vitest";
import { VISIT_DAYS, VISIT_DAYS_LABELS, VISIT_DEFAULT_DAYS, VISITS_PATH, parseVisitsQuery, visitsHref } from "@/features/visits/lib/visits-query";

describe("상수 — 관측 서버와 같은 허용 목록", () => {
  it("7 · 30 · 90 이 순서대로, 기본 7, 이름 7일 · 30일 · 90일, 경로 /visits", () => {
    expect([...VISIT_DAYS]).toEqual([7, 30, 90]);
    expect(VISIT_DEFAULT_DAYS).toBe(7);
    expect(VISIT_DAYS_LABELS).toEqual({ 7: "7일", 30: "30일", 90: "90일" });
    expect(VISITS_PATH).toBe("/visits");
  });
});

describe("parseVisitsQuery", () => {
  it.each([["7", 7], ["30", 30], ["90", 90]] as const)("days=%s → %i", (value, days) => {
    expect(parseVisitsQuery({ days: value })).toEqual({ days });
  });

  it("없음 · 빈 값 → 7", () => {
    expect(parseVisitsQuery({})).toEqual({ days: 7 });
    expect(parseVisitsQuery({ days: "" })).toEqual({ days: 7 });
    expect(parseVisitsQuery({ days: undefined })).toEqual({ days: 7 });
  });

  it.each(["1", "14", "365", "0", "-7", "07", "7.0", " 7", "7 ", "seven", "30d", "1e1", "９０"])("목록 밖 %j → 7(거절하지 않는다)", (value) => {
    expect(parseVisitsQuery({ days: value })).toEqual({ days: 7 });
  });

  it("같은 이름이 여러 번(배열) → 7 — 앞의 것을 고르지 않는다", () => {
    expect(parseVisitsQuery({ days: ["30", "90"] })).toEqual({ days: 7 });
  });

  it("다른 이름은 보지 않는다", () => {
    expect(parseVisitsQuery({ range: "30", day: "90", days: "30" })).toEqual({ days: 30 });
  });
});

describe("visitsHref", () => {
  it("기본값이어도 인자를 싣는다", () => {
    expect(visitsHref(7)).toBe("/visits?days=7");
    expect(visitsHref(30)).toBe("/visits?days=30");
    expect(visitsHref(90)).toBe("/visits?days=90");
  });
});
