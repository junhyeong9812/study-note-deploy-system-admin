/** 명세 ② "세부 3"(리뷰 루프 2 반영)의 로그인 흐름 사례. 시간은 주입한 시계, 실제 대기 없음. */
import { describe, expect, it, vi } from "vitest";
import { OUTAGE, TIMEOUT, buildHarness, input } from "@/features/auth/lib/login-flow-harness";
import type { LoginResult } from "@/features/auth/lib/login-flow";
import type { ObserveResult } from "@/features/auth/lib/observe-client";
import { FAKE_ADMIN_ID, FAKE_IP, FAKE_PASSWORD, FAKE_USER_AGENT, verdict } from "@/features/auth/lib/test-fakes";
import type { AttemptRecordBody, AttemptVerdict } from "@/features/auth/lib/types";

const BAD_ORIGIN = "https://evil.example.test";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/** 마이크로태스크를 다 비우고 매크로태스크 한 번 — 실제 시간을 기다리지 않는다. */
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settlesBeforeMacrotask(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), nextMacrotask().then(() => false)]);
}

const recovered = (body: AttemptRecordBody): ObserveResult<AttemptVerdict> => ({
  ok: true,
  value: body.credential_ok ? verdict() : verdict({ allowed: false, outcome: "failure", failures: 1 }),
});

describe("세부 3 — 거절 기록은 응답을 기다리게 하지 않는다", () => {
  const cases: [string, (harness: ReturnType<typeof buildHarness>) => Promise<void>, Partial<Parameters<ReturnType<typeof buildHarness>["flow"]["login"]>[0]>, LoginResult][] = [
    ["Origin 거절 403", async () => undefined, { origin: BAD_ORIGIN }, { kind: "origin_rejected" }],
    ["형식 오류 400", async () => undefined, { malformed: true }, { kind: "malformed" }],
    ["속도 제한 429", async (harness) => {
      for (let index = 0; index < 10; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    }, {}, { kind: "rate_limited" }],
  ];

  it.each(cases)("%s — 기록 전송이 멈춰 있어도 결과가 먼저 돌아온다, 전송은 뒤에서 끝나고 실패하면 대기열", async (_label, prepare, overrides, expected) => {
    const harness = buildHarness();
    await prepare(harness);
    const pending = deferred<ObserveResult<null>>();
    harness.observe.respondRejected = () => pending.promise;
    const loginPromise = harness.flow.login(input(overrides));
    expect(await settlesBeforeMacrotask(loginPromise)).toBe(true);
    expect(await loginPromise).toEqual(expected);
    expect(harness.observe.rejected).toHaveLength(1);   // 전송은 시작됐다(버리지 않는다)
    expect(harness.queue.size()).toBe(0);
    pending.resolve(OUTAGE);
    await harness.flow.waitForBackgroundRecords();
    expect(harness.queue.size()).toBe(1);
  });

  it("뒤에서 끝난 전송이 성공하면 대기열에 넣지 않는다", async () => {
    const harness = buildHarness();
    const pending = deferred<ObserveResult<null>>();
    harness.observe.respondRejected = () => pending.promise;
    await harness.flow.login(input({ origin: BAD_ORIGIN }));
    pending.resolve({ ok: true, value: null });
    await harness.flow.waitForBackgroundRecords();
    expect(harness.queue.size()).toBe(0);
  });
});

describe("세부 3 — 거절 기록의 창: IP 마다 고정 60초 창에 이유별 1건(꾸준히 두드려도)", () => {
  it("6초 간격으로 10회 허용을 채운 뒤 60초 동안 100ms 마다 → rate_limited 기록 1건, 창이 지나면 1건 더", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 10; index += 1) {
      await harness.flow.login(input({ password: "fake-wrong" }));
      if (index < 9) harness.clock.advance(6_000);
    }
    harness.clock.advance(100);                               // t = 54.1s — 첫 거절, 창 시작
    const windowStart = harness.clock.now();
    while (harness.clock.now() - windowStart < 60_000) {
      await harness.flow.login(input({ password: "fake-wrong" }));
      harness.clock.advance(100);
    }
    const rateLimitedRecords = () => harness.observe.rejected.filter((body) => body.reason === "rate_limited");
    expect(rateLimitedRecords()).toHaveLength(1);
    // 창(60초)이 지난 뒤 다시 거절되면 새 창의 1건
    for (let index = 0; index < 20; index += 1) {
      await harness.flow.login(input({ password: "fake-wrong" }));
      harness.clock.advance(100);
    }
    expect(rateLimitedRecords().length).toBeGreaterThanOrEqual(1);
    expect(rateLimitedRecords().length).toBeLessThanOrEqual(2);
  });

  it.each([
    ["origin_rejected", { origin: BAD_ORIGIN }],
    ["malformed", { malformed: true }],
  ] as const)("%s — 60초 동안 100ms 마다 두드려도 1건", async (reason, overrides) => {
    const harness = buildHarness();
    const start = harness.clock.now();
    let malformedSeen = 0;
    while (harness.clock.now() - start < 60_000) {
      const result = await harness.flow.login(input(overrides));
      if (result.kind === "malformed") malformedSeen += 1;
      harness.clock.advance(100);
    }
    expect(harness.observe.rejected.filter((body) => body.reason === reason)).toHaveLength(1);
    if (reason === "malformed") expect(malformedSeen).toBeGreaterThan(0);
  });
});

