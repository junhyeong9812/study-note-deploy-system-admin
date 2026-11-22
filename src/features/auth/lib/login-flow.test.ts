import { describe, expect, it, vi } from "vitest";
import { createAttemptQueue } from "@/features/auth/lib/attempt-queue";
import { createLoginFlow, loginResultStatus, type LoginInput, type LoginResult } from "@/features/auth/lib/login-flow";
import { createRateLimiter } from "@/features/auth/lib/rate-limit";
import { verifySessionToken } from "@/features/auth/lib/session";
import { createTemporaryLockout } from "@/features/auth/lib/temporary-lockout";
import {
  FAKE_ADMIN_ID, FAKE_IP, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_PASSWORD_HASH, FAKE_SIGNING_KEY, FAKE_USER_AGENT,
  createFakeAlertClient, createFakeClock, createFakeObserveClient, createRecordingLogger, verdict,
} from "@/features/auth/lib/test-fakes";
import type { PasswordVerifier } from "@/features/auth/lib/types";

const OUTAGE = { ok: false as const, reason: "unreachable" as const };

function buildHarness(options: { queueCapacity?: number; account?: { adminId: string; passwordHash: string } } = {}) {
  const clock = createFakeClock();
  const recording = createRecordingLogger();
  const observe = createFakeObserveClient();
  const alert = createFakeAlertClient();
  const queue = createAttemptQueue({ capacity: options.queueCapacity ?? 500 });
  const temporaryLockout = createTemporaryLockout({ clock: clock.now });
  const rateLimiter = createRateLimiter({ clock: clock.now });
  const verifyPassword = vi.fn<PasswordVerifier>(async (passwordHash, password) =>
    passwordHash === FAKE_PASSWORD_HASH && password === FAKE_PASSWORD);
  let attemptCounter = 0;
  const flow = createLoginFlow({
    clock: clock.now,
    newAttemptId: () => {
      attemptCounter += 1;
      return `00000000-0000-4000-8000-${String(attemptCounter).padStart(12, "0")}`;
    },
    account: options.account ?? { adminId: FAKE_ADMIN_ID, passwordHash: FAKE_PASSWORD_HASH },
    verifyPassword,
    sessionSigningKey: FAKE_SIGNING_KEY,
    configuredOrigin: FAKE_ORIGIN,
    rateLimiter, temporaryLockout, attemptQueue: queue,
    observeClient: observe, alertClient: alert, logger: recording.logger,
  });
  return { clock, recording, observe, alert, queue, temporaryLockout, verifyPassword, flow };
}

function input(overrides: Partial<LoginInput> = {}): LoginInput {
  return { id: FAKE_ADMIN_ID, password: FAKE_PASSWORD, ip: FAKE_IP, userAgent: FAKE_USER_AGENT, origin: FAKE_ORIGIN, ...overrides };
}

