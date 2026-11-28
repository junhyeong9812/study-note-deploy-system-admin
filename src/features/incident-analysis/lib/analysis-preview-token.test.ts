/** 미리보기 → 보내기를 잇는 서명 값(재배포의 확인 값 rc1 과 같은 방식 — 상태를 두지 않는다). 명세 ⑫ §20 · §21 3.
 * 꼴: `ap2.<만든 시각(epoch 밀리초, 10진)>.<since 칸>.<서명(base64url 43자)>`
 *   since 칸 = 미리볼 때 그 문제의 "언제부터"가 없으면 `-`, 있으면 `s` + base64url(UTF-8) — 빈 글자 since 는 `s`(없음과 다르다).
 * 서명 = HMAC-SHA256(세션 서명 키, 일곱 줄을 "\n" 으로 이은 글: "incident-analysis-preview" · "ap2" · 문제 식별자 · 프롬프트의 SHA-256(16진) ·
 *   만든 시각 · since 칸 · 계정). since 칸을 바꾸면 서명이 맞지 않는다.
 * 통하는 때: 0 <= 지금 - 만든 시각 < 10분. 결과: { ok: true, incidentSince }(서명이 묶은 since — 부르는 쪽이 지금의 since 와 견준다) ·
 *   malformed(꼴 — 옛 판 ap1 포함 · 2,048자 넘음) · mismatch(서명 — 다른 문제 · 다른 글 · 다른 계정 · 다른 키 · 미래 시각 · since 칸 변조) · expired. */
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS, issueAnalysisPreviewToken, verifyAnalysisPreviewToken,
} from "@/features/incident-analysis/lib/analysis-preview-token";
import { analysisPromptDigest } from "@/features/incident-analysis/lib/analysis-prompt";

const KEY = "fake-signing-key-for-tests-only-0000000000";
const NOW = Date.UTC(2026, 10, 27, 6, 0, 0);
const SINCE = "2026-11-27T05:40:00.000Z";
/** 서명에 들어가는 칸 — 프롬프트의 해시는 구현을 부르므로 사례 안에서 만든다. */
function digest(): string {
  return analysisPromptDigest("보낼 글");
}
function fields() {
  return { incidentId: "monitor:front", promptDigest: digest(), account: "admin:jun" };
}

describe("analysisPromptDigest", () => {
  it("SHA-256 16진 64자 · 한 바이트만 달라도 다르다", () => {
    expect(digest()).toMatch(/^[0-9a-f]{64}$/);
    expect(analysisPromptDigest("보낼 글")).toBe(digest());
    expect(analysisPromptDigest("보낼 글 ")).not.toBe(digest());
    expect(analysisPromptDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("서명 값", () => {
  const issue = (incidentSince: string | null = SINCE) => issueAnalysisPreviewToken(KEY, { ...fields(), issuedAt: NOW, incidentSince });

  it("꼴 — ap2.<시각>.<since 칸>.<43자> · since 가 없으면 `-`", () => {
    expect(issue()).toBe(`ap2.${NOW}.s${Buffer.from(SINCE, "utf8").toString("base64url")}.${issue().split(".")[3]}`);
    expect(issue()).toMatch(new RegExp(`^ap2\\.${NOW}\\.s[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$`));
    expect(issue(null)).toMatch(new RegExp(`^ap2\\.${NOW}\\.-\\.[A-Za-z0-9_-]{43}$`));
  });

  it("같은 문제 · 같은 글 · 같은 계정 · 10분 안 → ok 와 서명이 묶은 since", () => {
    expect(verifyAnalysisPreviewToken(issue(), KEY, fields(), NOW)).toEqual({ ok: true, incidentSince: SINCE });
    expect(verifyAnalysisPreviewToken(issue(), KEY, fields(), NOW + ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS - 1)).toEqual({ ok: true, incidentSince: SINCE });
    expect(verifyAnalysisPreviewToken(issue(null), KEY, fields(), NOW)).toEqual({ ok: true, incidentSince: null });
    expect(verifyAnalysisPreviewToken(issue(""), KEY, fields(), NOW)).toEqual({ ok: true, incidentSince: "" });
    const long = "가".repeat(300);
    expect(verifyAnalysisPreviewToken(issue(long), KEY, fields(), NOW)).toEqual({ ok: true, incidentSince: long });
  });

  it("since 칸을 바꿔 끼우면 mismatch — 다른 since 의 서명 · 없음 ↔ 빈 글자", () => {
    const original = issue().split(".");
    const other = issue("2026-11-28T00:00:00.000Z").split(".");
    expect(verifyAnalysisPreviewToken([original[0], original[1], other[2], original[3]].join("."), KEY, fields(), NOW)).toEqual({ ok: false, reason: "mismatch" });
    const none = issue(null).split(".");
    const empty = issue("").split(".");
    expect(verifyAnalysisPreviewToken([none[0], none[1], empty[2], none[3]].join("."), KEY, fields(), NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("10분이 지나면 expired(서명은 맞다)", () => {
    expect(ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS).toBe(600_000);
    expect(verifyAnalysisPreviewToken(issue(), KEY, fields(), NOW + ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS)).toEqual({ ok: false, reason: "expired" });
  });

  it.each([
    ["다른 글(미리본 글과 다르다)", () => ({ ...fields(), promptDigest: analysisPromptDigest("보낼 글!") })],
    ["다른 문제", () => ({ ...fields(), incidentId: "monitor:backend" })],
    ["다른 계정", () => ({ ...fields(), account: "admin:other" })],
  ] as const)("%s → mismatch", (_label, expected) => {
    expect(verifyAnalysisPreviewToken(issue(), KEY, expected(), NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("다른 키 · 빈 키 · 미래 시각 → mismatch", () => {
    expect(verifyAnalysisPreviewToken(issue(), `${KEY}x`, fields(), NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyAnalysisPreviewToken(issue(), "", fields(), NOW)).toEqual({ ok: false, reason: "mismatch" });
    const future = issueAnalysisPreviewToken(KEY, { ...fields(), issuedAt: NOW + 60_000, incidentSince: SINCE });
    expect(verifyAnalysisPreviewToken(future, KEY, fields(), NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("서명의 마지막 글자만 바꿔도 mismatch", () => {
    const token = issue();
    const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(verifyAnalysisPreviewToken(flipped, KEY, fields(), NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it.each([
    [undefined], [""], ["ap2"], ["rc1.x.1.abc"], [`ap1.${NOW}.${"A".repeat(43)}`], [`ap2.${NOW}.${"A".repeat(43)}`], [`ap2.x.-.${"A".repeat(43)}`],
    [`ap2.${NOW}.-.${"A".repeat(42)}`], [`ap2.${NOW}.x.${"A".repeat(43)}`], [`ap2.${NOW}.s!.${"A".repeat(43)}`], ["a".repeat(2_100)], [42],
  ])("꼴이 아님 %j → malformed", (value) => {
    expect(verifyAnalysisPreviewToken(value, KEY, fields(), NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("빈 키로는 만들지 않는다", () => {
    expect(() => issueAnalysisPreviewToken(" ", { ...fields(), issuedAt: NOW, incidentSince: SINCE })).toThrow();
  });
});