describe("세부 3 — 속도 제한 표가 가득 찼을 때(닫힌 쪽)", () => {
  it("maxTrackedIps 3: A 10회 · B · C 뒤 D 는 429, 관측 서버에 기록하지 않고 건수는 로그, A 는 60초 안에 여전히 429", async () => {
    const harness = buildHarness({ maxTrackedIps: 3 });
    for (let index = 0; index < 10; index += 1) await harness.flow.login(input({ ip: "198.51.100.10", password: "fake-wrong" }));
    harness.clock.advance(1_000);
    expect((await harness.flow.login(input({ ip: "198.51.100.11", password: "fake-wrong" }))).kind).toBe("failure");
    harness.clock.advance(1_000);
    expect((await harness.flow.login(input({ ip: "198.51.100.12", password: "fake-wrong" }))).kind).toBe("failure");
    harness.clock.advance(1_000);
    const logLinesBefore = harness.recording.calls.length;
    expect(await harness.flow.login(input({ ip: "198.51.100.13" }))).toEqual({ kind: "rate_limited" });
    await harness.flow.waitForBackgroundRecords();
    expect(harness.observe.rejected).toHaveLength(0);
    expect(harness.verifyPassword).toHaveBeenCalledTimes(12);
    expect(harness.recording.calls.length).toBeGreaterThan(logLinesBefore);
    harness.clock.advance(7_000);                                        // t = 10s
    expect(await harness.flow.login(input({ ip: "198.51.100.10" }))).toEqual({ kind: "rate_limited" });
  });

  it("창이 지난 항목은 정리되어 새 IP 가 다시 들어온다", async () => {
    const harness = buildHarness({ maxTrackedIps: 3 });
    for (const ip of ["198.51.100.10", "198.51.100.11", "198.51.100.12"]) await harness.flow.login(input({ ip, password: "fake-wrong" }));
    expect((await harness.flow.login(input({ ip: "198.51.100.13" }))).kind).toBe("rate_limited");
    harness.clock.advance(60_000);
    expect((await harness.flow.login(input({ ip: "198.51.100.13" }))).kind).toBe("success");
  });
});

describe("세부 3 — 본문 읽기는 Origin 검사 · 속도 제한 뒤(readCredentials)", () => {
  it("틀린 Origin 이면 본문을 읽지 않는다", async () => {
    const harness = buildHarness();
    const readCredentials = vi.fn(async () => ({ id: FAKE_ADMIN_ID, password: FAKE_PASSWORD }));
    expect(await harness.flow.login(input({ origin: BAD_ORIGIN, readCredentials }))).toEqual({ kind: "origin_rejected" });
    expect(readCredentials).not.toHaveBeenCalled();
  });

  it("속도 제한에 걸리면 본문을 읽지 않는다", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 10; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    const readCredentials = vi.fn(async () => ({ id: FAKE_ADMIN_ID, password: FAKE_PASSWORD }));
    expect(await harness.flow.login(input({ readCredentials }))).toEqual({ kind: "rate_limited" });
    expect(readCredentials).not.toHaveBeenCalled();
  });

  it("통과하면 1회 읽고 그 자격을 쓴다(id·password 칸보다 우선)", async () => {
    const harness = buildHarness();
    const readCredentials = vi.fn(async () => ({ id: FAKE_ADMIN_ID, password: FAKE_PASSWORD }));
    const result = await harness.flow.login(input({ id: "", password: "", readCredentials }));
    expect(result.kind).toBe("success");
    expect(readCredentials).toHaveBeenCalledTimes(1);
  });

  it("읽기 결과가 null(상한·기한·형식) → malformed, 기록 reason malformed, 비밀번호 검증 없음", async () => {
    const harness = buildHarness();
    expect(await harness.flow.login(input({ readCredentials: async () => null }))).toEqual({ kind: "malformed" });
    await harness.flow.waitForBackgroundRecords();
    expect(harness.verifyPassword).not.toHaveBeenCalled();
    expect(harness.observe.rejected.map((body) => body.reason)).toEqual(["malformed"]);
  });
});

