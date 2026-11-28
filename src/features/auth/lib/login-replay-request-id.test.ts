/** ⑬ T2g 리뷰 R1 — 로그인 대기열의 재전송은 어느 로그인 요청의 추적 ID 도 싣지 않는다(통신 규약 §1.2 "들어온 요청 없이 시작되는 호출은 새 추적 ID ·
 * 접수 요청의 ID 를 뒤쪽 호출까지 끌고 가지 않는다" · 명세 "T2g 리뷰의 반영" R1).
 * 고정하는 계약(가짜 관측 · 알림 서버가 받은 `X-Request-Id` · 본문의 `attempt_id` · 로그 줄의 ID 자리로):
 * - 재전송된 기록의 호출에는 대기열을 처음 채운 요청 · 뒤에 넣은 요청 · 그때 로그인하는 요청의 값이 0번 — 새 16진수 소문자 32자. 타이머의 길 · 로그인의 길 둘 다.
 * - 한 바퀴 = 한 값(그 바퀴의 기록 · 재시도 · 잠금 알림이 모두 같은 값) · 바퀴마다 다른 값(실패해 다시 건 타이머가 앞 바퀴의 값을 잇지 않는다).
 * - 그 바퀴의 로그 줄(`login:queue_replay` · `login:lock_started source=replay` · `login:lock_alert_* source=replay` · `login:queue_discarded`)의 ID 자리 = 그 바퀴의 값
 *   (고정 낱말 `replay-timer` 도, 들어온 요청의 값도 아니다).
 * - 로그인하는 요청 자신(판정 호출 · 자기 시도 기록 · 거절 기록 · 자기 로그 줄)은 그 요청의 ID 그대로 — 같은 요청 안에서 재전송이 시작돼도 섞이지 않는다.
 * - 본문(`attempt_id` · `replayed` · outcome) · 재전송의 차례 · 수는 그대로.
 * 흐름은 실제 관측 · 알림 클라이언트(가짜 fetch)로 조립하고, 로그인마다 진입(`POST /api/auth/login`)처럼 `runWithRequestId(그 요청의 ID, …)` 안에서 부른다.
 * 재전송 타이머는 실제 setTimeout 처럼 건 때의 범위(AsyncLocalStorage)를 콜백에 잇는 가짜(AsyncResource.bind) — 30초를 기다리지 않고 손으로 터뜨린다
 * (vitest 의 가짜 타이머는 콜백을 테스트의 범위에서 불러 물려받음을 보지 못한다). */
import { AsyncResource } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createAlertClient } from "@/features/auth/lib/alert-client";
import { createAttemptQueue } from "@/features/auth/lib/attempt-queue";
import { createLoginFlow, type LoginInput } from "@/features/auth/lib/login-flow";
import { createObserveClient } from "@/features/auth/lib/observe-client";
import { createRateLimiter } from "@/features/auth/lib/rate-limit";
import { REPLAY_INTERVAL_MILLISECONDS, type Scheduler } from "@/features/auth/lib/replay-scheduler";
import { createTemporaryLockout } from "@/features/auth/lib/temporary-lockout";
import {
  FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_PASSWORD_HASH, FAKE_SIGNING_KEY, FAKE_USER_AGENT, createFakeClock, createRecordingLogger,
} from "@/features/auth/lib/test-fakes";
import type { PasswordVerifier } from "@/features/auth/lib/types";
import { runWithRequestId } from "@/shared/lib/request-scope";
import { FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, jsonBody } from "@/shared/lib/upstream-test-fakes";

const NEW_ID = /^[0-9a-f]{32}$/;
const REPLAY_LOG = /^login:(queue_replay|queue_discarded|lock_started source=replay|lock_alert_\w+ source=replay)/;

interface RecordedCall { path: string; requestId: string | null; body: Record<string, unknown> }
interface PendingTimer { callback: () => void; milliseconds: number; cancelled: boolean }

/** 관측 서버의 답 — down 이면 503. up 이면 attempts 는 판정, rejected 는 기록. respond 로 기록마다 바꿀 수 있다. */
type ObserveAnswer = { kind: "down" } | { kind: "up" } | { kind: "status"; status: number } | { kind: "lock" };

