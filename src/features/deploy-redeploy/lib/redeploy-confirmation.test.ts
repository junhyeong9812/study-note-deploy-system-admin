/** 재배포의 확인 값 — 명세 ② "확인 화면을 거치지 않은 요청은 통하지 않는다: 확인 값 = (서비스 · 커밋 · 요청 ID · 만든 시각 · 세션의 계정)의 서명,
 * 5분 안에만, 본문의 서비스 · 커밋과 글자까지 같아야 한다. 상태를 두지 않는다" · "한 번만: 요청 ID 는 확인 화면에서 정해 확인 값에 든다". */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { issueSessionToken, verifySessionToken } from "@/features/auth/lib/session";
import { FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  REDEPLOY_CONFIRMATION_LIFETIME_MILLISECONDS, REDEPLOY_CONFIRMATION_MAX_LENGTH, REDEPLOY_CONFIRMATION_PURPOSE, REDEPLOY_REQUEST_ID_PATTERN,
  issueRedeployConfirmation, newRedeployRequestId, verifyRedeployConfirmation, type RedeployConfirmationFields,
} from "@/features/deploy-redeploy/lib/redeploy-confirmation";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const ACCOUNT = "fake-admin-id-zq";
const ISSUED_AT = Date.UTC(2026, 10, 25, 3, 0, 0);
const FIELDS: RedeployConfirmationFields = { service: "backend", commitSha: COMMIT, requestId: "adm-Fake_Request-01", issuedAt: ISSUED_AT, account: ACCOUNT };
const EXPECTED = { service: "backend", commitSha: COMMIT, account: ACCOUNT };

function issue(overrides: Partial<RedeployConfirmationFields> = {}): string {
  return issueRedeployConfirmation(FAKE_SIGNING_KEY, { ...FIELDS, ...overrides });
}

function signatureOf(text: string, key = FAKE_SIGNING_KEY): string {
  return createHmac("sha256", key).update(text).digest("base64url");
}

/** 계약의 꼴대로 손으로 만든 값 — 서명할 줄을 바꿔 끼울 수 있다. */
function handMade(lines: string[], requestId = FIELDS.requestId, issuedAt = ISSUED_AT): string {
  return `rc1.${requestId}.${issuedAt}.${signatureOf(lines.join("\n"))}`;
}

const CONTRACT_LINES = [REDEPLOY_CONFIRMATION_PURPOSE, "rc1", "backend", COMMIT, FIELDS.requestId, String(ISSUED_AT), ACCOUNT];