describe("세부 3 — 관측 서버가 허용한 성공은 임시 횟수도 0 으로", () => {
  it("장애 중 실패 2회 → 복귀 뒤 성공 → 다시 장애 중 실패 1회는 failure(잠금 아님)", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    await harness.flow.login(input({ password: "fake-wrong" }));
    harness.observe.respondAttempt = recovered;
    expect((await harness.flow.login(input())).kind).toBe("success");
    await harness.flow.waitForReplay();
    harness.observe.respondAttempt = () => OUTAGE;
    expect(await harness.flow.login(input({ password: "fake-wrong" }))).toEqual({ kind: "failure", temporaryRestriction: true });
    expect(harness.temporaryLockout.failures()).toBe(1);
  });
});

describe("세부 3 — 대기열의 버릴 항목: 재전송에 422 만 버린다", () => {
  it("가운데 항목이 422 → 그것만 버리고 뒤 항목은 계속 전송, 버린 건수·상태 코드가 로그에(IP·ID 없음)", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    for (let index = 0; index < 3; index += 1) {
      await harness.flow.login(input({ password: "fake-wrong" }));
      harness.temporaryLockout.decide(true);   // 임시 잠금이 걸리지 않게 — 이 사례는 대기열만 본다
    }
    const queuedIds = harness.observe.attempts.map((body) => body.attempt_id);
    harness.observe.respondAttempt = (body) => {
      if (!body.replayed) return { ok: true, value: verdict() };
      if (body.attempt_id === queuedIds[1]) return { ok: false, reason: "bad_status", status: 422 };
      return recovered(body);
    };
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    const replayedIds = harness.observe.attempts.filter((body) => body.replayed).map((body) => body.attempt_id);
    expect(replayedIds).toEqual(queuedIds);       // 422 뒤의 항목도 보냈다
    expect(harness.queue.size()).toBe(0);
    const discardLines = harness.recording.calls.filter((call) => /\b422\b/.test(call.message) && /\bdiscarded=1\b/.test(call.message));
    expect(discardLines.length).toBeGreaterThanOrEqual(1);
    for (const text of harness.recording.allStrings()) {
      for (const forbidden of [FAKE_IP, FAKE_ADMIN_ID, FAKE_PASSWORD, FAKE_USER_AGENT]) expect(text).not.toContain(forbidden);
    }
  });

  it.each<[string, ObserveResult<AttemptVerdict>]>([
    ["401", { ok: false, reason: "bad_status", status: 401 }],
    ["429", { ok: false, reason: "bad_status", status: 429 }],
    ["500", { ok: false, reason: "bad_status", status: 500 }],
    ["연결 실패", OUTAGE],
    ["시간 초과", TIMEOUT],
    ["해석 불가 본문", { ok: false, reason: "bad_body" }],
  ])("재전송이 %s 면 버리지 않고 남겨 다음에 다시 보낸다", async (_label, failure) => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    harness.observe.respondAttempt = (body) => (body.replayed ? failure : { ok: true, value: verdict() });
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    expect(harness.queue.size()).toBe(1);
    harness.observe.respondAttempt = recovered;
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    expect(harness.queue.size()).toBe(0);
  });

  it("거절 기록의 재전송도 422 면 버리고 다음으로", async () => {
    const harness = buildHarness();
    harness.observe.respondRejected = () => OUTAGE;
    await harness.flow.login(input({ origin: BAD_ORIGIN }));
    await harness.flow.login(input({ origin: BAD_ORIGIN, ip: "198.51.100.201" }));
    await harness.flow.waitForBackgroundRecords();
    expect(harness.queue.size()).toBe(2);
    let replayIndex = 0;
    harness.observe.respondRejected = () => {
      replayIndex += 1;
      return replayIndex === 1 ? { ok: false, reason: "bad_status", status: 422 } : { ok: true, value: null };
    };
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    expect(harness.queue.size()).toBe(0);
  });
});