describe("로그인 흐름 — 정상(관측 서버 응답)", () => {
  it("맞는 자격 + allowed:true → 성공, 세션은 지금 시각으로 서명되어 검증된다", async () => {
    const harness = buildHarness();
    const result = await harness.flow.login(input());
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.temporaryRestriction).toBe(false);
    expect(verifySessionToken(result.sessionToken, FAKE_SIGNING_KEY, harness.clock.now())).toEqual({ issuedAt: harness.clock.now() });
  });

  it("관측 서버에 보낸 기록 — attempt_id · 시각 · credential_ok · IP · User-Agent · replayed:false, ID·비밀번호 없음", async () => {
    const harness = buildHarness();
    await harness.flow.login(input());
    expect(harness.observe.attempts).toHaveLength(1);
    const body = harness.observe.attempts[0];
    expect(body).toEqual({
      attempt_id: "00000000-0000-4000-8000-000000000001",
      at: new Date(harness.clock.now()).toISOString(),
      credential_ok: true, ip: FAKE_IP, user_agent: FAKE_USER_AGENT, replayed: false,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(FAKE_ADMIN_ID);
    expect(serialized).not.toContain(FAKE_PASSWORD);
  });

  it("User-Agent 는 앞 200자만 보낸다", async () => {
    const harness = buildHarness();
    await harness.flow.login(input({ userAgent: "U".repeat(500) }));
    expect(harness.observe.attempts[0].user_agent).toBe("U".repeat(200));
  });

  it("맞는 자격이어도 관측 서버가 allowed:false(잠금 중)면 locked, 세션 없음", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict({ allowed: false, outcome: "locked", lockedUntil: "2026-01-01T00:15:00.000Z" }) });
    const result = await harness.flow.login(input());
    expect(result).toEqual({ kind: "locked", temporaryRestriction: false });
    expect(harness.observe.attempts[0].credential_ok).toBe(true);   // 잠금 중의 시도도 기록된다
  });

  it("자격이 틀리면 관측 서버가 allowed:true 라고 해도 성공이 아니다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict({ allowed: true, outcome: "success" }) });
    const result = await harness.flow.login(input({ password: "fake-wrong" }));
    expect(result.kind).not.toBe("success");
  });

  it("ID 틀림과 비밀번호 틀림은 같은 결과(구별 없는 한 가지 응답)", async () => {
    const harness = buildHarness();
    const wrongId = await harness.flow.login(input({ id: "fake-other-id" }));
    const wrongPassword = await harness.flow.login(input({ password: "fake-wrong" }));
    expect(wrongId).toEqual({ kind: "failure", temporaryRestriction: false });
    expect(wrongPassword).toEqual(wrongId);
    expect(loginResultStatus(wrongId)).toBe(loginResultStatus(wrongPassword));
  });

  it("ID 가 틀려도 비밀번호 검증을 1회 한다(시간 구별 방지)", async () => {
    const harness = buildHarness();
    await harness.flow.login(input({ id: "fake-other-id" }));
    expect(harness.verifyPassword).toHaveBeenCalledTimes(1);
  });

  it("ID 가 틀린 시도는 credential_ok:false 로 기록된다(유일 계정의 실패에 든다)", async () => {
    const harness = buildHarness();
    await harness.flow.login(input({ id: "fake-other-id" }));
    expect(harness.observe.attempts[0].credential_ok).toBe(false);
  });

  it("설정이 빈 계정은 검증 함수가 무엇을 돌려줘도 로그인 거절", async () => {
    const harness = buildHarness({ account: { adminId: "", passwordHash: "" } });
    harness.verifyPassword.mockResolvedValue(true);
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict() });
    const result = await harness.flow.login(input({ id: "", password: "" }));
    expect(result.kind).not.toBe("success");
  });

  it("lock_started:true 면 알림 1건(locked_until 그대로), 결과는 locked", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict({ allowed: false, outcome: "locked", lockedUntil: "2026-01-01T00:15:00.000Z", lockStarted: true, failures: 5 }) });
    const result = await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.alert.lockedEvents).toEqual(["2026-01-01T00:15:00.000Z"]);
    expect(result.kind).toBe("locked");
  });

  it("lock_started:false 인 잠금(이미 잠긴 상태)에서는 알림을 보내지 않는다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict({ allowed: false, outcome: "locked", lockedUntil: "2026-01-01T00:15:00.000Z", lockStarted: false }) });
    await harness.flow.login(input());
    await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.alert.lockedEvents).toEqual([]);
  });

  it.each(["fail", "throw"] as const)("알림 실패(%s)는 결과를 바꾸지 않고 앱 로그 1줄", async (behavior) => {
    const reference = buildHarness();
    const harness = buildHarness();
    harness.alert.behavior = behavior;
    const lockVerdict = () => ({ ok: true as const, value: verdict({ allowed: false, outcome: "locked", lockedUntil: "2026-01-01T00:15:00.000Z", lockStarted: true, failures: 5 }) });
    reference.observe.respondAttempt = lockVerdict;
    harness.observe.respondAttempt = lockVerdict;
    const expected = await reference.flow.login(input({ password: "fake-wrong" }));
    const result = await harness.flow.login(input({ password: "fake-wrong" }));
    expect(result).toEqual(expected);
    const problemLines = (calls: { level?: string }[]) => calls.filter((call) => call.level === "warning" || call.level === "error").length;
    expect(problemLines(harness.recording.calls)).toBe(problemLines(reference.recording.calls) + 1);
  });
});

