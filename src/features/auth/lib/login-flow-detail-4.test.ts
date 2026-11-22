/** 명세 ② "세부 4"(리뷰 루프 3 반영)의 로그인 흐름 사례. 시계 · 스케줄러는 주입, 실제 대기 없음. */
import { describe, expect, it } from "vitest";
import { OUTAGE, buildHarness, input } from "@/features/auth/lib/login-flow-harness";
import type { ObserveResult } from "@/features/auth/lib/observe-client";
import { REPLAY_INTERVAL_MILLISECONDS } from "@/features/auth/lib/replay-scheduler";
import { FAKE_ADMIN_ID, FAKE_IP, FAKE_PASSWORD, FAKE_USER_AGENT, verdict } from "@/features/auth/lib/test-fakes";
import type { AttemptRecordBody, AttemptVerdict } from "@/features/auth/lib/types";

const BAD_ORIGIN = "https://evil.example.test";

const recovered = (body: AttemptRecordBody): ObserveResult<AttemptVerdict> => ({
  ok: true,
  value: body.credential_ok ? verdict() : verdict({ allowed: false, outcome: "failure", failures: 1 }),
});

/** 재전송 응답을 붙잡아 두는 문 — release() 전까지 재전송 호출은 끝나지 않는다. */
function replayGate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, release };
}

const replayCountById = (attempts: AttemptRecordBody[]) => {
  const counts = new Map<string, number>();
  for (const body of attempts.filter((entry) => entry.replayed)) counts.set(body.attempt_id, (counts.get(body.attempt_id) ?? 0) + 1);
  return counts;
};

describe("세부 4 — 대기열은 스스로 다시 보낸다(30초 주기)", () => {
  it("주기는 30초", () => {
    expect(REPLAY_INTERVAL_MILLISECONDS).toBe(30_000);
  });

  it("장애 중 기록이 쌓이면 30초 주기 시도가 걸리고, 관측 복귀 뒤 새 로그인 없이 다음 주기에 전송되어 대기열 0", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.queue.size()).toBe(1);
    expect(harness.replayScheduler.pendingCount()).toBeGreaterThanOrEqual(1);
    expect(harness.replayScheduler.scheduledDelays).toContain(30_000);
    harness.observe.respondAttempt = recovered;
    harness.replayScheduler.runPending();
    await harness.flow.waitForReplay();
    expect(harness.queue.size()).toBe(0);
    expect(harness.observe.attempts.filter((body) => body.replayed)).toHaveLength(1);
  });

  it("주기 시도가 실패하면 항목은 남고 다음 주기가 다시 걸린다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    harness.replayScheduler.runPending();
    await harness.flow.waitForReplay();
    expect(harness.queue.size()).toBe(1);
    expect(harness.replayScheduler.pendingCount()).toBeGreaterThanOrEqual(1);
    harness.observe.respondAttempt = recovered;
    harness.replayScheduler.runPending();
    await harness.flow.waitForReplay();
    expect(harness.queue.size()).toBe(0);
  });

  it("대기열이 비면 주기 시도가 멈춘다 — 남은 작업을 돌려도 관측 호출 0", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    harness.observe.respondAttempt = recovered;
    harness.replayScheduler.runPending();
    await harness.flow.waitForReplay();
    const callsBefore = harness.observe.attempts.length + harness.observe.rejected.length;
    for (let round = 0; round < 3; round += 1) {
      harness.replayScheduler.runPending();
      await harness.flow.waitForReplay();
    }
    expect(harness.observe.attempts.length + harness.observe.rejected.length).toBe(callsBefore);
    expect(harness.replayScheduler.pendingCount()).toBe(0);
  });

  it("대기열이 빈 채로는 주기 시도를 걸지 않는다", async () => {
    const harness = buildHarness();
    await harness.flow.login(input());
    await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.replayScheduler.pendingCount()).toBe(0);
  });

  it("단일 실행 — 로그인 뒤 재전송이 도는 중에 주기 시도가 와도 같은 항목이 두 번 나가지 않는다", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    await harness.flow.login(input({ password: "fake-wrong" }));
    const gate = replayGate();
    harness.observe.respondAttempt = async (body) => {
      if (body.replayed) await gate.opened;
      return recovered(body);
    };
    await harness.flow.login(input());                // 로그인 뒤 재전송 시작 — 첫 항목에서 멈춰 있다
    harness.replayScheduler.runPending();             // 그 사이 주기 시도
    harness.replayScheduler.runPending();
    gate.release();
    await harness.flow.waitForReplay();
    harness.replayScheduler.runPending();
    await harness.flow.waitForReplay();
    const counts = replayCountById(harness.observe.attempts);
    expect(counts.size).toBe(2);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
    expect(harness.queue.size()).toBe(0);
  });

  it("도는 중에 들어온 항목도 다음 시도에서 빠지지 않는다", async () => {
    const harness = buildHarness();
    let observeDown = true;
    const gate = replayGate();
    harness.observe.respondAttempt = async (body) => {
      if (body.replayed) { await gate.opened; return recovered(body); }
      return observeDown ? OUTAGE : recovered(body);
    };
    await harness.flow.login(input({ password: "fake-wrong" }));      // A — 대기열
    observeDown = false;
    await harness.flow.login(input());                                 // 재전송 시작(A 에서 멈춤)
    observeDown = true;
    await harness.flow.login(input({ password: "fake-wrong" }));      // B — 도는 중에 들어옴
    observeDown = false;
    gate.release();
    await harness.flow.waitForReplay();
    for (let round = 0; round < 3 && harness.queue.size() > 0; round += 1) {
      harness.replayScheduler.runPending();
      await harness.flow.waitForReplay();
    }
    expect(harness.queue.size()).toBe(0);
    const counts = replayCountById(harness.observe.attempts);
    expect(counts.size).toBe(2);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
  });
});