describe("꼴과 통하는 값", () => {
  it("만든 값은 `rc1.<요청 ID>.<만든 시각>.<서명 43자>` 이고 계약의 일곱 줄에 서명한 것과 같다", () => {
    const token = issue();
    expect(token).toMatch(/^rc1\.adm-Fake_Request-01\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(token).toBe(handMade(CONTRACT_LINES));
  });

  it("만든 직후 · 4분 59.999초 뒤에는 통한다 — 요청 ID 와 만든 시각을 돌려준다", () => {
    const token = issue();
    expect(verifyRedeployConfirmation(token, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT)).toEqual({ ok: true, requestId: FIELDS.requestId, issuedAt: ISSUED_AT });
    expect(verifyRedeployConfirmation(token, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + REDEPLOY_CONFIRMATION_LIFETIME_MILLISECONDS - 1)).toMatchObject({ ok: true });
  });

  it("정확히 5분 뒤부터는 expired", () => {
    expect(REDEPLOY_CONFIRMATION_LIFETIME_MILLISECONDS).toBe(300_000);
    const token = issue();
    expect(verifyRedeployConfirmation(token, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 300_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyRedeployConfirmation(token, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 3_600_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("만든 시각이 지금보다 뒤(시계가 거꾸로)면 통하지 않는다 — mismatch", () => {
    expect(verifyRedeployConfirmation(issue(), FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT - 1)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("상태를 두지 않는다 — 같은 값을 여러 번 검증해도 통하고, 모듈을 새로 읽어도(다른 프로세스) 통한다", async () => {
    const token = issue();
    for (let round = 0; round < 3; round += 1) expect(verifyRedeployConfirmation(token, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000)).toMatchObject({ ok: true });
    vi.resetModules();
    const fresh = await import("@/features/deploy-redeploy/lib/redeploy-confirmation");
    expect(fresh.verifyRedeployConfirmation(token, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000)).toMatchObject({ ok: true });
  });

  it("빈 키로는 만들지 않는다 · 꼴이 틀린 요청 ID 로는 만들지 않는다", () => {
    expect(() => issueRedeployConfirmation("", FIELDS)).toThrow();
    expect(() => issueRedeployConfirmation("   ", FIELDS)).toThrow();
    for (const requestId of ["", "has.dot", "has space", "a".repeat(65), "한글"]) expect(() => issue({ requestId })).toThrow();
  });
});

describe("바꿔 끼우면 통하지 않는다(글자까지 같아야)", () => {
  it.each([
    ["다른 서비스", { ...EXPECTED, service: "front" }],
    ["다른 커밋", { ...EXPECTED, commitSha: OTHER_COMMIT }],
    ["대소문자만 다른 커밋", { ...EXPECTED, commitSha: COMMIT.toUpperCase() }],
    ["짧은 커밋", { ...EXPECTED, commitSha: COMMIT.slice(0, 7) }],
    ["다른 계정의 세션", { ...EXPECTED, account: "fake-other-admin" }],
  ])("%s → mismatch", (_label, expected) => {
    expect(verifyRedeployConfirmation(issue(), FAKE_SIGNING_KEY, expected, ISSUED_AT + 1000)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("다른 키로 만든 값 → mismatch", () => {
    const token = issueRedeployConfirmation("fake-other-signing-key-for-tests-0000000000", FIELDS);
    expect(verifyRedeployConfirmation(token, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("값의 한 글자라도 바뀌면 통하지 않는다 — 요청 ID · 만든 시각 · 서명(마지막 글자 포함)", () => {
    const token = issue();
    const [, requestId, issuedAt, signature] = token.split(".");
    const flip = (text: string, index: number) => text.slice(0, index) + (text[index] === "A" ? "B" : "A") + text.slice(index + 1);
    const tampered = [
      `rc1.${flip(requestId, requestId.length - 1)}.${issuedAt}.${signature}`,
      `rc1.${requestId}.${Number(issuedAt) + 1}.${signature}`,
      `rc1.${requestId}.${issuedAt}.${flip(signature, 0)}`,
      `rc1.${requestId}.${issuedAt}.${flip(signature, signature.length - 1)}`,
    ];
    for (const value of tampered) {
      const result = verifyRedeployConfirmation(value, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000);
      expect(result.ok, value).toBe(false);
    }
  });
});

describe("용도를 가른다 — 세션 토큰과 확인 값은 서로 바꿔 끼워지지 않는다", () => {
  it("세션 토큰을 확인 값 자리에 → 통하지 않는다", () => {
    const sessionToken = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT);
    expect(verifyRedeployConfirmation(sessionToken, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000).ok).toBe(false);
  });

  it("확인 값을 세션 쿠키 자리에 → 세션이 아니다", () => {
    expect(verifySessionToken(issue(), FAKE_SIGNING_KEY, ISSUED_AT + 1000)).toBeNull();
  });

  it("용도 줄 없이 서명한 값 → mismatch(용도 줄이 서명에 들어 있다)", () => {
    expect(verifyRedeployConfirmation(handMade(CONTRACT_LINES.slice(1)), FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyRedeployConfirmation(handMade(["session", ...CONTRACT_LINES.slice(1)]), FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("세션 서명(`v1.<시각>` 에 서명)을 확인 값의 꼴에 옮겨 담은 값 → mismatch", () => {
    const sessionSignature = issueSessionToken(FAKE_SIGNING_KEY, ISSUED_AT).split(".")[2];
    expect(verifyRedeployConfirmation(`rc1.${FIELDS.requestId}.${ISSUED_AT}.${sessionSignature}`, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000))
      .toEqual({ ok: false, reason: "mismatch" });
  });

  it("서비스 · 커밋 · 계정 · 시각 · 요청 ID 가 각각 서명에 든다 — 하나를 빼고 서명한 값은 mismatch", () => {
    for (let index = 2; index < CONTRACT_LINES.length; index += 1) {
      const lines = CONTRACT_LINES.filter((_, position) => position !== index);
      expect(verifyRedeployConfirmation(handMade(lines), FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000), `빠진 줄 ${index}`).toEqual({ ok: false, reason: "mismatch" });
    }
  });
});

describe("꼴이 아닌 값은 malformed", () => {
  it.each([
    ["빈 값", ""],
    ["undefined", undefined],
    ["null", null],
    ["숫자", 12345],
    ["배열", [`rc1.a.1.${"A".repeat(43)}`]],
    ["접두가 다름", `rc2.${FIELDS.requestId}.${ISSUED_AT}.${"A".repeat(43)}`],
    ["조각이 모자람", `rc1.${FIELDS.requestId}.${ISSUED_AT}`],
    ["조각이 남음", `rc1.${FIELDS.requestId}.${ISSUED_AT}.${"A".repeat(43)}.extra`],
    ["잘린 서명", `rc1.${FIELDS.requestId}.${ISSUED_AT}.${"A".repeat(42)}`],
    ["시각이 숫자가 아님", `rc1.${FIELDS.requestId}.soon.${"A".repeat(43)}`],
    ["아주 긴 값", `rc1.${"a".repeat(REDEPLOY_CONFIRMATION_MAX_LENGTH)}.${ISSUED_AT}.${"A".repeat(43)}`],
  ])("%s", (_label, value) => {
    expect(verifyRedeployConfirmation(value, FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000)).toEqual({ ok: false, reason: "malformed" });
  });

  it("잘린 값(진짜 값의 앞부분)도 통하지 않는다", () => {
    const token = issue();
    for (const length of [10, token.length - 1]) expect(verifyRedeployConfirmation(token.slice(0, length), FAKE_SIGNING_KEY, EXPECTED, ISSUED_AT + 1000).ok).toBe(false);
  });

  it("빈 키로 검증하면 어떤 값도 통하지 않는다", () => {
    expect(verifyRedeployConfirmation(issue(), "", EXPECTED, ISSUED_AT + 1000).ok).toBe(false);
  });

  it("서명 비교는 길이에 무관한 시간 비교(timingSafeEqual)를 쓴다", () => {
    const source = readFileSync(new URL("./redeploy-confirmation.ts", import.meta.url), "utf8");
    expect(source).toMatch(/\btimingSafeEqual\s*\(/);
  });
});

describe("요청 ID — 확인 화면이 그릴 때 정한다", () => {
  it("`adm-` 로 시작하고 master 가 받는 꼴 안 · 예측할 수 없게 길다(접두 뒤 20자 이상)", () => {
    const requestId = newRedeployRequestId();
    expect(requestId).toMatch(REDEPLOY_REQUEST_ID_PATTERN);
    expect(requestId).toMatch(/^adm-[A-Za-z0-9_-]{20,60}$/);
  });

  it("부를 때마다 다르다(500번)", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newRedeployRequestId()));
    expect(seen.size).toBe(500);
  });
});

describe("문제의 ID 와 조치의 종류를 묶는다(명세 ⑫ §24 · §25) — ID 가 없으면 지금과 같은 글자", () => {
  const INCIDENT = "monitor:front";
  const BOUND = { incidentId: INCIDENT, action: "rollback" } as const;

  it("ID 가 없으면(undefined · null) 계약의 일곱 줄 그대로 — 지금의 값과 글자까지 같다 · 조치를 줘도 서명에 들지 않는다", () => {
    expect(issue({ incidentId: undefined })).toBe(handMade(CONTRACT_LINES));
    expect(issue({ incidentId: null })).toBe(handMade(CONTRACT_LINES));
    expect(issue({ incidentId: null })).toBe(issue());
    expect(issue({ incidentId: null, action: "rollback" })).toBe(handMade(CONTRACT_LINES));
    expect(issue({ action: "redeploy" })).toBe(handMade(CONTRACT_LINES));
    expect(verifyRedeployConfirmation(issue(), FAKE_SIGNING_KEY, { ...EXPECTED, incidentId: null, action: "rollback" }, ISSUED_AT).ok).toBe(true);
  });

  it("ID 가 있으면 여덟째 줄 `incident:<ID>` · 아홉째 줄 `action:<종류>` 를 더해 서명한다 · 꼴은 그대로(rc1.<요청 ID>.<시각>.<서명>)", () => {
    for (const action of ["rollback", "redeploy"] as const) {
      const token = issue({ incidentId: INCIDENT, action });
      expect(token).toBe(handMade([...CONTRACT_LINES, `incident:${INCIDENT}`, `action:${action}`]));
      expect(token).toMatch(/^rc1\.adm-Fake_Request-01\.\d+\.[A-Za-z0-9_-]{43}$/);
    }
    expect(issue(BOUND)).not.toBe(handMade([...CONTRACT_LINES, `incident:${INCIDENT}`]));
  });

  it("같은 ID · 같은 조치로 검증하면 통한다", () => {
    expect(verifyRedeployConfirmation(issue(BOUND), FAKE_SIGNING_KEY, { ...EXPECTED, ...BOUND }, ISSUED_AT))
      .toEqual({ ok: true, requestId: FIELDS.requestId, issuedAt: ISSUED_AT });
  });

  it.each([
    ["다른 ID 로 바꿈", BOUND, { incidentId: "monitor:backend", action: "rollback" }],
    ["ID 를 뺌", BOUND, { incidentId: null, action: null }],
    ["ID 를 더함(ID 없는 확인 화면의 값)", { incidentId: null, action: null }, BOUND],
    ["접두만 같은 ID", { incidentId: "errors:ab", action: "rollback" }, { incidentId: "errors:abc", action: "rollback" }],
    ["조치를 바꿈(되돌리기 → 다시 배포)", BOUND, { incidentId: INCIDENT, action: "redeploy" }],
    ["조치를 뺌", BOUND, { incidentId: INCIDENT, action: null }],
  ] as const)("%s → mismatch", (_label, issuedWith, verifiedWith) => {
    expect(verifyRedeployConfirmation(issue(issuedWith), FAKE_SIGNING_KEY, { ...EXPECTED, ...verifiedWith }, ISSUED_AT))
      .toEqual({ ok: false, reason: "mismatch" });
  });

  it("ID 가 있어도 만료는 그대로(5분)", () => {
    expect(verifyRedeployConfirmation(issue(BOUND), FAKE_SIGNING_KEY, { ...EXPECTED, ...BOUND }, ISSUED_AT + 300_000))
      .toEqual({ ok: false, reason: "expired" });
  });
});
