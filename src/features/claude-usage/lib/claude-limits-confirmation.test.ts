/** 상한을 넓히는 바꿈의 확인 값 — 명세 §16 "재확인의 방식은 ⑥ 의 재배포 확인과 같은 것(서명한 확인 값) · 확인 값은 그 바꿈(값 전부)에 묶여
 * 다른 값으로 바꿔 쓸 수 없다". 재배포의 rc1 과 같은 방식(HMAC · 용도 줄 · 5분 · 상태 없음) — 묶는 것: 계정 · 만든 시각 · 앞 값 · 새 값 전부. */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import type { ClaudeLimitsChange } from "@/features/claude-usage/lib/claude-limits";
import {
  CLAUDE_LIMITS_CONFIRMATION_LIFETIME_MILLISECONDS, CLAUDE_LIMITS_CONFIRMATION_PURPOSE, claudeLimitsCanonical, issueClaudeLimitsConfirmation,
  verifyClaudeLimitsConfirmation,
} from "@/features/claude-usage/lib/claude-limits-confirmation";
import { issueRedeployConfirmation } from "@/features/deploy-redeploy/lib/redeploy-confirmation";

const ACCOUNT = "fake-admin-id-zq";
const ISSUED_AT = Date.UTC(2026, 10, 28, 3, 0, 0);

function limits(overrides: { enabled?: boolean; total?: [number, number]; purposes?: Record<string, [number, number]> } = {}): ClaudeLimitsChange {
  const total = overrides.total ?? [30, 10];
  const purposes = overrides.purposes ?? { chat: [30, 10], analysis: [6, 2] };
  return {
    enabled: overrides.enabled ?? true,
    total: { perDay: total[0], perHour: total[1] },
    purposes: Object.fromEntries(Object.entries(purposes).map(([name, [perDay, perHour]]) => [name, { perDay, perHour }])),
  };
}

const BEFORE = limits({ enabled: false });
const AFTER = limits({ enabled: true, purposes: { chat: [40, 10], analysis: [6, 2] } });
const BEFORE_CHANGED_AT = "2026-11-28T11:00:00+09:00";
const EXPECTED = { account: ACCOUNT, beforeChangedAt: BEFORE_CHANGED_AT, before: BEFORE, after: AFTER };

function issue(overrides: Partial<{ account: string; issuedAt: number; beforeChangedAt: string | null; before: ClaudeLimitsChange; after: ClaudeLimitsChange }> = {}, key = FAKE_SIGNING_KEY): string {
  return issueClaudeLimitsConfirmation(key, { account: ACCOUNT, issuedAt: ISSUED_AT, beforeChangedAt: BEFORE_CHANGED_AT, before: BEFORE, after: AFTER, ...overrides });
}

describe("서명에 넣는 값의 글", () => {
  it("켬/끔 · 전체 · 용도(이름 차례) — `on;total=30/10;analysis=6/2;chat=40/10`", () => {
    expect(claudeLimitsCanonical(AFTER)).toBe("on;total=30/10;analysis=6/2;chat=40/10");
    expect(claudeLimitsCanonical(BEFORE)).toBe("off;total=30/10;analysis=6/2;chat=30/10");
  });

  it("용도의 차례가 달라도 같은 글", () => {
    const reordered: ClaudeLimitsChange = { ...AFTER, purposes: { analysis: AFTER.purposes.analysis, chat: AFTER.purposes.chat } };
    expect(claudeLimitsCanonical(reordered)).toBe(claudeLimitsCanonical(AFTER));
  });
});