describe("세부 4 — 기록하지 않은 거절의 건수 로그는 이유별 60초에 1줄", () => {
  const linesAbout = (calls: { message: string }[], word: string) => calls.filter((call) => call.message.includes(word));
  const countLine = (calls: { message: string }[], word: string, count: number) =>
    calls.filter((call) => call.message.includes(word) && new RegExp(`\\bcount=${count}\\b`).test(call.message));

  it("Origin 거절 60초 안에 100번 → 관측 기록 1건, 요청마다 로그 없음, flushUnrecordedCounts 가 count=99 1줄", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 100; index += 1) {
      await harness.flow.login(input({ origin: BAD_ORIGIN }));
      harness.clock.advance(500);
    }
    await harness.flow.waitForBackgroundRecords();
    expect(harness.observe.rejected).toHaveLength(1);
    expect(linesAbout(harness.recording.calls, "origin_rejected").length).toBeLessThanOrEqual(2);
    harness.flow.flushUnrecordedCounts();
    expect(countLine(harness.recording.calls, "origin_rejected", 99)).toHaveLength(1);
    harness.flow.flushUnrecordedCounts();                                     // 이미 내보낸 건수는 다시 내지 않는다
    expect(linesAbout(harness.recording.calls, "count=").filter((call) => call.message.includes("origin_rejected"))).toHaveLength(1);
  });

  it("창이 끝나면 그 창의 남은 건수가 나온다(다음 요청 또는 주기 작업 때)", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 100; index += 1) {
      await harness.flow.login(input({ origin: BAD_ORIGIN }));
      harness.clock.advance(500);
    }
    harness.clock.advance(15_000);                       // 첫 거절로부터 65초
    harness.replayScheduler.runPending();
    await harness.flow.login(input({ origin: BAD_ORIGIN }));
    await harness.flow.waitForBackgroundRecords();
    expect(countLine(harness.recording.calls, "origin_rejected", 99)).toHaveLength(1);
  });

  it("창 안의 반복 속도 제한 거절 — 기록 1건, 로그는 집계(count=49)", async () => {
    const harness = buildHarness();
    for (let index = 0; index < 60; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    await harness.flow.waitForBackgroundRecords();
    expect(harness.observe.rejected.filter((body) => body.reason === "rate_limited")).toHaveLength(1);
    expect(linesAbout(harness.recording.calls, "rate_limited").length).toBeLessThanOrEqual(2);
    harness.flow.flushUnrecordedCounts();
    expect(countLine(harness.recording.calls, "rate_limited", 49)).toHaveLength(1);
  });

  it("표 포화 거절 — 기록 없음, 요청마다 로그 없음, flush 에 saturated count=20", async () => {
    const harness = buildHarness({ maxTrackedIps: 3 });
    for (const ip of ["198.51.100.10", "198.51.100.11", "198.51.100.12"]) await harness.flow.login(input({ ip, password: "fake-wrong" }));
    const linesBefore = harness.recording.calls.length;
    for (let index = 0; index < 20; index += 1) {
      expect((await harness.flow.login(input({ ip: `198.51.100.${100 + index}` }))).kind).toBe("rate_limited");
    }
    await harness.flow.waitForBackgroundRecords();
    expect(harness.observe.rejected).toHaveLength(0);
    expect(harness.recording.calls.length - linesBefore).toBeLessThanOrEqual(1);
    harness.flow.flushUnrecordedCounts();
    expect(countLine(harness.recording.calls, "saturated", 20)).toHaveLength(1);
  });

  it("내보낼 건수가 없으면 flush 는 줄을 남기지 않는다", () => {
    const harness = buildHarness();
    harness.flow.flushUnrecordedCounts();
    expect(harness.recording.calls).toHaveLength(0);
  });

  it("집계 줄에도 IP · ID · 비밀번호 · UA 없음", async () => {
    const harness = buildHarness({ maxTrackedIps: 3 });
    for (let index = 0; index < 5; index += 1) await harness.flow.login(input({ origin: BAD_ORIGIN }));
    for (let index = 0; index < 15; index += 1) await harness.flow.login(input({ password: "fake-wrong" }));
    for (let index = 0; index < 5; index += 1) await harness.flow.login(input({ ip: `198.51.100.${150 + index}` }));
    await harness.flow.waitForBackgroundRecords();
    harness.flow.flushUnrecordedCounts();
    for (const text of harness.recording.allStrings()) {
      for (const forbidden of [FAKE_IP, FAKE_ADMIN_ID, FAKE_PASSWORD, FAKE_USER_AGENT, "198.51.100.15"]) expect(text).not.toContain(forbidden);
    }
  });
});

