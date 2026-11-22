/** 명세 ② "세부 2"(리뷰 루프 1 반영)의 로그인 흐름 사례. */
import { describe, expect, it, vi } from "vitest";
import { ALERT_WAIT_MILLISECONDS, loginResultStatus } from "@/features/auth/lib/login-flow";
import { OUTAGE, TIMEOUT, buildHarness, input } from "@/features/auth/lib/login-flow-harness";
import { FAKE_ADMIN_ID, FAKE_IP, FAKE_PASSWORD, FAKE_USER_AGENT, verdict } from "@/features/auth/lib/test-fakes";
import type { AttemptRecordBody } from "@/features/auth/lib/types";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const OTHER_IP = "198.51.100.201";
const BAD_ORIGIN = "https://evil.example.test";

const recovered = (body: AttemptRecordBody) => ({
  ok: true as const,
  value: body.credential_ok ? verdict() : verdict({ allowed: false, outcome: "failure", failures: 1 }),
});

const problemLineCount = (calls: { level?: string }[]) =>
  calls.filter((call) => call.level === "warning" || call.level === "error").length;

describe("세부 2 — 재전송의 결과(outcome)", () => {
  it("임시 제한 중 시도마다 실제 판정이 실려 {…원본, replayed:true, outcome} 으로 재전송된다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));   // failure
    await harness.flow.login(input({ password: "fake-wrong" }));   // failure
    await harness.flow.login(input({ password: "fake-wrong" }));   // 잠금을 건 그 시도 — 기록은 failure
    await harness.flow.login(input());                             // 잠금 중 맞는 자격 → locked
    await harness.flow.login(input({ password: "fake-wrong" }));   // 잠금 중 틀린 자격 → locked
    harness.clock.advance(FIFTEEN_MINUTES);
    await harness.flow.login(input());                             // 풀린 뒤 맞는 자격 → success
    const originals = harness.observe.attempts.slice();
    expect(originals).toHaveLength(6);

    harness.observe.respondAttempt = recovered;
    await harness.flow.login(input());
    await harness.flow.waitForReplay();

    const replays = harness.observe.attempts.filter((body) => body.replayed);
    const expectedOutcomes = ["failure", "failure", "failure", "locked", "locked", "success"];
    expect(replays).toEqual(originals.map((original, index) => ({ ...original, replayed: true, outcome: expectedOutcomes[index] })));
  });

  it("첫 전송(replayed:false)에는 outcome 키 자체가 없다(관측 서버가 422)", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    harness.observe.respondAttempt = recovered;
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    for (const body of harness.observe.attempts.filter((entry) => !entry.replayed)) {
      expect(Object.keys(body)).not.toContain("outcome");
    }
  });

  it("거절 기록(rejected)은 재전송 때도 본문 그대로(replayed·outcome 없음)", async () => {
    const harness = buildHarness();
    harness.observe.respondRejected = () => OUTAGE;
    await harness.flow.login(input({ origin: BAD_ORIGIN }));
    const original = harness.observe.rejected[0];
    harness.observe.respondRejected = () => ({ ok: true, value: null });
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    expect(harness.observe.rejected).toEqual([original, original]);
    expect(Object.keys(original)).not.toContain("replayed");
    expect(Object.keys(original)).not.toContain("outcome");
  });
});

describe("세부 2 — 시간 초과", () => {
  it("관측 서버 시간 초과 → 바로 임시 제한 판정, 대기열에 넣어 복귀 뒤 같은 attempt_id 로 보낸다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => TIMEOUT;
    const result = await harness.flow.login(input());
    expect(result).toMatchObject({ kind: "success", temporaryRestriction: true });
    expect(harness.queue.size()).toBe(1);
    const original = harness.observe.attempts[0];
    harness.observe.respondAttempt = recovered;
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    const replays = harness.observe.attempts.filter((body) => body.replayed);
    expect(replays).toEqual([{ ...original, replayed: true, outcome: "success" }]);
  });
});