function buildFlow() {
  const clock = createFakeClock();
  const recording = createRecordingLogger();
  const calls: RecordedCall[] = [];
  const timers: PendingTimer[] = [];
  const server = { up: false, answerFor: (_body: Record<string, unknown>): ObserveAnswer | null => null };

  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: url.pathname, requestId: new Headers(init.headers ?? {}).get("x-request-id"), body });
    if (url.origin === new URL(FAKE_ALERT_URL).origin) return jsonBody({ success: true, data: {} });
    const answer = server.answerFor(body) ?? (server.up ? { kind: "up" } : { kind: "down" });
    if (answer.kind === "down") return jsonBody({ success: false, error: { code: "unavailable" } }, 503);
    if (answer.kind === "status") return jsonBody({ success: false, error: { code: "invalid" } }, answer.status);
    if (url.pathname === "/auth/attempts/rejected") return jsonBody({ success: true, data: {} });
    if (answer.kind === "lock") {
      return jsonBody({ success: true, data: { allowed: false, outcome: "failure", locked_until: "2026-01-01T00:15:00.000Z", lock_started: true, failures: 5 } });
    }
    const credentialOk = body.credential_ok === true;
    return jsonBody({ success: true, data: credentialOk
      ? { allowed: true, outcome: "success", locked_until: null, lock_started: false, failures: 0 }
      : { allowed: false, outcome: "failure", locked_until: null, lock_started: false, failures: 1 } });
  }) as unknown as (input: string, init: RequestInit) => Promise<Response>;

  /** 실제 setTimeout 처럼 건 때의 범위를 콜백에 잇는다. */
  const scheduler: Scheduler = (callback, milliseconds) => {
    const timer: PendingTimer = { callback: AsyncResource.bind(callback), milliseconds, cancelled: false };
    timers.push(timer);
    return { cancel: () => { timer.cancelled = true; }, keepsProcessAlive: () => false };
  };

  let attemptCounter = 0;
  const verifyPassword: PasswordVerifier = async (passwordHash, password) => passwordHash === FAKE_PASSWORD_HASH && password === FAKE_PASSWORD;
  const flow = createLoginFlow({
    clock: clock.now,
    newAttemptId: () => {
      attemptCounter += 1;
      return `00000000-0000-4000-8000-${String(attemptCounter).padStart(12, "0")}`;
    },
    account: { adminId: FAKE_ADMIN_ID, passwordHash: FAKE_PASSWORD_HASH },
    verifyPassword,
    sessionSigningKey: FAKE_SIGNING_KEY,
    configuredOrigin: FAKE_ORIGIN,
    rateLimiter: createRateLimiter({ clock: clock.now }),
    temporaryLockout: createTemporaryLockout({ clock: clock.now }),
    attemptQueue: createAttemptQueue({ capacity: 500 }),
    observeClient: createObserveClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch, clock: clock.now }),
    alertClient: createAlertClient({ baseUrl: FAKE_ALERT_URL, secret: FAKE_ALERT_SECRET, fetch }),
    logger: recording.logger,
    delay: () => new Promise<void>(() => undefined),   // 알림이 먼저 끝난다
    scheduler,
  });

  let ipCounter = 0;
  /** 진입처럼 그 요청의 범위 안에서 로그인 — 이 시도의 attempt_id 를 돌려준다(뒤에서 보내는 거절 기록까지 기다린다). */
  async function loginAs(requestId: string, overrides: Partial<LoginInput> = {}): Promise<string> {
    ipCounter += 1;
    const attemptId = `00000000-0000-4000-8000-${String(attemptCounter + 1).padStart(12, "0")}`;
    await runWithRequestId(requestId, () => flow.login({
      id: FAKE_ADMIN_ID, password: "fake-wrong-password-marker-pw7", ip: `198.51.100.${ipCounter}`, userAgent: FAKE_USER_AGENT, origin: FAKE_ORIGIN, requestId, ...overrides,
    }));
    await flow.waitForBackgroundRecords();
    return attemptId;
  }

  /** 걸린 재전송 타이머를 모두 터뜨리고(건 때의 범위에서) 재전송이 끝나기를 기다린다. 걸린 것이 없으면 실패. */
  async function fireReplayTimers() {
    const due = timers.filter((timer) => !timer.cancelled && timer.milliseconds === REPLAY_INTERVAL_MILLISECONDS);
    expect(due.length, "재전송 타이머가 걸리지 않았다(빈 검사)").toBeGreaterThan(0);
    for (const timer of due) {
      timer.cancelled = true;
      timer.callback();
    }
    await flow.waitForReplay();
  }

  return { flow, calls, server, recording, loginAs, fireReplayTimers };
}

