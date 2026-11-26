/** 통신 지도의 기간 고르기(순수) — 뼈대(T8 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * 주소 인자 `range` 하나: `5m`(기본) · `1h` · `24h`(관측 서버 `/traffic/map` 의 최대 — TrafficController.kt:223). 틀리면 기본값(거절하지 않는다). */
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export type TrafficMapRange = "5m" | "1h" | "24h";
export const TRAFFIC_MAP_RANGES: readonly TrafficMapRange[] = ["5m", "1h", "24h"];
export const TRAFFIC_MAP_DEFAULT_RANGE: TrafficMapRange = "5m";
export const TRAFFIC_MAP_RANGE_MILLISECONDS: Readonly<Record<TrafficMapRange, number>> = { "5m": 5 * 60_000, "1h": 60 * 60_000, "24h": 24 * 60 * 60_000 };
export const TRAFFIC_MAP_RANGE_LABELS: Readonly<Record<TrafficMapRange, string>> = { "5m": "5분", "1h": "1시간", "24h": "24시간" };

export function parseTrafficMapRange(input: SearchParamsInput): TrafficMapRange {
  void input;
  throw new Error("T8: 구현 전");
}

/** 지금부터 거꾸로 그 기간 — ISO(밀리초 3자리). */
export function trafficMapWindow(range: TrafficMapRange, now: number): { from: string; to: string } {
  void range; void now;
  throw new Error("T8: 구현 전");
}