describe("로그인 흐름 — Origin 검사", () => {
  it.each([null, "", "http://admin.example.test", "https://evil.example.test"])(
    "Origin %j → origin_rejected, 속도 제한·비밀번호 검증·관측 서버 호출 없음", async (origin) => {
      const harness = buildHarness();
      const result = await harness.flow.login(input({ origin }));
      expect(result).toEqual({ kind: "origin_rejected" });
      expect(loginResultStatus(result)).toBe(403);
      expect(harness.verifyPassword).not.toHaveBeenCalled();
      expect(harness.observe.attempts).toHaveLength(0);
      expect(harness.observe.rejected).toHaveLength(0);
    });

  it("출처 거절은 속도 제한 횟수를 쓰지 않는다", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 20; index += 1) await harness.flow.login(input({ origin: "https://evil.example.test" }));
    expect((await harness.flow.login(input())).kind).toBe("success");
  });
});

describe("로그인 흐름 — 속도 제한", () => {
  it("같은 IP 11번째 → rate_limited(429), 비밀번호 검증·판정 호출 없음", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 10; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    harness.verifyPassword.mockClear();
    const attemptsBefore = harness.observe.attempts.length;
    const result = await harness.flow.login(input());
    expect(result).toEqual({ kind: "rate_limited" });
    expect(loginResultStatus(result)).toBe(429);
    expect(harness.verifyPassword).not.toHaveBeenCalled();
    expect(harness.observe.attempts.length).toBe(attemptsBefore);
  });

  it("거절은 IP 마다 창당 첫 1건만 rejected 로 기록, 나머지는 앱 로그에 건수만", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 15; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.observe.rejected).toHaveLength(1);
    expect(harness.observe.rejected[0]).toMatchObject({ reason: "rate_limited", ip: FAKE_IP, user_agent: FAKE_USER_AGENT });
    expect(harness.observe.rejected[0].at).toBe(new Date(harness.clock.now()).toISOString());
    expect(harness.observe.rejected[0].attempt_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("창이 지나면 다시 허용되고, 다시 막히면 그 창의 첫 거절이 기록된다", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 12; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    harness.clock.advance(60_000);
    expect((await harness.flow.login(input())).kind).toBe("success");
    for (let index = 0; index < 11; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.observe.rejected).toHaveLength(2);
  });

  it("다른 IP 는 영향을 받지 않는다", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 11; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    expect((await harness.flow.login(input({ ip: "198.51.100.200" }))).kind).toBe("success");
  });

  it("rejected 기록이 관측 서버 장애로 실패하면 대기열에 둔다", async () => {
    const harness = buildHarness();
    harness.observe.respondRejected = () => OUTAGE;
    for (let index = 0; index < 11; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.queue.size()).toBe(1);
  });
});