type Built = ReturnType<typeof buildFlow>;

/** 그 attempt_id 의 기록을 다시 보낸 호출(재전송) — 첫 호출(그 로그인 자신)은 빼고 from 번째 호출부터. */
function replayCallsOf(built: Built, attemptIds: string[], from: number): RecordedCall[] {
  return built.calls.slice(from).filter((call) => attemptIds.includes(String(call.body.attempt_id)));
}

/** 한 바퀴의 호출이 모두 같은 새 값이고 금지한 값이 0번 — 그 값을 돌려준다. */
function expectOneNewRoundId(calls: RecordedCall[], forbidden: string[], label: string): string {
  expect(calls.length, `${label} — 재전송 호출이 없다(빈 검사)`).toBeGreaterThan(0);
  const ids = calls.map((call) => call.requestId);
  for (const id of ids) {
    expect(id, `${label} — 새 16진 32자`).toMatch(NEW_ID);
    expect(forbidden, `${label} — 로그인 요청의 값을 싣지 않는다`).not.toContain(id);
  }
  expect(new Set(ids).size, `${label} — 한 바퀴 = 한 값`).toBe(1);
  return ids[0]!;
}

function replayLogLines(built: Built) {
  return built.recording.calls.filter((call) => REPLAY_LOG.test(call.message));
}

