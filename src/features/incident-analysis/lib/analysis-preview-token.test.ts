/** 미리보기 → 보내기를 잇는 서명 값(재배포의 확인 값 rc1 과 같은 방식 — 상태를 두지 않는다).
 * 꼴: `ap1.<만든 시각(epoch 밀리초, 10진)>.<서명(base64url 43자)>` · 서명 = HMAC-SHA256(세션 서명 키, 줄 여섯을 "\n" 으로 이은 글:
 *   "incident-analysis-preview" · "ap1" · 문제 식별자 · 프롬프트의 SHA-256(16진) · 만든 시각 · 계정).
 * 통하는 때: 0 <= 지금 - 만든 시각 < 10분. 결과: ok · malformed(꼴) · mismatch(서명 — 다른 문제 · 다른 글 · 다른 계정 · 다른 키 · 미래 시각) · expired. */
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS, issueAnalysisPreviewToken, verifyAnalysisPreviewToken,
} from "@/features/incident-analysis/lib/analysis-preview-token";
import { analysisPromptDigest } from "@/features/incident-analysis/lib/analysis-prompt";

const KEY = "fake-signing-key-for-tests-only-0000000000";
const NOW = Date.UTC(2026, 10, 27, 6, 0, 0);
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
  const issue = () => issueAnalysisPreviewToken(KEY, { ...fields(), issuedAt: NOW });

  it("꼴 — ap1.<시각>.<43자>", () => {
    const token = issue();
    expect(token).toMatch(new RegExp(`^ap1\\.${NOW}\\.[A-Za-z0-9_-]{43}$`));
  });

  it("같은 문제 · 같은 글 · 같은 계정 · 10분 안 → ok", () => {
    const token = issue();
    expect(verifyAnalysisPreviewToken(token, KEY, fields(), NOW)).toEqual({ ok: true });
    expect(verifyAnalysisPreviewToken(token, KEY, fields(), NOW + ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS - 1)).toEqual({ ok: true });
  });

  it("10분이 지나면 expired(서명은 맞다)", () => {
    const token = issue();
    expect(ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS).toBe(600_000);
    expect(verifyAnalysisPreviewToken(token, KEY, fields(), NOW + ANALYSIS_PREVIEW_LIFETIME_MILLISECONDS)).toEqual({ ok: false, reason: "expired" });
  });

  it.each([
    ["다른 글(미리본 글과 다르다)", () => ({ ...fields(), promptDigest: analysisPromptDigest("보낼 글!") })],
    ["다른 문제", () => ({ ...fields(), incidentId: "monitor:backend" })],
    ["다른 계정", () => ({ ...fields(), account: "admin:other" })],
  ] as const)("%s → mismatch", (_label, expected) => {
    expect(verifyAnalysisPreviewToken(issue(), KEY, expected(), NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("다른 키 · 빈 키 · 미래 시각 → mismatch", () => {
    const token = issue();
    expect(verifyAnalysisPreviewToken(token, `${KEY}x`, fields(), NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyAnalysisPreviewToken(token, "", fields(), NOW)).toEqual({ ok: false, reason: "mismatch" });
    const future = issueAnalysisPreviewToken(KEY, { ...fields(), issuedAt: NOW + 60_000 });
    expect(verifyAnalysisPreviewToken(future, KEY, fields(), NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("재배포의 확인 값(rc1)이나 다른 용도의 서명과 바꿔 끼울 수 없다 — 서명의 마지막 글자만 바꿔도 mismatch", () => {
    const token = issue();
    const signature = token.split(".")[2];
    const flipped = `${token.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    expect(verifyAnalysisPreviewToken(flipped, KEY, fields(), NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it.each([[undefined], [""], ["ap1"], ["rc1.x.1.abc"], [`ap2.${NOW}.${"A".repeat(43)}`], [`ap1.x.${"A".repeat(43)}`], [`ap1.${NOW}.${"A".repeat(42)}`], ["a".repeat(600)], [42]])(
    "꼴이 아님 %j → malformed", (value) => {
      expect(verifyAnalysisPreviewToken(value, KEY, fields(), NOW)).toEqual({ ok: false, reason: "malformed" });
    });

  it("빈 키로는 만들지 않는다", () => {
    expect(() => issueAnalysisPreviewToken(" ", { ...fields(), issuedAt: NOW })).toThrow();
  });
});