describe("로그인 흐름 — 관측 서버 장애(임시 제한)", () => {
  it("맞는 자격이면 막지 않는다 — 성공 + temporaryRestriction:true + 대기열 1건", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    const result = await harness.flow.login(input());
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.temporaryRestriction).toBe(true);
    expect(harness.queue.size()).toBe(1);
  });

  it("틀린 자격 → failure + temporaryRestriction:true", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    expect(await harness.flow.login(input({ password: "fake-wrong" }))).toEqual({ kind: "failure", temporaryRestriction: true });
  });

  it("3회 실패 → 15분 잠금, 잠금 중 맞는 자격도 locked", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    for (let index = 0; index < 3; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    expect(await harness.flow.login(input())).toEqual({ kind: "locked", temporaryRestriction: true });
    harness.clock.advance(15 * 60 * 1000 - 1);
    expect((await harness.flow.login(input())).kind).toBe("locked");
    harness.clock.advance(1);
    expect((await harness.flow.login(input())).kind).toBe("success");
  });

  it("관측 서버가 응답하면 임시 제한이 아니라 관측 서버 판정을 따른다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    for (let index = 0; index < 3; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict() });
    const result = await harness.flow.login(input());
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.temporaryRestriction).toBe(false);
  });

  it("대기열 항목은 원래 attempt_id·시각, 복귀 뒤 replayed:true 로 전송된다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    const outageAttempt = harness.observe.attempts[0];
    expect(outageAttempt.replayed).toBe(false);
    harness.clock.advance(5 * 60 * 1000);
    harness.observe.respondAttempt = (body) => ({ ok: true, value: body.credential_ok ? verdict() : verdict({ allowed: false, outcome: "failure", failures: 1 }) });
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    const replays = harness.observe.attempts.filter((body) => body.replayed);
    expect(replays).toHaveLength(1);
    expect(replays[0]).toEqual({ ...outageAttempt, replayed: true });
    expect(harness.queue.size()).toBe(0);
  });

  it("복귀 뒤 재전송이 실패하면 대기열에 남는다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    harness.observe.respondAttempt = (body) => (body.replayed ? OUTAGE : { ok: true, value: verdict() });
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    expect(harness.queue.size()).toBe(1);
  });

  it("재전송은 현재 로그인 판정을 바꾸지 않는다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    for (let index = 0; index < 2; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    harness.observe.respondAttempt = (body) => body.replayed
      ? { ok: true, value: verdict({ allowed: false, outcome: "locked" }) }
      : { ok: true, value: verdict() };
    const result = await harness.flow.login(input());
    expect(result.kind).toBe("success");
  });

  it("대기열이 넘치면 버린 건수가 앱 로그에 남는다(조용히 버리지 않는다)", async () => {
    const harness = buildHarness({ queueCapacity: 1 });
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.queue.droppedCount()).toBe(1);
    const dropLines = harness.recording.calls.filter((call) => /dropped=1\b/.test(call.message));
    expect(dropLines.length).toBeGreaterThanOrEqual(1);
  });

  it("장애 중의 시도는 앱 로그에 남는다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    const before = harness.recording.calls.length;
    await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.recording.calls.length).toBeGreaterThan(before);
  });
});

describe("로그인 흐름 — 앱 로그에 IP · 입력 ID · 비밀번호 · User-Agent 없음", () => {
  it("성공 · 실패 · 잠금 알림 실패 · 속도 제한 · 장애 · 넘침 · 재전송을 모두 거친 뒤 로거가 받은 문자열 검사", async () => {
    const harness = buildHarness({ queueCapacity: 2 });
    const typedId = "fake-typed-id-marker";
    const typedPassword = "fake-typed-password-marker";
    await harness.flow.login(input());
    await harness.flow.login(input({ id: typedId, password: typedPassword }));
    harness.alert.behavior = "throw";
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict({ allowed: false, outcome: "locked", lockedUntil: "2026-01-01T00:15:00.000Z", lockStarted: true }) });
    await harness.flow.login(input({ password: typedPassword }));
    harness.observe.respondAttempt = () => OUTAGE;
    harness.observe.respondRejected = () => OUTAGE;
    for (let index = 0; index < 14; index += 1) await harness.flow.login(input({ id: typedId, password: typedPassword }));
    harness.clock.advance(60_000);
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict() });
    harness.observe.respondRejected = () => ({ ok: true, value: null });
    await harness.flow.login(input());
    await harness.flow.waitForReplay();

    const strings = harness.recording.allStrings();
    expect(strings.length).toBeGreaterThan(0);
    for (const forbidden of [FAKE_IP, typedId, typedPassword, FAKE_ADMIN_ID, FAKE_PASSWORD, FAKE_USER_AGENT]) {
      for (const text of strings) expect(text, `logged: ${text}`).not.toContain(forbidden);
    }
  });
});

describe("loginResultStatus", () => {
  it.each<[LoginResult, number]>([
    [{ kind: "success", sessionToken: "x", temporaryRestriction: false }, 200],
    [{ kind: "failure", temporaryRestriction: false }, 401],
    [{ kind: "locked", temporaryRestriction: true }, 423],
    [{ kind: "rate_limited" }, 429],
    [{ kind: "origin_rejected" }, 403],
  ])("%j → %i", (result, status) => {
    expect(loginResultStatus(result)).toBe(status);
  });
});
