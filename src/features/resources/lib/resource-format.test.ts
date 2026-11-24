/** 서버 자원 화면의 값 글자 — 명세 §2.6 "값 · 단위 · 시각 축을 글자로 낸다" · "지표가 오래된 서버는 값 옆에 'N분 전 값'" ·
 * §10.2 "cpu_pct: 서버 전체는 0~100, 컨테이너는 코어 하나 = 100" · "사용률 · 초당 값은 … 그 값을 null 로 낸다(틀린 급등을 만들지 않는다)". */
import { describe, expect, it } from "vitest";
import {
  RESOURCE_NO_VALUE_TEXT, formatAge, formatBytes, formatBytesPerSecond, formatCelsius, formatPercent,
} from "@/features/resources/lib/resource-format";

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;

describe("값이 없으면 '없음' — 0 으로 보이지 않는다", () => {
  it("글자", () => {
    expect(RESOURCE_NO_VALUE_TEXT).toBe("없음");
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("%s → 없음(다섯 함수 모두)", (value) => {
    expect(formatBytes(value)).toBe("없음");
    expect(formatBytesPerSecond(value)).toBe("없음");
    expect(formatPercent(value)).toBe("없음");
    expect(formatCelsius(value)).toBe("없음");
    expect(formatAge(value)).toBe("없음");
  });

  it("0 은 실제 값이다(없음이 아니다)", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytesPerSecond(0)).toBe("0 B/s");
    expect(formatPercent(0)).toBe("0.0%");
  });
});

describe("formatBytes — 1024 단위, KiB 부터 소수 한 자리", () => {
  it.each([
    [1, "1 B"], [512, "512 B"], [1023, "1023 B"],
    [KIB, "1.0 KiB"], [1536, "1.5 KiB"], [119_000_000, "113.5 MiB"],
    [MIB, "1.0 MiB"], [2_100_000_000, "2.0 GiB"], [16_000_000_000, "14.9 GiB"],
    [80_570_650_624, "75.0 GiB"], [500_235_124_736, "465.9 GiB"], [8_589_934_592, "8.0 GiB"],
    [TIB, "1.0 TiB"], [3 * TIB, "3.0 TiB"], [5000 * TIB, "5000.0 TiB"],
  ])("%d → %s", (value, text) => {
    expect(formatBytes(value)).toBe(text);
  });

  it("반올림해 1024.0 이 되면 다음 단위로", () => {
    expect(formatBytes(MIB - 1)).toBe("1.0 MiB");
    expect(formatBytes(GIB - 10)).toBe("1.0 GiB");
  });

  it("소수 바이트는 정수로 반올림(초당 값은 실수다)", () => {
    expect(formatBytes(511.6)).toBe("512 B");
  });
});

describe("formatBytesPerSecond", () => {
  it.each([[1200, "1.2 KiB/s"], [3400, "3.3 KiB/s"], [52_000, "50.8 KiB/s"], [800, "800 B/s"], [125_000_000, "119.2 MiB/s"]])("%d → %s", (value, text) => {
    expect(formatBytesPerSecond(value)).toBe(text);
  });
});

describe("formatPercent — 소수 한 자리", () => {
  it.each([
    [3.4, "3.4%"], [3.45, "3.5%"], [99.96, "100.0%"], [100, "100.0%"], [0.04, "0.0%"], [13.125, "13.1%"],
    [250, "250.0%"],   // 컨테이너 CPU 는 코어 하나 = 100 — 100 을 넘어도 그대로
    [1234.56, "1234.6%"],
  ])("%d → %s", (value, text) => {
    expect(formatPercent(value)).toBe(text);
  });

  it("반올림은 Math.round(x × 10) / 10 규칙(toFixed 의 이진 오차와 다른 값)", () => {
    expect(formatPercent(1.45)).toBe("1.5%");   // (1.45).toFixed(1) 은 "1.4"
    expect(formatPercent(1.15)).toBe("1.2%");
    expect(formatPercent(10.45)).toBe("10.5%");
  });
});

describe("formatCelsius", () => {
  it.each([[28, "28°C"], [27.6, "28°C"], [-3, "-3°C"], [0, "0°C"]])("%d → %s", (value, text) => {
    expect(formatCelsius(value)).toBe(text);
  });
});

describe("formatAge — 지난 시간(내림)", () => {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it.each([
    [0, "1분 안"], [59 * SECOND, "1분 안"], [MINUTE, "1분 전"], [3 * MINUTE + 1, "3분 전"], [59 * MINUTE + 59 * SECOND, "59분 전"],
    [HOUR, "1시간 전"], [23 * HOUR + 59 * MINUTE, "23시간 전"], [DAY, "1일 전"], [6 * DAY + 23 * HOUR, "6일 전"], [30 * DAY, "30일 전"],
  ])("%d ms → %s", (milliseconds, text) => {
    expect(formatAge(milliseconds)).toBe(text);
  });

  it("음수(두 자리의 시계 차)는 0 으로 본다", () => {
    expect(formatAge(-5_000)).toBe("1분 안");
  });
});
