/** 테스트 전용 Fake — 시계 · 로거 · fetch · 관측/알림 클라이언트. 값은 전부 명백한 가짜. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  respondAttempt: (body: AttemptRecordBody) => ObserveResult<AttemptVerdict> | Promise<ObserveResult<AttemptVerdict>>;
  respondRejected: (body: RejectedAttemptBody) => ObserveResult<null> | Promise<ObserveResult<null>>;
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
  /** hang = 끝나지 않는 알림(느린 알림 서버) */
  behavior: "ok" | "fail" | "throw" | "hang";
}

export function createFakeAlertClient(): FakeAlertClient {
  const client: FakeAlertClient = {
    lockedEvents: [],
    behavior: "ok",
    sendLoginLocked: async (lockedUntil) => {
      client.lockedEvents.push(lockedUntil);
      if (client.behavior === "throw") throw new Error("alert unreachable (fake)");
      if (client.behavior === "hang") return new Promise<boolean>(() => undefined);
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

export const APP_DIRECTORY = fileURLToPath(new URL("../../../app", import.meta.url));

export interface AppRoute {
  path: string;
  kind: "page" | "route";
  file: string;   // 절대 경로
}

/** src/app 의 page · route 에서 경로를 뽑는다. (그룹)은 지우고 [동적]은 견본 값으로 바꾼다. */
export function routesFromAppDirectory(): AppRoute[] {
  if (!existsSync(APP_DIRECTORY)) return [];
  const routes: AppRoute[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) { walk(fullPath); continue; }
      const match = /^(page|route)\.(tsx|ts|jsx|js)$/.exec(entry);
      if (!match) continue;
      const segments = relative(APP_DIRECTORY, directory).split(sep).filter(Boolean)
        .filter((segment) => !/^\(.*\)$/.test(segment))
        .map((segment) => (/^\[.*\]$/.test(segment) ? "sample-segment" : segment));
      routes.push({ path: `/${segments.join("/")}`, kind: match[1] as "page" | "route", file: fullPath });
    }
  };
  walk(APP_DIRECTORY);
  return routes;
}

/** 세션 없이 열리는 실제 경로(명세 ② 인증 경계: 로그인 화면 · 로그인 요청 · 헬스). */
export const PUBLIC_ROUTE_PATHS: ReadonlySet<string> = new Set(["/login", "/api/auth/login", "/api/health"]);

/** 세부 4 — 직접 돌리는 스케줄러 Fake(실제 대기 없음). */
export interface FakeScheduler {
  scheduler: (callback: () => void, milliseconds: number) => { cancel(): void; keepsProcessAlive(): boolean };
  scheduledDelays: number[];
  pendingCount: () => number;
  /** 지금 걸려 있는 작업을 한 번씩 실행한다(실행 중 새로 걸린 작업은 다음 호출 몫). 실행한 개수. */
  runPending: () => number;
}

export function createFakeScheduler(): FakeScheduler {
  let tasks: { callback: () => void; cancelled: boolean }[] = [];
  const scheduledDelays: number[] = [];
  return {
    scheduler: (callback, milliseconds) => {
      const task = { callback, cancelled: false };
      tasks.push(task);
      scheduledDelays.push(milliseconds);
      return { cancel: () => { task.cancelled = true; }, keepsProcessAlive: () => false };
    },
    scheduledDelays,
    pendingCount: () => tasks.filter((task) => !task.cancelled).length,
    runPending: () => {
      const due = tasks.filter((task) => !task.cancelled);
      tasks = [];
      for (const task of due) task.callback();
      return due.length;
    },
  };
}
