/** 선 그래프의 좌표 계산 — 명세 §2.6 "그래프는 서버에서 그린 SVG(차트 라이브러리 없음, 브라우저 스크립트 없음)" · §5 "그래프 SVG 의 좌표 계산
 * (빈 계열 · 점 하나 · 값이 전부 같음 · 구멍 난 구간)" · §10.3 "값이 없는 구간은 점을 만들지 않는다(0 으로 채우지 않는다)" ·
 * §15.1 "첫 점의 시각이 from 보다 최대 5분 앞설 수 있다" · §11.6 "점은 500개를 넘지 않는다". */
import { describe, expect, it } from "vitest";
import {
  CHART_AUTO_HEADROOM, CHART_FALLBACK_STEP_MILLISECONDS, CHART_GAP_FACTOR, CHART_PATH_CHARACTERS_PER_POINT, buildChartGeometry,
  type ChartAxis, type ChartInput, type ChartLineInput, type ChartPointInput,
} from "@/features/resources/lib/resource-chart";

const FROM = Date.UTC(2026, 10, 24, 11, 0, 0, 0);
const HOUR = 60 * 60 * 1000;
const TO = FROM + HOUR;
const STEP = 30_000;   // 1시간의 원본 간격(3600000 ÷ 500 = 7200 → 30초 단위로 올림)
const WIDTH = 600;
const HEIGHT = 160;
const PERCENT: ChartAxis = { kind: "percent" };

function line(points: ChartPointInput[], overrides: Partial<ChartLineInput> = {}): ChartLineInput {
  return { key: "cpu_pct", label: "평균", role: "average", points, ...overrides };
}

function at(offsetMilliseconds: number, value: number | null): ChartPointInput {
  return { atMilliseconds: FROM + offsetMilliseconds, value };
}

function input(lines: ChartLineInput[], overrides: Partial<ChartInput> = {}): ChartInput {
  return { fromMilliseconds: FROM, toMilliseconds: TO, stepMilliseconds: STEP, axis: PERCENT, width: WIDTH, height: HEIGHT, lines, ...overrides };
}