describe("꼴과 통하는 값", () => {
  it("만든 값은 `cc1.<만든 시각>.<서명 43자>` — 계약의 일곱 줄에 세션 서명 키로 서명한 것과 같다 · 값 · 계정은 싣지 않는다", () => {
    const token = issue();
    expect(token).toMatch(/^cc1\.\d{1,16}\.[A-Za-z0-9_-]{43}$/);
    const lines = [CLAUDE_LIMITS_CONFIRMATION_PURPOSE, "cc1", ACCOUNT, String(ISSUED_AT), BEFORE_CHANGED_AT, claudeLimitsCanonical(BEFORE), claudeLimitsCanonical(AFTER)];
    expect(token).toBe(`cc1.${ISSUED_AT}.${createHmac("sha256", FAKE_SIGNING_KEY).update(lines.join("\n")).digest("base64url")}`);
    expect(token).not.toContain(ACCOUNT);
    expect(CLAUDE_LIMITS_CONFIRMATION_PURPOSE).toBe("claude-limits-confirmation");
  });

  it("만든 직후 · 4분 59.999초 뒤에는 통한다(만든 시각을 돌려준다) · 정확히 5분부터 expired", () => {
    expect(CLAUDE_LIMITS_CONFIRMATION_LIFETIME_MILLISECONDS).toBe(300_000);
    const token = issue();
    expect(verifyClaudeLimitsConfirmation(token, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT)).toEqual({ ok: true, issuedAt: ISSUED_AT });
    expect(verifyClaudeLimitsConfirmation(token, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 299_999)).toEqual({ ok: true, issuedAt: ISSUED_AT });
    expect(verifyClaudeLimitsConfirmation(token, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 300_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("만든 시각이 지금보다 뒤면 mismatch", () => {
    expect(verifyClaudeLimitsConfirmation(issue(), FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT - 1)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("용도의 차례만 다른 값으로 확인해도 통한다", () => {
    const reorderedAfter: ClaudeLimitsChange = { ...AFTER, purposes: { analysis: AFTER.purposes.analysis, chat: AFTER.purposes.chat } };
    expect(verifyClaudeLimitsConfirmation(issue(), FAKE_SIGNING_KEY, { ...EXPECTED, after: reorderedAfter }, ISSUED_AT)).toMatchObject({ ok: true });
  });
});

describe("묶임 — 다른 값 · 앞 값 · 계정 · 키로는 통하지 않는다(mismatch)", () => {
  const cases: [string, { account?: string; beforeChangedAt?: string | null; before?: ClaudeLimitsChange; after?: ClaudeLimitsChange }][] = [
    ["앞 값의 바꾼 시각이 다름(넓힌 뒤 누가 같은 값으로 되돌려 놓음)", { beforeChangedAt: "2026-11-28T11:05:00+09:00" }],
    ["앞 값의 바꾼 시각이 null(바꾼 적 없음)로 바뀜", { beforeChangedAt: null }],
    ["새 값의 한 칸이 다름(채팅 하루 40 → 41)", { after: limits({ purposes: { chat: [41, 10], analysis: [6, 2] } }) }],
    ["새 값의 다른 용도를 올림(용도 바꿔 치기 — chat 대신 analysis)", { after: limits({ purposes: { chat: [30, 10], analysis: [40, 2] } }) }],
    ["새 값의 켬/끔이 다름", { after: { ...AFTER, enabled: false } }],
    ["새 값에 용도가 하나 더 있음", { after: limits({ purposes: { chat: [40, 10], analysis: [6, 2], study: [1, 1] } }) }],
    ["새 값에 용도가 하나 빠짐", { after: limits({ purposes: { chat: [40, 10] } }) }],
    ["앞 값이 다름(그 사이 누가 바꿈 — 전체 하루 30 → 5)", { before: limits({ enabled: false, total: [5, 10] }) }],
    ["앞 값의 켬/끔이 다름", { before: { ...BEFORE, enabled: true } }],
    ["다른 계정", { account: "fake-other-admin" }],
  ];
  it.each(cases)("%s", (_label, override) => {
    expect(verifyClaudeLimitsConfirmation(issue(), FAKE_SIGNING_KEY, { ...EXPECTED, ...override }, ISSUED_AT + 1_000)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("다른 키로 만든 값 · 빈 키로 확인 → mismatch", () => {
    expect(verifyClaudeLimitsConfirmation(issue({}, "fake-other-signing-key-for-tests-0000000000"), FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyClaudeLimitsConfirmation(issue(), "", EXPECTED, ISSUED_AT)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("빈 키로는 만들지 않는다(예외)", () => {
    expect(() => issue({}, "")).toThrow();
    expect(() => issue({}, "   ")).toThrow();
  });
});

describe("바꾼 적이 없는 앞 값(changed_at null)", () => {
  it("null 은 \"-\" 줄로 서명한다 — null 로 만든 값은 null 로 확인할 때 통한다", () => {
    const token = issue({ beforeChangedAt: null });
    const lines = [CLAUDE_LIMITS_CONFIRMATION_PURPOSE, "cc1", ACCOUNT, String(ISSUED_AT), "-", claudeLimitsCanonical(BEFORE), claudeLimitsCanonical(AFTER)];
    expect(token).toBe(`cc1.${ISSUED_AT}.${createHmac("sha256", FAKE_SIGNING_KEY).update(lines.join("\n")).digest("base64url")}`);
    expect(verifyClaudeLimitsConfirmation(token, FAKE_SIGNING_KEY, { ...EXPECTED, beforeChangedAt: null }, ISSUED_AT)).toMatchObject({ ok: true });
  });
});

describe("꼴이 아닌 값 → malformed(다른 확인 값 · 세션 토큰을 이 자리에 끼워 넣어도)", () => {
  const valid = () => issue();
  it.each([
    ["글자가 아님", () => 12345 as unknown],
    ["빈 값", () => ""],
    ["129자", () => `cc1.${ISSUED_AT}.${"a".repeat(129 - `cc1.${ISSUED_AT}.`.length)}`],
    ["접두가 다름(cc2)", () => valid().replace(/^cc1/, "cc2")],
    ["조각이 넷", () => `${valid()}.x`],
    ["시각이 숫자가 아님", () => valid().replace(String(ISSUED_AT), "abc")],
    ["서명이 42자", () => valid().slice(0, -1)],
    ["재배포의 확인 값(rc1)", () => issueRedeployConfirmation(FAKE_SIGNING_KEY, { service: "backend", commitSha: "0".repeat(40), requestId: "adm-x", issuedAt: ISSUED_AT, account: ACCOUNT })],
    ["세션 토큰(v1)", () => issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT)],
  ] as [string, () => unknown][])("%s", (_label, make) => {
    expect(verifyClaudeLimitsConfirmation(make(), FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT)).toEqual({ ok: false, reason: "malformed" });
  });
});