describe("타이머의 길 — 대기열을 처음 채운 요청 · 뒤에 넣은 요청의 값을 싣지 않는다", () => {
  it("503 동안 reqA1 · reqA2 · reqA3 → 살린 뒤 타이머의 재전송 셋이 같은 새 값 · 로그 줄도 그 값 · 본문과 차례는 그대로", async () => {
    const built = buildFlow();
    const attemptIds = [await built.loginAs("reqA1"), await built.loginAs("reqA2"), await built.loginAs("reqA3")];
    // 로그인 자신의 판정 호출(첫 호출 · 재시도)은 그 요청의 값
    for (const [index, requestId] of ["reqA1", "reqA2", "reqA3"].entries()) {
      const own = built.calls.filter((call) => call.body.attempt_id === attemptIds[index]);
      expect(own.length).toBeGreaterThan(0);
      for (const call of own) expect(call.requestId, `${requestId} 자신의 판정 호출`).toBe(requestId);
    }
    const before = built.calls.length;
    built.server.up = true;
    await built.fireReplayTimers();
    const replayed = replayCallsOf(built, attemptIds, before);
    expect(replayed.map((call) => call.body.attempt_id)).toEqual(attemptIds);   // 차례 · 수 그대로
    for (const call of replayed) {
      expect(call.path).toBe("/auth/attempts");
      expect(call.body.replayed).toBe(true);
      expect(call.body.outcome).toBe("failure");
    }
    const roundId = expectOneNewRoundId(replayed, ["reqA1", "reqA2", "reqA3"], "타이머의 재전송");
    const lines = replayLogLines(built);
    expect(lines.map((line) => line.message)).toEqual(["login:queue_replay sent=3 remaining=0"]);
    for (const line of lines) expect(line.requestId).toBe(roundId);
    expect(built.recording.calls.map((call) => call.requestId)).not.toContain("replay-timer");
  });

  it("거절 기록(Origin 거절 — 뒤에서 보낸 것)도 — 재전송은 그 요청의 값이 아니다 · 처음 보낸 것은 그 요청의 값", async () => {
    const built = buildFlow();
    const rejectedId = await built.loginAs("reqR1", { origin: "https://elsewhere.example.test" });
    const first = built.calls.filter((call) => call.body.attempt_id === rejectedId);
    expect(first.length).toBeGreaterThan(0);
    for (const call of first) {
      expect(call.path).toBe("/auth/attempts/rejected");
      expect(call.requestId).toBe("reqR1");
    }
    const before = built.calls.length;
    built.server.up = true;
    await built.fireReplayTimers();
    const replayed = replayCallsOf(built, [rejectedId], before);
    expect(replayed.map((call) => call.path)).toEqual(["/auth/attempts/rejected"]);
    const roundId = expectOneNewRoundId(replayed, ["reqR1"], "거절 기록의 재전송");
    for (const line of replayLogLines(built)) expect(line.requestId).toBe(roundId);
  });

  it("실패해 다시 건 다음 바퀴는 다른 값 — 타이머가 다시 걸려도 앞 바퀴의 값이 이어지지 않는다(세 바퀴)", async () => {
    const built = buildFlow();
    const attemptIds = [await built.loginAs("reqB1"), await built.loginAs("reqB2")];
    let before = built.calls.length;
    await built.fireReplayTimers();   // 아직 503 — 첫 기록에서 멈춘다(재시도 포함)
    const firstRound = replayCallsOf(built, attemptIds, before);
    expect(firstRound.every((call) => call.body.attempt_id === attemptIds[0])).toBe(true);
    const firstId = expectOneNewRoundId(firstRound, ["reqB1", "reqB2"], "첫 바퀴(실패)");
    before = built.calls.length;
    await built.fireReplayTimers();   // 또 실패
    const secondId = expectOneNewRoundId(replayCallsOf(built, attemptIds, before), ["reqB1", "reqB2", firstId], "둘째 바퀴(실패)");
    before = built.calls.length;
    built.server.up = true;
    await built.fireReplayTimers();
    const thirdRound = replayCallsOf(built, attemptIds, before);
    expect(thirdRound.map((call) => call.body.attempt_id)).toEqual(attemptIds);
    const thirdId = expectOneNewRoundId(thirdRound, ["reqB1", "reqB2", firstId, secondId], "셋째 바퀴(성공)");
    const lines = replayLogLines(built);
    expect(lines.map((line) => line.message)).toEqual([
      "login:queue_replay sent=0 remaining=2", "login:queue_replay sent=0 remaining=2", "login:queue_replay sent=2 remaining=0",
    ]);
    expect(lines.map((line) => line.requestId)).toEqual([firstId, secondId, thirdId]);
  });

  it("재전송의 응답이 잠금 시작이면 — lock_started source=replay 줄과 알림 서버의 사건이 그 바퀴의 값", async () => {
    const built = buildFlow();
    const attemptIds = [await built.loginAs("reqL1"), await built.loginAs("reqL2")];
    built.server.up = true;
    built.server.answerFor = (body) => (body.replayed === true && body.attempt_id === attemptIds[1] ? { kind: "lock" } : null);
    const before = built.calls.length;
    await built.fireReplayTimers();
    const replayed = built.calls.slice(before);
    expect(replayed.map((call) => call.path)).toEqual(["/auth/attempts", "/auth/attempts", "/events"]);
    const roundId = expectOneNewRoundId(replayed, ["reqL1", "reqL2"], "재전송 + 잠금 알림");
    const lines = replayLogLines(built);
    expect(lines.map((line) => line.message)).toEqual(["login:lock_started source=replay until=2026-01-01T00:15:00.000Z", "login:queue_replay sent=2 remaining=0"]);
    for (const line of lines) expect(line.requestId).toBe(roundId);
  });

  it("관측 서버가 422 로 버린 기록 — queue_discarded 줄도 그 바퀴의 값", async () => {
    const built = buildFlow();
    const attemptIds = [await built.loginAs("reqX1"), await built.loginAs("reqX2")];
    built.server.up = true;
    built.server.answerFor = (body) => (body.replayed === true && body.attempt_id === attemptIds[0] ? { kind: "status", status: 422 } : null);
    const before = built.calls.length;
    await built.fireReplayTimers();
    const replayed = replayCallsOf(built, attemptIds, before);
    // 422 도 관측 클라이언트가 한 번 다시 보낸다(기존 동작) — 차례만 본다
    expect([...new Set(replayed.map((call) => call.body.attempt_id))]).toEqual(attemptIds);
    const roundId = expectOneNewRoundId(replayed, ["reqX1", "reqX2"], "버림이 있는 바퀴");
    const lines = replayLogLines(built);
    expect(lines.map((line) => line.message)).toEqual(["login:queue_replay sent=1 remaining=0", "login:queue_discarded discarded=1 status=422"]);
    for (const line of lines) expect(line.requestId).toBe(roundId);
  });
});