describe("세부 4 — 임시 제한 상태(temporaryRestrictionActive)", () => {
  it("처음에는 false, 관측 장애 로그인 뒤 true, 복귀해 대기열이 비면 false", async () => {
    const harness = buildHarness();
    expect(harness.flow.temporaryRestrictionActive()).toBe(false);
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.flow.temporaryRestrictionActive()).toBe(true);
    harness.observe.respondAttempt = recovered;
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    expect(harness.queue.size()).toBe(0);
    expect(harness.flow.temporaryRestrictionActive()).toBe(false);
  });

  it("마지막 관측 호출은 성공했어도 대기열에 항목이 남아 있으면 true", async () => {
    const harness = buildHarness();
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    harness.observe.respondAttempt = (body) => (body.replayed ? { ok: false, reason: "bad_status", status: 500 } : recovered(body));
    await harness.flow.login(input());
    await harness.flow.waitForReplay();
    expect(harness.queue.size()).toBe(1);
    expect(harness.flow.temporaryRestrictionActive()).toBe(true);
  });

  it("대기열이 비어도 마지막 관측 호출이 실패했으면 true(거절 기록 실패 포함)", async () => {
    const harness = buildHarness({ queueCapacity: 0 });
    harness.observe.respondAttempt = () => OUTAGE;
    await harness.flow.login(input({ password: "fake-wrong" }));
    expect(harness.queue.size()).toBe(0);
    expect(harness.flow.temporaryRestrictionActive()).toBe(true);
  });
});
