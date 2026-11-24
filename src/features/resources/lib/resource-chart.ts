/** 선 그래프의 좌표 계산(순수) — 서버에서 그리는 SVG(명세 §2.6 "차트 라이브러리 없음, 브라우저 스크립트 없음")의 `<path d>` 글자와 축 눈금.
 * 그림 영역은 (0,0)~(width,height), y 는 아래로 자란다(값 0 = height, 축의 꼭대기 = 0).
 *
 * x: (at − from) ÷ (to − from) × width 를 [0, width] 로 자른다 — 첫 점이 from 보다 앞서도(5분 평균의 구간 시작 — §15.1) 그림 영역 안(x = 0)에 둔다.
 *    to ≤ from 이면 모든 x = 0.
 * y 축:
 * - percent: 0 ~ 100 고정. 100 을 넘는 값은 꼭대기(y = 0)로, 0 아래는 바닥으로 자른다.
 * - auto: 0 ~ top. top = niceCeiling(모든 선의 유한한 값의 최댓값 × CHART_AUTO_HEADROOM, minimumTop) — 1 · 2 · 2.5 · 5 × 10^k 중 그 값 이상인 가장 작은 수.
 *   값이 없거나 최댓값이 0 이면 top = minimumTop ?? 1(0 으로 나누지 않는다). minimumTop 이 있으면 top 은 그보다 작지 않다(컨테이너 CPU 는 100).
 * 선 끊기: 점 목록은 시각 오름차순이라고 본다. 값이 null · 유한하지 않은 점은 선을 끊는다. 이웃한 두 점의 시각 차가
 *   stepMilliseconds × CHART_GAP_FACTOR 를 넘으면 끊는다(관측 서버는 값이 없는 칸에 점을 만들지 않는다 — §10.3). stepMilliseconds 가 양의 유한한 수가 아니면
 *   CHART_FALLBACK_STEP_MILLISECONDS 로 본다.
 * 경로 글자: 끊긴 조각마다 `M x y` 로 시작해 `L x y` 를 잇고 조각 사이는 공백 하나. 점 하나짜리 조각은 경로에 넣지 않고 isolatedPoints 로 준다
 *   (선 없이 표시만 — 그림만으로 전하지 않게 UI 가 작은 표시를 그린다). 좌표는 소수 한 자리로 반올림한 10진 글자(`12.3` · `0` · 지수 표기 없음).
 *   어떤 입력에도 NaN · Infinity 가 글자에 나오지 않는다. 글자 길이는 점 하나에 CHART_PATH_CHARACTERS_PER_POINT 자를 넘지 않는다(width · height ≤ 10000).
 * 눈금: y 는 0 · top/2 · top(값과 y), x 는 from · 가운데 · to(시각과 x). */

export const CHART_GAP_FACTOR = 1.5;
export const CHART_AUTO_HEADROOM = 1.1;
export const CHART_FALLBACK_STEP_MILLISECONDS = 30_000;
export const CHART_PATH_CHARACTERS_PER_POINT = 16;

export interface ChartPointInput {
  atMilliseconds: number;
  value: number | null;
}

export type ChartLineRole = "average" | "maximum";

export interface ChartLineInput {
  key: string;
  label: string;
  role: ChartLineRole;
  points: readonly ChartPointInput[];
}

export type ChartAxis = { kind: "percent" } | { kind: "auto"; minimumTop?: number };

export interface ChartInput {
  fromMilliseconds: number;
  toMilliseconds: number;
  stepMilliseconds: number;
  axis: ChartAxis;
  width: number;
  height: number;
  lines: readonly ChartLineInput[];
}

export interface ChartCoordinate {
  x: number;
  y: number;
}

export interface ChartLine {
  key: string;
  label: string;
  role: ChartLineRole;
  /** `<path d>` — 두 점 이상인 조각들. 그릴 조각이 없으면 "" */
  path: string;
  /** 두 점 이상인 조각의 수 */
  segmentCount: number;
  /** 점 하나짜리 조각의 좌표 */
  isolatedPoints: ChartCoordinate[];
  /** 그린 점(경로 + 하나짜리)의 수 — 값이 있는 점의 수와 같다 */
  drawnPointCount: number;
}

export interface ChartTick {
  value: number;
  position: number;
}

export interface ChartGeometry {
  width: number;
  height: number;
  /** y 축 꼭대기의 값(percent 면 100) */
  top: number;
  lines: ChartLine[];
  /** value = 값, position = y */
  yTicks: ChartTick[];
  /** value = 시각(밀리초), position = x */
  xTicks: ChartTick[];
}

export function buildChartGeometry(input: ChartInput): ChartGeometry {
  void input;
  throw new Error("not implemented");
}
