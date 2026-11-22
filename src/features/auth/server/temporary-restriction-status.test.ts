/** 세부 4 — 서버 쪽 임시 제한 상태: 실제 loginService(가짜 fetch)로 장애 → 복귀를 거쳐 본다. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hash } from "@node-rs/argon2";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { loginService } from "@/features/auth/server/login-service";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { FAKE_ADMIN_ID, FAKE_IP, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_SIGNING_KEY, FAKE_USER_AGENT } from "@/features/auth/lib/test-fakes";

const LOGIN_SERVICE_KEY = Symbol.for("study-note-admin.login-service");
let passwordHash = "";
let observeDown = true;

function loginRequest(password: string): Request {
  return new Request(new URL("/api/auth/login", FAKE_ORIGIN), {
    method: "POST",
    headers: { origin: FAKE_ORIGIN, "content-type": "application/json", "x-real-ip": FAKE_IP, "user-agent": FAKE_USER_AGENT },
    body: JSON.stringify({ id: FAKE_ADMIN_ID, password }),
  });
}

beforeAll(async () => {
  passwordHash = await hash(FAKE_PASSWORD, { algorithm: 2 });
});

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[LOGIN_SERVICE_KEY];
  observeDown = true;
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_USER", FAKE_ADMIN_ID);
  vi.stubEnv("ADMIN_PASSWORD_HASH", passwordHash);
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", "http://observe.example.test:17000");
  vi.stubEnv("OBSERVE_SECRET", "fake-observe-secret");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (observeDown) throw new TypeError("fetch failed: ECONNREFUSED");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const data = String(input).endsWith("/auth/attempts")
      ? { allowed: body.credential_ok === true, outcome: body.credential_ok ? "success" : "failure", locked_until: null, lock_started: false, failures: 0 }
      : {};
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isTemporaryRestrictionActive", () => {
  it("로그인 서비스가 아직 없으면 false", () => {
    expect(isTemporaryRestrictionActive()).toBe(false);
  });

  it("관측 서버에 닿지 않은 로그인 뒤 true, 복귀해 대기열이 비면 false", async () => {
    await loginPost(loginRequest("fake-wrong"));
    expect(isTemporaryRestrictionActive()).toBe(true);
    observeDown = false;
    await loginPost(loginRequest(FAKE_PASSWORD));
    await loginService().flow?.waitForReplay();
    expect(isTemporaryRestrictionActive()).toBe(false);
  });
});
