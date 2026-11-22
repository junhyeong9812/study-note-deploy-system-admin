/** 배포 이력의 표시 글자 — 화면 task(접수 시각은 KST, 원본 UTC 는 title · 걸린 시간은 사람이 읽는 단위 · 상태는 색과 글자 둘 다). */
import { describe, expect, it } from "vitest";
import { DEPLOY_STATES } from "@/features/deploys/lib/deploy-history-client";
import { describeDeployState, failedStageLabel, formatDuration, formatKoreanTime, shortPrefix } from "@/features/deploys/lib/deploy-format";

describe("formatKoreanTime — UTC 를 KST(+9)로", () => {
  it.each([
    ["2026-11-22T01:00:00Z", "2026-11-22 10:00:00"],
    ["2026-11-22T15:30:05Z", "2026-11-23 00:30:05"],   // 날이 넘어간다
    ["2026-12-31T20:00:00Z", "2027-01-01 05:00:00"],   // 해가 넘어간다
    ["2026-11-22T01:00:00.999Z", "2026-11-22 10:00:00"],
  ])("%s → %s", (input, expected) => {
    expect(formatKoreanTime(input)).toBe(expected);
  });

  it("읽을 수 없는 글자는 그대로", () => {
    expect(formatKoreanTime("not-a-time")).toBe("not-a-time");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "—"], [-5, "—"], [400, "0.4초"], [1_250, "1.3초"], [9_949, "9.9초"], [12_000, "12초"], [59_400, "59초"],
    [60_000, "1분 0초"], [125_000, "2분 5초"], [3_599_000, "59분 59초"], [3_600_000, "1시간 0분"], [3_780_000, "1시간 3분"],
  ])("%i ms → %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });
});

describe("describeDeployState — 모든 상태에 글자와 색 갈래", () => {
  it.each([...DEPLOY_STATES])("%s", (state) => {
    const described = describeDeployState(state);
    expect(described.label.length).toBeGreaterThan(0);
    expect(["success", "failure", "progress"]).toContain(described.tone);
  });

  it("성공 · 실패 · 진행 중은 글자가 서로 다르다", () => {
    expect(new Set(["succeeded", "failed", "ci_running"].map((state) => describeDeployState(state as "succeeded").label)).size).toBe(3);
  });
});

describe("failedStageLabel · shortPrefix", () => {
  it("파이프라인 단계와 master 단계의 이름, 모르는 값은 null", () => {
    expect(failedStageLabel("ci_test")).toBe("테스트");
    expect(failedStageLabel("agent_unreachable")).toBe("agent 닿지 않음");
    expect(failedStageLabel("toString")).toBeNull();
    expect(failedStageLabel("brand_new_stage")).toBeNull();
  });

  it("앞부분", () => {
    expect(shortPrefix("0123456789abcdef", 7)).toBe("0123456");
    expect(shortPrefix("abc", 7)).toBe("abc");
  });
});
