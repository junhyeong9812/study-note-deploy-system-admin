/** 세부 2 — 종료 때의 대기열: SIGTERM 에 물린 처리기가 대기 건수 · 누적 유실 건수를 1줄 남긴다. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as loginPost } from "@/app/api/auth/login/route";
import { logQueueOnShutdown } from "@/features/auth/server/shutdown-logging";
import { register } from "@/instrumentation";
import { FAKE_ADMIN_ID, FAKE_IP, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_PASSWORD_HASH, FAKE_SIGNING_KEY, FAKE_USER_AGENT } from "@/features/auth/lib/test-fakes";

const LOGIN_SERVICE_KEY = Symbol.for("study-note-admin.login-service");
const consoleLines: string[] = [];

function loginRequest(password: string): Request {
  return new Request(new URL("/api/auth/login", FAKE_ORIGIN), {
    method: "POST",
    headers: { origin: FAKE_ORIGIN, "content-type": "application/json", "x-real-ip": FAKE_IP, "user-agent": FAKE_USER_AGENT },
    body: JSON.stringify({ id: FAKE_ADMIN_ID, password }),
  });
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[LOGIN_SERVICE_KEY];
  consoleLines.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_USER", FAKE_ADMIN_ID);
  vi.stubEnv("ADMIN_PASSWORD_HASH", FAKE_PASSWORD_HASH);   // 형식만 argon2id(검증은 false) — 대기열을 채우는 데만 쓴다
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", "http://observe.example.test:17000");
  vi.stubEnv("OBSERVE_SECRET", "fake-observe-secret");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed: ECONNREFUSED"); }));   // 관측 서버 장애
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const shutdownLines = () => consoleLines.filter((line) => /\bqueued=\d+/.test(line) && /\bdropped=\d+/.test(line));

describe("logQueueOnShutdown", () => {
  it("장애 중 시도 2건 뒤 → queued=2 dropped=0 을 담은 1줄", async () => {
    await loginPost(loginRequest(FAKE_PASSWORD));
    await loginPost(loginRequest("fake-wrong"));
    consoleLines.length = 0;
    logQueueOnShutdown();
    const lines = shutdownLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\bqueued=2\b/);
    expect(lines[0]).toMatch(/\bdropped=0\b/);
  });

  it("로그인 서비스가 아직 없어도 queued=0 dropped=0 1줄(예외 없음)", () => {
    logQueueOnShutdown();
    const lines = shutdownLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\bqueued=0\b/);
    expect(lines[0]).toMatch(/\bdropped=0\b/);
  });

  it("줄에 IP · ID · 비밀번호 · UA 가 없다", async () => {
    await loginPost(loginRequest(FAKE_PASSWORD));
    logQueueOnShutdown();
    for (const line of consoleLines) {
      for (const forbidden of [FAKE_IP, FAKE_ADMIN_ID, FAKE_PASSWORD, FAKE_USER_AGENT]) expect(line).not.toContain(forbidden);
    }
  });
});

describe("instrumentation register — SIGTERM 에 물린다", () => {
  it("Node 런타임이면 SIGTERM 처리기를 등록하고, 그 처리기가 대기열 1줄을 남긴다", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    const capture = (event: string | symbol, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(String(event)) ?? [];
      list.push(handler);
      handlers.set(String(event), list);
      return process;
    };
    vi.spyOn(process, "on").mockImplementation(capture as typeof process.on);
    vi.spyOn(process, "once").mockImplementation(capture as typeof process.once);
    vi.spyOn(process, "addListener").mockImplementation(capture as typeof process.addListener);
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);

    await register();
    const sigtermHandlers = handlers.get("SIGTERM") ?? [];
    expect(sigtermHandlers.length).toBeGreaterThanOrEqual(1);

    await loginPost(loginRequest("fake-wrong"));
    consoleLines.length = 0;
    for (const handler of sigtermHandlers) handler("SIGTERM");
    const lines = shutdownLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\bqueued=1\b/);
  });
});

describe("세부 4 — 종료 때 아직 내보내지 않은 거절 건수도 내보낸다", () => {
  it("Origin 거절 3번(기록 1 · 미기록 2) 뒤 종료 → origin_rejected count=2 줄, IP 없음", async () => {
    for (let index = 0; index < 3; index += 1) {
      await loginPost(new Request(new URL("/api/auth/login", FAKE_ORIGIN), {
        method: "POST",
        headers: { origin: "https://evil.example.test", "content-type": "application/json", "x-real-ip": FAKE_IP, "user-agent": FAKE_USER_AGENT },
        body: JSON.stringify({ id: FAKE_ADMIN_ID, password: FAKE_PASSWORD }),
      }));
    }
    consoleLines.length = 0;
    logQueueOnShutdown();
    const countLines = consoleLines.filter((line) => line.includes("origin_rejected") && /\bcount=2\b/.test(line));
    expect(countLines).toHaveLength(1);
    for (const line of consoleLines) expect(line).not.toContain(FAKE_IP);
  });
});
