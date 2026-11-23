/** 로그인 시도 기록 화면의 판정과 글자(순수) — 결과 낱말 전부의 갈래 · 기호 · 글자, 잠금 상태의 세 갈래, User-Agent 줄이기, 실패 글자. */
import { describe, expect, it } from "vitest";
import { LOGIN_ATTEMPT_OUTCOMES } from "@/features/login-attempts/lib/login-attempts-query";
import {
  OBSERVE_FAILURE_LIMIT, OUTCOME_DESCRIPTIONS, USER_AGENT_VISIBLE_LENGTH, describeLockStatus, failureText, shortUserAgent,
} from "@/features/login-attempts/ui/login-attempts-view";
import { upstreamFailure } from "@/shared/lib/upstream-result";

describe("OUTCOME_DESCRIPTIONS — 데이터 계층의 결과 낱말 전부", () => {
  it("결과 낱말마다 글자 · 기호 · 뜻이 있다(빠진 낱말 · 남는 낱말 없음)", () => {
    expect(Object.keys(OUTCOME_DESCRIPTIONS).sort()).toEqual([...LOGIN_ATTEMPT_OUTCOMES].sort());
    for (const outcome of LOGIN_ATTEMPT_OUTCOMES) {
      const description = OUTCOME_DESCRIPTIONS[outcome];
      expect(description.label.length).toBeGreaterThan(0);
      expect(description.mark.length).toBeGreaterThan(0);
      expect(description.meaning.length).toBeGreaterThan(0);
    }
  });

  it("갈래: 성공 · 실패 · 잠금 · 거절(자격 확인 전 세 이유)", () => {
    expect(OUTCOME_DESCRIPTIONS.success.tone).toBe("success");
    expect(OUTCOME_DESCRIPTIONS.failure.tone).toBe("failure");
    expect(OUTCOME_DESCRIPTIONS.locked.tone).toBe("locked");
    for (const outcome of ["rate_limited", "origin_rejected", "malformed"] as const) expect(OUTCOME_DESCRIPTIONS[outcome].tone).toBe("rejected");
  });

  it("색만으로 가르지 않는다 — 갈래마다 기호가 다르고, 결과 낱말마다 글자가 다르다", () => {
    const marksByTone = new Map<string, Set<string>>();
    for (const description of Object.values(OUTCOME_DESCRIPTIONS)) {
      marksByTone.set(description.tone, (marksByTone.get(description.tone) ?? new Set()).add(description.mark));
    }
    const marks = [...marksByTone.values()].map((set) => [...set].join());
    expect(new Set(marks).size).toBe(4);
    expect(new Set(Object.values(OUTCOME_DESCRIPTIONS).map((description) => description.label)).size).toBe(LOGIN_ATTEMPT_OUTCOMES.length);
  });
});

describe("describeLockStatus — 현재 잠금 상태", () => {
  it("조회 실패 → 확인 못 함(고정 사유 + HTTP 상태만)", () => {
    expect(describeLockStatus(upstreamFailure("unreachable"))).toEqual({ kind: "unknown", detail: "관측 서버: 닿지 않음" });
    expect(describeLockStatus(upstreamFailure("unavailable", { status: 503 }))).toEqual({ kind: "unknown", detail: "관측 서버: 서버 일시 장애 · HTTP 503" });
  });

  it("잠김 → 풀리는 시각과 연속 실패 횟수 그대로", () => {
    expect(describeLockStatus({ ok: true, value: { locked: true, lockedUntil: "2026-11-22T10:15:00Z", failures: 5 } }))
      .toEqual({ kind: "locked", lockedUntil: "2026-11-22T10:15:00Z", failures: 5 });
    expect(describeLockStatus({ ok: true, value: { locked: true, lockedUntil: null, failures: 5 } }))
      .toEqual({ kind: "locked", lockedUntil: null, failures: 5 });
  });

  it("잠기지 않음 → 연속 실패 횟수와 잠금까지 남은 횟수(0 아래로 내려가지 않는다)", () => {
    expect(describeLockStatus({ ok: true, value: { locked: false, lockedUntil: null, failures: 0 } }))
      .toEqual({ kind: "unlocked", failures: 0, remaining: OBSERVE_FAILURE_LIMIT });
    expect(describeLockStatus({ ok: true, value: { locked: false, lockedUntil: null, failures: 3 } }))
      .toEqual({ kind: "unlocked", failures: 3, remaining: 2 });
    expect(describeLockStatus({ ok: true, value: { locked: false, lockedUntil: null, failures: 9 } }))
      .toEqual({ kind: "unlocked", failures: 9, remaining: 0 });
  });
});

describe("shortUserAgent — 표의 줄인 글자", () => {
  it("상한 이하면 그대로 · 넘으면 앞부분 + …", () => {
    const exact = "a".repeat(USER_AGENT_VISIBLE_LENGTH);
    expect(shortUserAgent(exact)).toEqual({ text: exact, truncated: false });
    expect(shortUserAgent(`${exact}b`)).toEqual({ text: `${exact}…`, truncated: true });
    expect(shortUserAgent("")).toEqual({ text: "", truncated: false });
  });

  it("코드 포인트 기준 — 서로게이트 쌍을 가르지 않는다", () => {
    const emoji = "😀".repeat(USER_AGENT_VISIBLE_LENGTH + 1);
    const shortened = shortUserAgent(emoji);
    expect(shortened.truncated).toBe(true);
    expect(shortened.text).toBe(`${"😀".repeat(USER_AGENT_VISIBLE_LENGTH)}…`);
    expect(shortUserAgent("😀".repeat(USER_AGENT_VISIBLE_LENGTH)).truncated).toBe(false);
  });
});

describe("failureText", () => {
  it("고정 사유 · 상태가 있으면 HTTP 상태", () => {
    expect(failureText(upstreamFailure("timeout"))).toBe("닿지 않음(5초 초과)");
    expect(failureText(upstreamFailure("unauthorized", { status: 401 }))).toBe("비밀값 거절됨 · HTTP 401");
  });
});
