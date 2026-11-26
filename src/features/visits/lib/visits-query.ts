/** 방문 기록 화면의 주소 입력(순수) — 명세 §10.2 "조회 `GET /visits/summary?days=7|30|90`(기본 7)".
 * 이 화면은 서버 자원 화면처럼 입력이 틀려도 거절하지 않는다 — 틀린 값은 기본값(7)으로 바꿔 화면을 띄운다(관측 서버에는 허용 목록의 값만 간다).
 *
 * 입력 이름(그 밖의 이름은 보지 않는다):
 * - `days`: "7" · "30" · "90" 글자 그대로 하나. 없음 · 빈 값 · 배열(같은 이름 여러 번) · 목록 밖(" 7" · "07" · "7.0" · "1" 등) → VISIT_DEFAULT_DAYS.
 *
 * 주소: visitsHref(days) = `/visits?days=<days>`(기본값이어도 인자를 싣는다 — 링크 셋이 같은 꼴). */
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const VISITS_PATH = "/visits";

/** 관측 서버의 허용 목록(observe VisitStore.kt SUMMARY_DAYS = setOf(7, 30, 90)) — 이 순서로 링크를 보인다. */
export const VISIT_DAYS = [7, 30, 90] as const;
export type VisitDays = (typeof VISIT_DAYS)[number];

/** 관측 서버의 기본값(observe VisitController.kt DEFAULT_DAYS = 7). */
export const VISIT_DEFAULT_DAYS: VisitDays = 7;

export const VISIT_DAYS_LABELS: Readonly<Record<VisitDays, string>> = { 7: "7일", 30: "30일", 90: "90일" };

export interface VisitsQuery {
  days: VisitDays;
}

export function parseVisitsQuery(input: SearchParamsInput): VisitsQuery {
  void input;
  throw new Error("구현 전");
}

export function visitsHref(days: VisitDays): string {
  void days;
  throw new Error("구현 전");
}