describe("세부 2 — 재전송 응답의 잠금 알림", () => {
  it("재전송 응답이 lock_started:true 면 알림 1건(key 에 그 locked_until)", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.alert.lockedEvents).toEqual([]);
    harness.observe.respondAttempt = (body) => body.replayed
      ? { ok: true, value: verdict({ allowed: false, outcome: "failure", lockedUntil: "2026-01-01T00:20:00.000Z", lockStarted: true, failures: 5 }) }
      : { ok: true, value: verdict() };
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    expect(harness.alert.lockedEvents).toEqual(["2026-01-01T00:20:00.000Z"]);
  });

  it("재전송 응답이 잠금 시작이 아니면 알림 0건(이미 잠긴 상태의 locked 포함)", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    await harness.flow.login(input({ password: "fake-wrong" }));
    let replayIndex = 0;
    harness.observe.respondAttempt = (body) => {
      if (!body.replayed) return { ok: true, value: verdict() };
      replayIndex += 1;
      return replayIndex === 1
        ? { ok: true, value: verdict({ allowed: false, outcome: "failure", failures: 4 }) }
        : { ok: true, value: verdict({ allowed: false, outcome: "locked", lockedUntil: "2026-01-01T00:20:00.000Z", lockStarted: false, failures: 5 }) };
    };
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    expect(harness.alert.lockedEvents).toEqual([]);
  });

  it("재전송 알림이 실패해도 재전송은 이어지고 앱 로그에 남는다", async () => {
    const harness = buildHarness();
    harness.alert.behavior = "throw";
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    await harness.flow.login(input({ password: "fake-wrong" }));
    harness.observe.respondAttempt = (body) => body.replayed
      ? { ok: true, value: verdict({ allowed: false, outcome: "failure", lockedUntil: "2026-01-01T00:20:00.000Z", lockStarted: true, failures: 5 }) }
      : { ok: true, value: verdict() };
    const before = problemLineCount(harness.recording.calls);
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    expect(harness.queue.size()).toBe(0);
    expect(problemLineCount(harness.recording.calls)).toBeGreaterThan(before);
  });
});

describe("세부 2 — 알림은 최대 2초만 기다린다", () => {
  it("상수는 2000 밀리초", () => {
    expect(ALERT_WAIT_MILLISECONDS).toBe(2000);
  });

  it("알림이 끝나지 않으면(2초 대기가 먼저 끝나면) 로그인 결과가 먼저 돌아오고 실패 로그 1줄", async () => {
    const delay = vi.fn(async (_milliseconds: number) => undefined);
    const reference = buildHarness();
    const harness = buildHarness({ delay });
    harness.alert.behavior = "hang";
    const lockStart = () => ({ ok: true as const, value: verdict({ allowed: false, outcome: "failure", lockedUntil: "2026-01-01T00:15:00.000Z", lockStarted: true, failures: 5 }) });
    reference.observe.respondAttempt = lockStart;
    harness.observe.respondAttempt = lockStart;
    const expected = await reference.flow.login(input({ password: "fake-wrong" }));
    const result = await harness.flow.login(input({ password: "fake-wrong" }));
    expect(result).toEqual(expected);
    expect(result).toEqual({ kind: "locked", temporaryRestriction: false });
    expect(delay).toHaveBeenCalledWith(2000);
    expect(problemLineCount(harness.recording.calls)).toBe(problemLineCount(reference.recording.calls) + 1);
  });

  it("임시 잠금의 알림도 같은 상한 — 알림이 끝나지 않아도 세 번째 실패는 locked 로 돌아온다", async () => {
    const delay = vi.fn(async (_milliseconds: number) => undefined);
    const harness = buildHarness({ delay });
    harness.alert.behavior = "hang";
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    await harness.flow.login(input({ password: "fake-wrong" }));
    expect(await harness.flow.login(input({ password: "fake-wrong" }))).toEqual({ kind: "locked", temporaryRestriction: true });
    expect(delay).toHaveBeenCalledWith(2000);
  });

  it("알림이 빨리 끝나면 2초 대기를 기다리지 않는다(대기가 끝나지 않아도 결과가 온다)", async () => {
    const harness = buildHarness();   // 기본 delay = 끝나지 않는 약속
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict({ allowed: false, outcome: "failure", lockedUntil: "2026-01-01T00:15:00.000Z", lockStarted: true, failures: 5 }) });
    await harness.flow.login(input({ password: "fake-wrong" }));   // 끝나지 않는 대기에 묶이지 않고 돌아온다(결과의 꼴은 '잠금을 건 그 시도' 사례가 고정)
    expect(harness.alert.lockedEvents).toHaveLength(1);
  });
});

