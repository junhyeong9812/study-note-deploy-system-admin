/** 테스트 전용 Fake — 시계 · 로거 · fetch · 관측/알림 클라이언트. 값은 전부 명백한 가짜. */
import { vi } from "vitest";
import type { AlertClient } from "@/features/auth/lib/alert-client";
import type { ObserveClient, ObserveResult } from "@/features/auth/lib/observe-client";
import type { AppLogger, AttemptRecordBody, AttemptVerdict, RejectedAttemptBody } from "@/features/auth/lib/types";

export const FAKE_SIGNING_KEY = "fake-signing-key-for-tests-only-0000000000";
export const FAKE_ORIGIN = "https://admin.example.test";
export const FAKE_ADMIN_ID = "fake-admin-id-zq";
export const FAKE_PASSWORD = "fake-password-xq7";
export const FAKE_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHRmYWtlc2FsdA$ZmFrZWhhc2hmYWtlaGFzaGZha2VoYXNoZmFrZWhhcw";
export const FAKE_IP = "198.51.100.77";          // 문서용 대역(TEST-NET-2)
export const FAKE_USER_AGENT = "FakeBrowser/1.0 (test-agent-marker)";

export interface FakeClock {
  now: () => number;
  advance: (milliseconds: number) => void;
  set: (epochMilliseconds: number) => void;
}

export function createFakeClock(start = Date.UTC(2026, 0, 1, 0, 0, 0)): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds) => { current += milliseconds; },
    set: (epochMilliseconds) => { current = epochMilliseconds; },
  };
}

export interface RecordingLogger {
  logger: AppLogger;
  calls: { requestId: string; message: string; level?: string }[];
  allStrings: () => string[];
}

export function createRecordingLogger(): RecordingLogger {
  const calls: RecordingLogger["calls"] = [];
  return {
    logger: (requestId, message, level) => { calls.push({ requestId, message, level }); },
    calls,
    allStrings: () => calls.flatMap((call) => [call.requestId, call.message, call.level ?? ""]),
  };
}

export function verdict(overrides: Partial<AttemptVerdict> = {}): AttemptVerdict {
  return { allowed: true, outcome: "success", lockedUntil: null, lockStarted: false, failures: 0, ...overrides };
}

/** 관측 서버 클라이언트 Fake — 판정 함수를 바꿔 끼운다. 받은 본문을 순서대로 남긴다. */
export interface FakeObserveClient extends ObserveClient {
  attempts: AttemptRecordBody[];
  rejected: RejectedAttemptBody[];
  respondAttempt: (body: AttemptRecordBody) => ObserveResult<AttemptVerdict>;
  respondRejected: (body: RejectedAttemptBody) => ObserveResult<null>;
}

export function createFakeObserveClient(): FakeObserveClient {
  const client: FakeObserveClient = {
    attempts: [],
    rejected: [],
    respondAttempt: (body) => ({ ok: true, value: body.credential_ok ? verdict() : verdict({ allowed: false, outcome: "failure", failures: 1 }) }),
    respondRejected: () => ({ ok: true, value: null }),
    recordAttempt: async (body) => { client.attempts.push(structuredClone(body)); return client.respondAttempt(body); },
    recordRejected: async (body) => { client.rejected.push(structuredClone(body)); return client.respondRejected(body); },
  };
  return client;
}

export interface FakeAlertClient extends AlertClient {
  lockedEvents: string[];
  behavior: "ok" | "fail" | "throw";
}

export function createFakeAlertClient(): FakeAlertClient {
  const client: FakeAlertClient = {
    lockedEvents: [],
    behavior: "ok",
    sendLoginLocked: async (lockedUntil) => {
      client.lockedEvents.push(lockedUntil);
      if (client.behavior === "throw") throw new Error("alert unreachable (fake)");
      return client.behavior === "ok";
    },
  };
  return client;
}

/** fetch Fake — 응답을 차례로 꺼낸다. 함수면 호출해서 결과를 쓴다. */
export type FetchStep = Response | Error | ((url: string, init: RequestInit) => Promise<Response>);

export function createFakeFetch(steps: FetchStep[]) {
  const queue = [...steps];
  return vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const step = queue.shift();
    if (step === undefined) throw new Error("fake fetch: no more steps");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(url, init);
    return step;
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