describe("로그인의 길 — 그때 로그인하는 요청의 값을 남의 기록에 싣지 않는다", () => {
  it("503 동안 reqC1 · reqC2 → 살린 뒤 reqD 로 로그인: reqD 자신은 reqD · 재전송된 reqC1 · reqC2 의 기록은 새 값 하나", async () => {
    const built = buildFlow();
    const queuedIds = [await built.loginAs("reqC1"), await built.loginAs("reqC2")];
    built.server.up = true;
    const before = built.calls.length;
    const ownId = await built.loginAs("reqD", { password: FAKE_PASSWORD });
    await built.flow.waitForReplay();
    // reqD 자신 — 판정 호출 · 로그 줄은 reqD
    const own = built.calls.slice(before).filter((call) => call.body.attempt_id === ownId);
    expect(own.map((call) => [call.body.replayed, call.requestId])).toEqual([[false, "reqD"]]);
    const ownLines = built.recording.calls.filter((call) => call.message.startsWith("login:success"));
    expect(ownLines.map((call) => call.requestId)).toEqual(["reqD"]);
    // 재전송 — reqC1 · reqC2 · reqD 의 값이 0번
    const replayed = replayCallsOf(built, queuedIds, before);
    expect(replayed.map((call) => call.body.attempt_id)).toEqual(queuedIds);
    for (const call of replayed) expect(call.body.replayed).toBe(true);
    const roundId = expectOneNewRoundId(replayed, ["reqC1", "reqC2", "reqD"], "로그인의 길의 재전송");
    const lines = replayLogLines(built);
    expect(lines.map((line) => line.message)).toEqual(["login:queue_replay sent=2 remaining=0"]);
    for (const line of lines) expect(line.requestId).toBe(roundId);
  });

  it("그 요청의 거절 기록이 성공해 재전송을 시작해도 — 거절 기록은 그 요청의 값 · 재전송은 새 값", async () => {
    const built = buildFlow();
    const queuedIds = [await built.loginAs("reqE1")];
    built.server.up = true;
    const before = built.calls.length;
    const rejectedId = await built.loginAs("reqF", { origin: "https://elsewhere.example.test" });
    await built.flow.waitForReplay();
    const own = built.calls.slice(before).filter((call) => call.body.attempt_id === rejectedId);
    expect(own.map((call) => [call.path, call.requestId])).toEqual([["/auth/attempts/rejected", "reqF"]]);
    const roundId = expectOneNewRoundId(replayCallsOf(built, queuedIds, before), ["reqE1", "reqF"], "거절 기록 뒤의 재전송");
    for (const line of replayLogLines(built)) expect(line.requestId).toBe(roundId);
    const ownLines = built.recording.calls.filter((call) => call.message.startsWith("login:origin_rejected"));
    expect(ownLines.map((call) => call.requestId)).toEqual(["reqF"]);
  });

  it("두 길의 바퀴는 서로 다른 값 — 로그인의 길 바퀴 뒤 남은 것을 타이머가 보낼 때도 새 값", async () => {
    const built = buildFlow();
    const queuedIds = [await built.loginAs("reqG1"), await built.loginAs("reqG2")];
    built.server.up = true;
    // 로그인의 길 바퀴는 둘째 기록에서 멈춘다(503) — 남은 것은 타이머의 바퀴가 보낸다
    built.server.answerFor = (body) => (body.replayed === true && body.attempt_id === queuedIds[1] ? { kind: "down" } : null);
    let before = built.calls.length;
    await built.loginAs("reqH", { password: FAKE_PASSWORD });
    await built.flow.waitForReplay();
    const loginRoundId = expectOneNewRoundId(replayCallsOf(built, queuedIds, before), ["reqG1", "reqG2", "reqH"], "로그인의 길 바퀴");
    built.server.answerFor = () => null;
    before = built.calls.length;
    await built.fireReplayTimers();
    const timerRound = replayCallsOf(built, queuedIds, before);
    expect(timerRound.map((call) => call.body.attempt_id)).toEqual([queuedIds[1]]);
    expectOneNewRoundId(timerRound, ["reqG1", "reqG2", "reqH", loginRoundId], "그 뒤 타이머의 바퀴");
  });
});