describe("세부 2 — 잠금을 건 그 시도의 응답", () => {
  it("관측 판정 outcome:failure + lockStarted:true → locked(423), 임시 제한 아님", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict({ allowed: false, outcome: "failure", lockedUntil: "2026-01-01T00:15:00.000Z", lockStarted: true, failures: 5 }) });
    const result = await harness.flow.login(input({ password: "fake-wrong" }));
    expect(result).toEqual({ kind: "locked", temporaryRestriction: false });
    expect(loginResultStatus(result)).toBe(423);
  });

  it("outcome:failure + lockStarted:false 는 그대로 failure(401)", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => ({ ok: true, value: verdict({ allowed: false, outcome: "failure", failures: 4 }) });
    const result = await harness.flow.login(input({ password: "fake-wrong" }));
    expect(result).toEqual({ kind: "failure", temporaryRestriction: false });
  });
});

describe("세부 2 — 기록 범위(rejected 이유 3종, IP 마다 60초 창에 이유별 첫 1건)", () => {
  it("Origin 거절 — 같은 IP 에서 여러 번이어도 창당 1건, 다른 IP 는 따로, 60초 뒤 다시 1건", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 5; index += 1) await harness.flow.login(input({ origin: BAD_ORIGIN }));
    expect(harness.observe.rejected.map((body) => body.reason)).toEqual(["origin_rejected"]);
    await harness.flow.login(input({ origin: BAD_ORIGIN, ip: OTHER_IP }));
    expect(harness.observe.rejected).toHaveLength(2);
    expect(harness.observe.rejected[1].ip).toBe(OTHER_IP);
    harness.clock.advance(60_000);
    await harness.flow.login(input({ origin: BAD_ORIGIN }));
    expect(harness.observe.rejected).toHaveLength(3);
  });

  it("거절 기록 본문 — attempt_id · 시각 · reason · IP · User-Agent(앞 200자)", async () => {
    const harness = buildHarness();
    await harness.flow.login(input({ origin: null, userAgent: "U".repeat(300) }));
    const body = harness.observe.rejected[0];
    expect(body).toEqual({
      attempt_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      at: new Date(harness.clock.now()).toISOString(),
      reason: "origin_rejected", ip: FAKE_IP, user_agent: "U".repeat(200),
    });
  });

  it("형식 오류 → malformed(400), 비밀번호 검증·판정 호출 없음, rejected reason malformed 창당 1건", async () => {
    const harness = buildHarness();
    const first = await harness.flow.login(input({ malformed: true }));
    expect(first).toEqual({ kind: "malformed" });
    expect(loginResultStatus(first)).toBe(400);
    for (let index = 0; index < 3; index += 1) await harness.flow.login(input({ malformed: true }));
    expect(harness.verifyPassword).not.toHaveBeenCalled();
    expect(harness.observe.attempts).toHaveLength(0);
    expect(harness.observe.rejected.map((body) => body.reason)).toEqual(["malformed"]);
  });

  it("형식 오류는 id·password 를 보지 않는다(맞는 자격이 실려 있어도 성공이 아니다)", async () => {
    const harness = buildHarness();
    expect(await harness.flow.login(input({ id: FAKE_ADMIN_ID, password: FAKE_PASSWORD, malformed: true }))).toEqual({ kind: "malformed" });
  });

  it("이유는 따로 센다 — 같은 IP 의 Origin 거절 · 형식 오류 · 속도 제한이 각각 1건", async () => {
    const harness = buildHarness();
    await harness.flow.login(input({ origin: BAD_ORIGIN }));
    await harness.flow.login(input({ malformed: true }));
    for (let index = 0; index < 12; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.observe.rejected.map((body) => body.reason).sort()).toEqual(["malformed", "origin_rejected", "rate_limited"]);
  });

  it("거절 기록이 관측 서버 장애로 실패하면 대기열에 둔다(Origin 거절)", async () => {
    const harness = buildHarness();
    harness.observe.respondRejected = () => OUTAGE;
    await harness.flow.login(input({ origin: BAD_ORIGIN }));
    expect(harness.queue.size()).toBe(1);
  });
});

