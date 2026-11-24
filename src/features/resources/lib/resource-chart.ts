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

const NICE_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;

/** target(> 0, 유한) 이상인 1 · 2 · 2.5 · 5 × 10^k 가운데 가장 작은 수. 음의 k 는 나누어 만든다(0.1 의 이진 오차를 곱하지 않게).
 * log10 이 한 자리 낮게 나와도 × 10 이 받친다. */
function niceCeiling(target: number): number {
  const exponent = Math.floor(Math.log10(target));
  const scaled = (multiplier: number) => (exponent >= 0 ? multiplier * 10 ** exponent : multiplier / 10 ** -exponent);
  return NICE_MULTIPLIERS.map(scaled).find((candidate) => candidate >= target) ?? scaled(20);
}

function axisTop(axis: ChartAxis, lines: readonly ChartLineInput[]): number {
  if (axis.kind === "percent") return 100;
  const minimumTop = axis.minimumTop !== undefined && axis.minimumTop > 0 && Number.isFinite(axis.minimumTop) ? axis.minimumTop : null;
  let maximum = 0;
  for (const line of lines) for (const point of line.points) if (point.value !== null && Number.isFinite(point.value)) maximum = Math.max(maximum, point.value);
  if (maximum === 0) return minimumTop ?? 1;   // 값이 없거나 최댓값이 0 — 0 으로 나누지 않는다
  const top = niceCeiling(maximum * CHART_AUTO_HEADROOM);
  if (!Number.isFinite(top)) return minimumTop ?? 1;   // 1e308 같은 값 — 꼭대기로 잘려 그려진다
  return Math.max(top, minimumTop ?? 0);
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(highest, Math.max(lowest, value));
}

/** 소수 한 자리 반올림(-0 은 0). */
function roundCoordinate(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

export function buildChartGeometry(input: ChartInput): ChartGeometry {
  const { width, height, fromMilliseconds, toMilliseconds } = input;
  const top = axisTop(input.axis, input.lines);
  const span = toMilliseconds - fromMilliseconds;
  const step = Number.isFinite(input.stepMilliseconds) && input.stepMilliseconds > 0 ? input.stepMilliseconds : CHART_FALLBACK_STEP_MILLISECONDS;
  const gapLimit = step * CHART_GAP_FACTOR;
  const xOf = (atMilliseconds: number) => (span > 0 ? roundCoordinate(clamp((atMilliseconds - fromMilliseconds) / span * width, 0, width)) : 0);
  const yOf = (value: number) => roundCoordinate(height - clamp(value / top, 0, 1) * height);

  const lines = input.lines.map((line): ChartLine => {
    const segments: ChartCoordinate[][] = [];
    let current: ChartCoordinate[] = [];
    let previousAt: number | null = null;
    for (const point of line.points) {
      const drawable = point.value !== null && Number.isFinite(point.value) && Number.isFinite(point.atMilliseconds);
      if (!drawable) {   // 값이 없는 점은 선을 끊는다(0 으로 그리지 않는다)
        if (current.length > 0) segments.push(current);
        current = [];
        previousAt = null;
        continue;
      }
      if (previousAt !== null && point.atMilliseconds - previousAt > gapLimit && current.length > 0) {   // 빈 구간은 잇지 않는다
        segments.push(current);
        current = [];
      }
      current.push({ x: xOf(point.atMilliseconds), y: yOf(point.value as number) });
      previousAt = point.atMilliseconds;
    }
    if (current.length > 0) segments.push(current);
    const drawnSegments = segments.filter((segment) => segment.length >= 2);
    const isolatedPoints = segments.filter((segment) => segment.length === 1).map(([coordinate]) => coordinate);
    const path = drawnSegments
      .map((segment) => segment.map((coordinate, index) => `${index === 0 ? "M" : "L"}${coordinate.x} ${coordinate.y}`).join(" "))
      .join(" ");
    return {
      key: line.key, label: line.label, role: line.role, path, segmentCount: drawnSegments.length, isolatedPoints,
      drawnPointCount: segments.reduce((count, segment) => count + segment.length, 0),
    };
  });

  return {
    width, height, top, lines,
    yTicks: [{ value: 0, position: height }, { value: top / 2, position: height / 2 }, { value: top, position: 0 }],
    xTicks: [
      { value: fromMilliseconds, position: 0 },
      { value: fromMilliseconds + span / 2, position: span > 0 ? width / 2 : 0 },
      { value: toMilliseconds, position: span > 0 ? width : 0 },
    ],
  };
}
