/** 분석의 답 — 어드민도 한 번 더 검증한다(명세 ⑫ §13 · §14 의 실행 자리 검증과 같은 규칙).
 * 계약: 칸은 정확히 다섯(cause · evidence · confidence · remedy · recommended_action — 모르는 칸 · 빠진 칸이면 null) ·
 * cause 1~2000자 · evidence 1~10개(각 1~500자) · remedy 1~4000자(길이는 코드 포인트) · 글마다 보이는 글자(공백 · 제어 · 서식이 아닌 것)가 하나 이상 ·
 * 짝 없는 서로게이트가 든 글은 거절 · confidence 는 low · medium · high · recommended_action 은 rollback · redeploy · none(목록 밖이면 null — "없음"으로 바꾸지 않는다).
 * 글의 내용(마크다운 · HTML · 제어 문자)은 그대로 넘긴다 — 이스케이프는 보이는 쪽의 일. 결과는 recommendedAction(낙타 꼴)로. */
import { describe, expect, it } from "vitest";
import { ANALYSIS_ACTION_LABELS, ANALYSIS_CONFIDENCE_LABELS, parseAnalysisAnswer } from "@/features/incident-analysis/lib/analysis-answer";
import { validRunnerAnswer } from "@/features/incident-analysis/lib/analysis-test-fakes";

describe("맞는 답", () => {
  it("다섯 칸 → 그대로(낙타 꼴의 이름)", () => {
    expect(parseAnalysisAnswer(validRunnerAnswer())).toEqual({
      cause: "backend 의 DB 연결 풀이 비었습니다", evidence: ["오류 로그 42줄이 같은 예외", "직전 배포에서 풀 크기를 줄였다"],
      confidence: "medium", remedy: "직전 배포를 되돌린 뒤 풀 크기를 다시 늘립니다", recommendedAction: "rollback",
    });
  });

  it("경계 안쪽 — cause 2000자 · evidence 10개(각 500자) · remedy 4000자(코드 포인트 — 이모지도 한 자)", () => {
    const answer = parseAnalysisAnswer(validRunnerAnswer({
      cause: "😀".repeat(2000), evidence: Array.from({ length: 10 }, () => "가".repeat(500)), remedy: "r".repeat(4000),
    }));
    expect(answer?.cause).toHaveLength(4000);   // UTF-16 으로는 4000
    expect(answer?.evidence).toHaveLength(10);
  });

  it("글의 내용은 그대로 — 마크다운 · HTML · 제어 · 서식 문자(보이는 글자가 하나라도 있으면)", () => {
    const cause = "**굵게** <img src=x onerror=alert(1)> [링크](javascript:alert(1)) \u202E뒤집기\u0007";
    expect(parseAnalysisAnswer(validRunnerAnswer({ cause }))?.cause).toBe(cause);
  });

  it.each([["rollback"], ["redeploy"], ["none"]])("권하는 조치 %s", (action) => {
    expect(parseAnalysisAnswer(validRunnerAnswer({ recommended_action: action }))?.recommendedAction).toBe(action);
  });

  it("보이는 글 — 확신의 정도 · 권하는 조치(표시일 뿐)", () => {
    expect(ANALYSIS_CONFIDENCE_LABELS).toEqual({ low: "낮음", medium: "중간", high: "높음" });
    expect(ANALYSIS_ACTION_LABELS).toEqual({ rollback: "되돌리기를 권함", redeploy: "다시 배포를 권함", none: "권하는 조치 없음" });
  });
});

describe("틀린 답은 null — 고쳐 쓰지도 잘라 내지도 않는다", () => {
  const withoutField = (name: string) => {
    const answer = validRunnerAnswer();
    delete answer[name];
    return answer;
  };
  it.each([
    ["객체가 아님", "답"], ["null", null], ["배열", [validRunnerAnswer()]],
    ["모르는 칸", validRunnerAnswer({ extra: "x" })], ["cause 가 빠짐", withoutField("cause")], ["recommended_action 이 빠짐", withoutField("recommended_action")],
    ["cause 가 글이 아님", validRunnerAnswer({ cause: 1 })], ["cause 가 빈 글", validRunnerAnswer({ cause: "" })],
    ["cause 2001자", validRunnerAnswer({ cause: "c".repeat(2001) })], ["remedy 4001자", validRunnerAnswer({ remedy: "r".repeat(4001) })],
    ["evidence 가 비었음", validRunnerAnswer({ evidence: [] })], ["evidence 11개", validRunnerAnswer({ evidence: Array.from({ length: 11 }, () => "e") })],
    ["evidence 항목 501자", validRunnerAnswer({ evidence: ["e".repeat(501)] })], ["evidence 항목이 글이 아님", validRunnerAnswer({ evidence: [1] })],
    ["evidence 가 글", validRunnerAnswer({ evidence: "e" })],
    ["confidence 목록 밖", validRunnerAnswer({ confidence: "certain" })], ["confidence 대문자", validRunnerAnswer({ confidence: "HIGH" })],
    ["조치 목록 밖", validRunnerAnswer({ recommended_action: "restart" })], ["조치 대문자", validRunnerAnswer({ recommended_action: "Rollback" })],
    ["조치가 글이 아님", validRunnerAnswer({ recommended_action: true })],
    ["공백만", validRunnerAnswer({ cause: " \t\n" })], ["보이지 않는 서식만", validRunnerAnswer({ remedy: "\u200B\uFEFF\u202E" })],
    ["제어 문자만", validRunnerAnswer({ evidence: ["\u0000\u0007"] })], ["짝 없는 서로게이트", validRunnerAnswer({ cause: "원인 \uD800" })],
  ])("%s", (_label, value) => {
    expect(parseAnalysisAnswer(value)).toBeNull();
  });
});