describe("세부 2 — 순서: Origin 검사 → 속도 제한 → 본문 해석", () => {
  it("형식 오류도 속도 제한에 센다 — 형식 오류 10회 뒤 11번째는(형식 오류든 맞는 자격이든) 429", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 10; index += 1) expect((await harness.flow.login(input({ malformed: true }))).kind).toBe("malformed");
    expect(await harness.flow.login(input({ malformed: true }))).toEqual({ kind: "rate_limited" });
    expect(await harness.flow.login(input())).toEqual({ kind: "rate_limited" });
    expect(harness.observe.rejected.map((body) => body.reason)).toEqual(["malformed", "rate_limited"]);
  });

  it("출처가 틀린 형식 오류는 origin_rejected(본문을 보기 전에 거절), 속도 제한을 쓰지 않는다", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 15; index += 1) {
      expect(await harness.flow.login(input({ origin: BAD_ORIGIN, malformed: true }))).toEqual({ kind: "origin_rejected" });
    }
    expect((await harness.flow.login(input())).kind).toBe("success");
  });
});

describe("세부 2 — 대기열을 넣을 때마다 현재 건수가 앱 로그에", () => {
  it("장애 중 시도 3건 → queued=1 · queued=2 · queued=3 이 각각 남는다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    for (let index = 0; index < 3; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    const messages = harness.recording.calls.map((call) => call.message);
    for (const count of [1, 2, 3]) {
      expect(messages.some((message) => new RegExp(`\\bqueued=${count}\\b`).test(message)), `queued=${count}`).toBe(true);
    }
  });

  it("거절 기록을 대기열에 넣을 때도 현재 건수가 남는다", async () => {
    const harness = buildHarness();
    harness.observe.respondRejected = () => OUTAGE;
    await harness.flow.login(input({ origin: BAD_ORIGIN }));
    expect(harness.recording.calls.some((call) => /\bqueued=1\b/.test(call.message))).toBe(true);
  });
});

describe("세부 2 — 새 경로에서도 앱 로그에 IP · 입력 ID · 비밀번호 · UA 없음", () => {
  it("Origin 거절 · 형식 오류 · 시간 초과 · 대기열 · 재전송 잠금 알림 · 알림 대기 초과를 거친 뒤 검사", async () => {
    const delay = vi.fn(async (_milliseconds: number) => undefined);
    const harness = buildHarness({ delay });
    const typedId = "fake-typed-id-marker-2";
    const typedPassword = "fake-typed-password-marker-2";
    await harness.flow.login(input({ origin: BAD_ORIGIN, id: typedId, password: typedPassword }));
    await harness.flow.login(input({ malformed: true, id: typedId, password: typedPassword }));
    harness.observe.respondAttempt = () => TIMEOUT;
    harness.observe.respondRejected = () => OUTAGE;
    await harness.flow.login(input({ id: typedId, password: typedPassword }));
    await harness.flow.login(input({ password: typedPassword }));
    await harness.flow.login(input({ origin: null, ip: OTHER_IP }));
    harness.alert.behavior = "hang";
    harness.observe.respondAttempt = (body) => body.replayed
      ? { ok: true, value: verdict({ allowed: false, outcome: "failure", lockedUntil: "2026-01-01T00:20:00.000Z", lockStarted: true, failures: 5 }) }
      : { ok: true, value: verdict({ allowed: false, outcome: "failure", lockedUntil: "2026-01-01T00:15:00.000Z", lockStarted: true, failures: 5 }) };
    harness.observe.respondRejected = () => ({ ok: true, value: null });
    await harness.flow.login(input({ password: typedPassword }));
    harness.alert.behavior = "fail";
    await harness.flow.waitForReplay();

    const strings = harness.recording.allStrings();
    expect(strings.length).toBeGreaterThan(0);
    for (const forbidden of [FAKE_IP, OTHER_IP, typedId, typedPassword, FAKE_ADMIN_ID, FAKE_PASSWORD, FAKE_USER_AGENT]) {
      for (const text of strings) expect(text, `logged: ${text}`).not.toContain(forbidden);
    }
  });
});