/** 경로 글자의 모든 수 */
function numbersIn(path: string): number[] {
  return [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

function expectFiniteGeometry(geometry: ReturnType<typeof buildChartGeometry>) {
  const text = JSON.stringify(geometry);
  expect(text).not.toMatch(/NaN|Infinity|null/);
  for (const chartLine of geometry.lines) {
    expect(chartLine.path).not.toMatch(/NaN|Infinity|e/);
    for (const value of numbersIn(chartLine.path)) expect(Number.isFinite(value)).toBe(true);
    for (const point of chartLine.isolatedPoints) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
  }
  expect(Number.isFinite(geometry.top) && geometry.top > 0).toBe(true);
  for (const tick of [...geometry.yTicks, ...geometry.xTicks]) expect(Number.isFinite(tick.value) && Number.isFinite(tick.position)).toBe(true);
}

describe("상수", () => {
  it("끊는 기준 1.5배 · 여유 1.1배 · 간격을 모르면 30초 · 점 하나에 16자", () => {
    expect(CHART_GAP_FACTOR).toBe(1.5);
    expect(CHART_AUTO_HEADROOM).toBe(1.1);
    expect(CHART_FALLBACK_STEP_MILLISECONDS).toBe(30_000);
    expect(CHART_PATH_CHARACTERS_PER_POINT).toBe(16);
  });
});

describe("점의 수", () => {
  it("선이 없다 — lines 빈 배열, 축은 그대로", () => {
    const geometry = buildChartGeometry(input([]));
    expect(geometry.lines).toEqual([]);
    expect(geometry).toMatchObject({ width: WIDTH, height: HEIGHT, top: 100 });
    expectFiniteGeometry(geometry);
  });

  it("점 0개 — 경로 \"\", 조각 0, 하나짜리 없음", () => {
    const [chartLine] = buildChartGeometry(input([line([])])).lines;
    expect(chartLine).toEqual({ key: "cpu_pct", label: "평균", role: "average", path: "", segmentCount: 0, isolatedPoints: [], drawnPointCount: 0 });
  });

  it("점 1개 — 선은 없고 하나짜리 표시 하나", () => {
    const [chartLine] = buildChartGeometry(input([line([at(30 * 60 * 1000, 50)])])).lines;
    expect(chartLine.path).toBe("");
    expect(chartLine.segmentCount).toBe(0);
    expect(chartLine.isolatedPoints).toEqual([{ x: 300, y: 80 }]);
    expect(chartLine.drawnPointCount).toBe(1);
  });

  it("이웃한 세 점 — M 하나에 L 둘", () => {
    const [chartLine] = buildChartGeometry(input([line([at(0, 0), at(STEP, 50), at(2 * STEP, 100)])])).lines;
    expect(chartLine.path).toBe("M0 160 L5 80 L10 0");
    expect(chartLine.segmentCount).toBe(1);
    expect(chartLine.isolatedPoints).toEqual([]);
    expect(chartLine.drawnPointCount).toBe(3);
  });

  it("좌표는 소수 한 자리 반올림 · 정수는 소수점 없이", () => {
    const [chartLine] = buildChartGeometry(input([line([at(10_000, 100 / 3), at(20_000, 25)])])).lines;
    // x = 10000/3600000×600 = 1.666… → 1.7 · y = 160 − 33.33…×1.6 = 106.666… → 106.7 · x = 3.333… → 3.3 · y = 120
    expect(chartLine.path).toBe("M1.7 106.7 L3.3 120");
  });
});

describe("빈 구간은 선을 잇지 않는다", () => {
  it("간격이 step × 1.5 를 넘으면 끊는다 — 두 조각", () => {
    const points = [at(0, 10), at(STEP, 20), at(4 * STEP, 30), at(5 * STEP, 40)];
    const [chartLine] = buildChartGeometry(input([line(points)])).lines;
    expect(chartLine.path).toBe("M0 144 L5 128 M20 112 L25 96");
    expect(chartLine.segmentCount).toBe(2);
    expect(chartLine.drawnPointCount).toBe(4);
  });

  it("간격이 정확히 step × 1.5 면 잇는다(넘을 때만 끊는다)", () => {
    const [chartLine] = buildChartGeometry(input([line([at(0, 10), at(STEP * 1.5, 10)])])).lines;
    expect(chartLine.segmentCount).toBe(1);
    expect(chartLine.path).toBe("M0 144 L7.5 144");
  });

  it("끊긴 뒤 혼자 남은 점은 하나짜리 표시", () => {
    const [chartLine] = buildChartGeometry(input([line([at(0, 10), at(STEP, 20), at(10 * STEP, 50)])])).lines;
    expect(chartLine.path).toBe("M0 144 L5 128");
    expect(chartLine.isolatedPoints).toEqual([{ x: 50, y: 80 }]);
    expect(chartLine.drawnPointCount).toBe(3);
  });

  it("값이 null 인 점은 끊는다(0 으로 그리지 않는다)", () => {
    const [chartLine] = buildChartGeometry(input([line([at(0, 10), at(STEP, 20), at(2 * STEP, null), at(3 * STEP, 30), at(4 * STEP, 40)])])).lines;
    expect(chartLine.path).toBe("M0 144 L5 128 M15 112 L20 96");
    expect(chartLine.drawnPointCount).toBe(4);
    expect(numbersIn(chartLine.path)).not.toContain(HEIGHT);   // null 이 바닥(0%)으로 그려지지 않았다
  });

  it("유한하지 않은 값(NaN · Infinity)도 null 처럼 끊는다", () => {
    const [chartLine] = buildChartGeometry(input([line([at(0, 10), at(STEP, Number.NaN), at(2 * STEP, Number.POSITIVE_INFINITY), at(3 * STEP, 20)])])).lines;
    expect(chartLine.path).toBe("");
    expect(chartLine.isolatedPoints).toEqual([{ x: 0, y: 144 }, { x: 15, y: 128 }]);
    expectFiniteGeometry(buildChartGeometry(input([line([at(0, Number.NaN)])])));
  });

  it("간격이 큰 계열(5분 평균) — step 이 크면 그 간격의 점은 잇는다", () => {
    const step = 5 * 60 * 1000;
    const [chartLine] = buildChartGeometry(input([line([at(0, 10), at(step, 20), at(2 * step, 30)])], { stepMilliseconds: step })).lines;
    expect(chartLine.segmentCount).toBe(1);
  });

  it.each([0, -30_000, Number.NaN, Number.POSITIVE_INFINITY])("step 이 %d 면 30초로 본다 — 30초 간격은 잇고 60초 간격은 끊는다", (step) => {
    const geometry = buildChartGeometry(input([line([at(0, 10), at(30_000, 20), at(90_000, 30), at(120_000, 40)])], { stepMilliseconds: step }));
    expect(geometry.lines[0].segmentCount).toBe(2);
    expectFiniteGeometry(geometry);
  });
});

describe("y 축 — 퍼센트는 0~100 고정", () => {
  it("꼭대기 100 · 눈금 0 · 50 · 100", () => {
    const geometry = buildChartGeometry(input([line([at(0, 3), at(STEP, 4)])]));
    expect(geometry.top).toBe(100);
    expect(geometry.yTicks).toEqual([{ value: 0, position: 160 }, { value: 50, position: 80 }, { value: 100, position: 0 }]);
  });

  it("100 을 넘는 값은 꼭대기로, 0 아래는 바닥으로 자른다", () => {
    const [chartLine] = buildChartGeometry(input([line([at(0, 120), at(STEP, -5)])])).lines;
    expect(chartLine.path).toBe("M0 0 L5 160");
  });

  it("값이 전부 같아도(전부 0 · 전부 100) 좌표가 유한하다", () => {
    for (const value of [0, 100]) {
      const geometry = buildChartGeometry(input([line([at(0, value), at(STEP, value), at(2 * STEP, value)])]));
      expect(geometry.lines[0].path).toBe(value === 0 ? "M0 160 L5 160 L10 160" : "M0 0 L5 0 L10 0");
      expectFiniteGeometry(geometry);
    }
  });
});

describe("y 축 — auto 는 최댓값 × 1.1 을 1 · 2 · 2.5 · 5 × 10^k 로 올린 값", () => {
  it.each([
    [0.9, 1], [1, 2], [2.2, 2.5], [4.5, 5], [12, 20], [3481.6, 5000], [52_000, 100_000], [119_000_000, 200_000_000],
  ])("최댓값 %d → 꼭대기 %d", (maximum, top) => {
    const geometry = buildChartGeometry(input([line([at(0, 0), at(STEP, maximum)])], { axis: { kind: "auto" } }));
    expect(geometry.top).toBe(top);
    expect(geometry.yTicks).toEqual([{ value: 0, position: 160 }, { value: top / 2, position: 80 }, { value: top, position: 0 }]);
  });

  it("값이 전부 0 → 꼭대기 1(0 으로 나누지 않는다), 선은 바닥", () => {
    const geometry = buildChartGeometry(input([line([at(0, 0), at(STEP, 0)])], { axis: { kind: "auto" } }));
    expect(geometry.top).toBe(1);
    expect(geometry.lines[0].path).toBe("M0 160 L5 160");
    expectFiniteGeometry(geometry);
  });

  it("값이 전부 같은 양수 → 그 값이 꼭대기 아래(여유 포함)", () => {
    const geometry = buildChartGeometry(input([line([at(0, 5), at(STEP, 5)])], { axis: { kind: "auto" } }));
    expect(geometry.top).toBe(10);
    expect(geometry.lines[0].path).toBe("M0 80 L5 80");
  });

  it("값이 없다 → 꼭대기 1 · 유한", () => {
    const geometry = buildChartGeometry(input([line([at(0, null)])], { axis: { kind: "auto" } }));
    expect(geometry.top).toBe(1);
    expectFiniteGeometry(geometry);
  });

  it("minimumTop — 컨테이너 CPU 는 꼭대기가 100 보다 작지 않고, 100 을 넘으면 따라 오른다(코어 하나 = 100)", () => {
    const low = buildChartGeometry(input([line([at(0, 30), at(STEP, 30)])], { axis: { kind: "auto", minimumTop: 100 } }));
    expect(low.top).toBe(100);
    expect(low.lines[0].path).toBe("M0 112 L5 112");
    const high = buildChartGeometry(input([line([at(0, 250), at(STEP, 250)])], { axis: { kind: "auto", minimumTop: 100 } }));
    expect(high.top).toBe(500);
    expect(high.lines[0].path).toBe("M0 80 L5 80");
    const idle = buildChartGeometry(input([line([at(0, 0)])], { axis: { kind: "auto", minimumTop: 100 } }));
    expect(idle.top).toBe(100);
  });

  it("꼭대기는 모든 선(최댓값 선 포함)의 최대로 — 같은 축을 쓴다", () => {
    const average = line([at(0, 10), at(STEP, 20)]);
    const maximum = line([at(0, 30), at(STEP, 90)], { key: "cpu_pct_max", label: "최댓값", role: "maximum" });
    const geometry = buildChartGeometry(input([average, maximum], { axis: { kind: "auto" } }));
    expect(geometry.top).toBe(100);
    expect(geometry.lines.map((chartLine) => [chartLine.key, chartLine.role, chartLine.path])).toEqual([
      ["cpu_pct", "average", "M0 144 L5 128"],
      ["cpu_pct_max", "maximum", "M0 112 L5 16"],
    ]);
  });
});

describe("x 축 — 그림 영역 안으로 자른다", () => {
  it("첫 점이 from 보다 앞서면(5분 평균의 구간 시작) x = 0", () => {
    const step = 5 * 60 * 1000;
    const [chartLine] = buildChartGeometry(input([line([at(-3 * 60 * 1000, 50), at(2 * 60 * 1000, 50)])], { stepMilliseconds: step })).lines;
    expect(chartLine.path).toBe("M0 80 L20 80");
    for (const [index, value] of numbersIn(chartLine.path).entries()) if (index % 2 === 0) expect(value).toBeGreaterThanOrEqual(0);
  });

  it("to 를 넘는 점은 x = width", () => {
    const [chartLine] = buildChartGeometry(input([line([at(HOUR - STEP, 50), at(HOUR + 10_000, 50)])])).lines;
    expect(chartLine.path).toBe("M595 80 L600 80");
  });

  it("눈금 — from · 가운데 · to", () => {
    expect(buildChartGeometry(input([])).xTicks).toEqual([
      { value: FROM, position: 0 }, { value: FROM + HOUR / 2, position: 300 }, { value: TO, position: 600 },
    ]);
  });

  it("to ≤ from 이어도 유한하다(모든 x = 0)", () => {
    const geometry = buildChartGeometry(input([line([at(0, 10), at(STEP, 20)])], { toMilliseconds: FROM }));
    expectFiniteGeometry(geometry);
    for (const [index, value] of numbersIn(geometry.lines[0].path).entries()) if (index % 2 === 0) expect(value).toBe(0);
  });
});

describe("점 500개 — 길이의 상한과 유한함", () => {
  const range = 30 * 24 * HOUR;
  const step = Math.ceil(range / 500 / 30_000) * 30_000;   // 30일의 간격(관측 서버 규칙)
  const points = Array.from({ length: 500 }, (_, index) => ({ atMilliseconds: FROM + index * step, value: (index * 37) % 101 }));

  it("한 조각의 경로 · 길이 ≤ 500 × 16", () => {
    const geometry = buildChartGeometry(input([line(points)], { toMilliseconds: FROM + range, stepMilliseconds: step }));
    const [chartLine] = geometry.lines;
    expect(chartLine.segmentCount).toBe(1);
    expect(chartLine.drawnPointCount).toBe(500);
    expect(chartLine.path.length).toBeLessThanOrEqual(500 * CHART_PATH_CHARACTERS_PER_POINT);
    expect(chartLine.path.match(/[ML]/g)?.length).toBe(500);
    expectFiniteGeometry(geometry);
  });

  it("하나 걸러 끊긴 500개(조각 250)도 상한 안", () => {
    const sparse = points.map((point, index) => ({ ...point, atMilliseconds: FROM + Math.floor(index / 2) * step * 3 + (index % 2) * step }));
    const geometry = buildChartGeometry(input([line(sparse)], { toMilliseconds: FROM + range * 2, stepMilliseconds: step, axis: { kind: "auto" } }));
    expect(geometry.lines[0].segmentCount).toBe(250);
    expect(geometry.lines[0].path.length).toBeLessThanOrEqual(500 * CHART_PATH_CHARACTERS_PER_POINT);
    expectFiniteGeometry(geometry);
  });

  it("아주 큰 값(바이트 1e18)도 지수 표기 없이", () => {
    const geometry = buildChartGeometry(input([line([at(0, 1e18), at(STEP, 5e17)])], { axis: { kind: "auto" } }));
    expectFiniteGeometry(geometry);
    expect(geometry.lines[0].path).toBe("M0 80 L5 120");   // top = niceCeiling(1.1e18) = 2e18
  });
});
