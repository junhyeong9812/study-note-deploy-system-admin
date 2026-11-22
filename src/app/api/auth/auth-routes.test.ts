/** login · logout Route Handler 의 배선 — 실제 loginService(실제 argon2 · 속도 제한 · 임시 제한 · 대기열) + 가짜 fetch(관측·알림).
 * 환경 변수는 stubEnv, 프로세스 단일 인스턴스는 사례마다 새로 만든다. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    has: (name: string) => cookieJar.has(name),
    getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers(),
}));

import { hash } from "@node-rs/argon2";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, issueSessionToken, verifySessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_IP, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_SIGNING_KEY, FAKE_USER_AGENT } from "@/features/auth/lib/test-fakes";

const OBSERVE_URL = "http://observe.example.test:17000";
const ALERT_URL = "http://alert.example.test:16000";
const LOGIN_SERVICE_KEY = Symbol.for("study-note-admin.login-service");   // login-service.ts 의 프로세스 단일 인스턴스 자리

let passwordHash = "";
let expensiveHash = "";

type ObserveResponder = (body: Record<string, unknown>) => Response | Promise<Response>;
let respondAttempt: ObserveResponder;
const observeCalls: { path: string; body: Record<string, unknown> }[] = [];
const consoleLines: string[] = [];

const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data }), { status, headers: { "Content-Type": "application/json" } });
const verdictData = (overrides: Record<string, unknown> = {}) =>
  ({ allowed: true, outcome: "success", locked_until: null, lock_started: false, failures: 0, ...overrides });
const normalObserve: ObserveResponder = (body) => envelope(body.credential_ok
  ? verdictData()
  : verdictData({ allowed: false, outcome: "failure", failures: 1 }));

function loginRequest(options: { body?: unknown; rawBody?: string; origin?: string | null; ip?: string; contentType?: string; userAgent?: string } = {}): Request {
  const headers = new Headers({ "content-type": options.contentType ?? "application/json", "user-agent": options.userAgent ?? FAKE_USER_AGENT });
  if (options.origin !== null) headers.set("origin", options.origin ?? FAKE_ORIGIN);
  headers.set("x-real-ip", options.ip ?? FAKE_IP);
  return new Request(new URL("/api/auth/login", FAKE_ORIGIN), {
    method: "POST", headers,
    body: options.rawBody ?? JSON.stringify(options.body ?? { id: FAKE_ADMIN_ID, password: FAKE_PASSWORD }),
  });
}

function logoutRequest(origin: string | null = FAKE_ORIGIN): Request {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  return new Request(new URL("/api/auth/logout", FAKE_ORIGIN), { method: "POST", headers });
}

function cookieParts(header: string | null) {
  const [pair, ...rest] = (header ?? "").split(";").map((part) => part.trim());
  const separator = pair.indexOf("=");
  return { name: pair.slice(0, separator), value: pair.slice(separator + 1), attributes: rest.map((part) => part.toLowerCase()) };
}

const attemptCalls = () => observeCalls.filter((call) => call.path === "/auth/attempts");
const rejectedCalls = () => observeCalls.filter((call) => call.path === "/auth/attempts/rejected");

beforeAll(async () => {
  passwordHash = await hash(FAKE_PASSWORD, { algorithm: 2 });   // 2 = Argon2id, 기본 비용 m=19456,t=2,p=1(더미와 같음)
  expensiveHash = await hash(FAKE_PASSWORD, { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 });
});

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[LOGIN_SERVICE_KEY];
  cookieJar.clear();
  observeCalls.length = 0;
  consoleLines.length = 0;
  respondAttempt = normalObserve;
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_USER", FAKE_ADMIN_ID);
  vi.stubEnv("ADMIN_PASSWORD_HASH", passwordHash);
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", "fake-observe-secret");
  vi.stubEnv("ALERT_URL", ALERT_URL);
  vi.stubEnv("ALERT_SECRET", "fake-alert-secret");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.origin === new URL(OBSERVE_URL).origin) {
      observeCalls.push({ path: url.pathname, body });
      if (url.pathname === "/auth/attempts") return respondAttempt(body);
      return envelope({});
    }
    if (url.origin === new URL(ALERT_URL).origin) return envelope({ sent: true }, 202);
    throw new TypeError(`unexpected fetch ${url.origin}`);
  }));
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/auth/login — 성공", () => {
  it("200 · Set-Cookie(HttpOnly · Secure · SameSite=Strict · Path=/ · 12시간) · 검증되는 세션 · no-store", async () => {
    const response = await loginPost(loginRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const cookie = cookieParts(response.headers.get("set-cookie"));
    expect(cookie.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie.attributes).toEqual(expect.arrayContaining(["httponly", "secure", "samesite=strict", "path=/", `max-age=${SESSION_LIFETIME_MILLISECONDS / 1000}`]));
    expect(verifySessionToken(cookie.value, FAKE_SIGNING_KEY, Date.now())).not.toBeNull();
    const body = await response.json();
    expect(body).toEqual({ success: true, data: { temporaryRestriction: false } });
  });

  it("관측 서버에 보낸 시도 — IP 는 X-Real-IP, ID·비밀번호 없음", async () => {
    await loginPost(loginRequest());
    expect(attemptCalls()).toHaveLength(1);
    const sent = attemptCalls()[0].body;
    expect(sent).toMatchObject({ credential_ok: true, ip: FAKE_IP, user_agent: FAKE_USER_AGENT, replayed: false });
    expect(JSON.stringify(sent)).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(sent)).not.toContain(FAKE_ADMIN_ID);
  });
});

describe("POST /api/auth/login — 실패 · 잠금 · 속도 제한", () => {
  it("ID 틀림과 비밀번호 틀림은 같은 상태 · 같은 본문, 쿠키 없음", async () => {
    const wrongId = await loginPost(loginRequest({ body: { id: "fake-other-id", password: FAKE_PASSWORD } }));
    const wrongPassword = await loginPost(loginRequest({ body: { id: FAKE_ADMIN_ID, password: "fake-wrong" } }));
    expect(wrongId.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(await wrongId.text()).toBe(await wrongPassword.text());
    expect(wrongId.headers.get("set-cookie")).toBeNull();
    expect(wrongPassword.headers.get("set-cookie")).toBeNull();
  });

  it("관측 서버가 잠금 중이라고 하면 맞는 자격도 423, 실패와 다른 문구, 쿠키 없음", async () => {
    const failure = await (await loginPost(loginRequest({ body: { id: FAKE_ADMIN_ID, password: "fake-wrong" } }))).json();
    respondAttempt = () => envelope(verdictData({ allowed: false, outcome: "locked", locked_until: "2026-01-01T00:15:00.000Z", failures: 5 }));
    const response = await loginPost(loginRequest());
    expect(response.status).toBe(423);
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).not.toBe(failure.error.code);
  });

  it("잠금을 건 그 시도(outcome:failure + lock_started:true) → 423(세부 2)", async () => {
    respondAttempt = () => envelope(verdictData({ allowed: false, outcome: "failure", locked_until: "2026-01-01T00:15:00.000Z", lock_started: true, failures: 5 }));
    const response = await loginPost(loginRequest({ body: { id: FAKE_ADMIN_ID, password: "fake-wrong" } }));
    expect(response.status).toBe(423);
  });

  it("같은 IP 11번째 → 429(맞는 자격이어도), 쿠키 없음", async () => {
    for (let index = 0; index < 10; index += 1) await loginPost(loginRequest({ body: { id: FAKE_ADMIN_ID, password: "fake-wrong" } }));
    const attemptsBefore = attemptCalls().length;
    const response = await loginPost(loginRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(attemptCalls().length).toBe(attemptsBefore);
  });
});

describe("POST /api/auth/login — Origin · 형식 오류(세부 2 순서: Origin → 속도 제한 → 본문 해석)", () => {
  it.each([
    ["없음", null], ["다른 서브도메인", "https://evil.example.test"], ["http", "http://admin.example.test"], ["뒤에 경로", `${FAKE_ORIGIN}/`],
  ])("Origin %s → 403, 자격 검증·시도 기록 없음, 쿠키 없음", async (_label, origin) => {
    const response = await loginPost(loginRequest({ origin }));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(attemptCalls()).toHaveLength(0);
  });

  it("Origin 거절도 rejected(reason origin_rejected)로 기록 — IP 마다 60초 창 1건", async () => {
    for (let index = 0; index < 3; index += 1) await loginPost(loginRequest({ origin: "https://evil.example.test" }));
    expect(rejectedCalls().map((call) => call.body.reason)).toEqual(["origin_rejected"]);
    expect(rejectedCalls()[0].body.ip).toBe(FAKE_IP);
  });

  it.each([
    ["JSON 아님", { rawBody: "id=x&password=y" }],
    ["content-type 이 JSON 아님", { contentType: "text/plain" }],
    ["password 없음", { body: { id: FAKE_ADMIN_ID } }],
    ["id 가 숫자", { body: { id: 7, password: FAKE_PASSWORD } }],
    ["배열", { body: [FAKE_ADMIN_ID, FAKE_PASSWORD] }],
    ["id 가 상한 초과", { body: { id: "x".repeat(10_000), password: FAKE_PASSWORD } }],
    ["본문이 상한 초과", { body: { id: FAKE_ADMIN_ID, password: FAKE_PASSWORD, padding: "p".repeat(10_000) } }],
  ])("형식 오류(%s) → 400, 자격 검증·시도 기록 없음", async (_label, options) => {
    const response = await loginPost(loginRequest(options));
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(attemptCalls()).toHaveLength(0);
  });

  it("형식 오류도 rejected(reason malformed)로 기록 — 창당 1건", async () => {
    for (let index = 0; index < 3; index += 1) await loginPost(loginRequest({ rawBody: "not json" }));
    expect(rejectedCalls().map((call) => call.body.reason)).toEqual(["malformed"]);
  });

  it("출처가 틀린 형식 오류는 403(본문을 보기 전에 거절)", async () => {
    const response = await loginPost(loginRequest({ origin: "https://evil.example.test", rawBody: "not json" }));
    expect(response.status).toBe(403);
  });

  it("형식 오류도 속도 제한에 센다 — 10회 뒤 11번째 형식 오류는 429, 맞는 자격도 429", async () => {
    for (let index = 0; index < 10; index += 1) expect((await loginPost(loginRequest({ rawBody: "not json" }))).status).toBe(400);
    expect((await loginPost(loginRequest({ rawBody: "not json" }))).status).toBe(429);
    expect((await loginPost(loginRequest())).status).toBe(429);
  });

  it("Origin 거절은 속도 제한을 쓰지 않는다 — 15회 뒤에도 같은 IP 의 정상 로그인 200", async () => {
    for (let index = 0; index < 15; index += 1) await loginPost(loginRequest({ origin: "https://evil.example.test" }));
    expect((await loginPost(loginRequest())).status).toBe(200);
  });
});

describe("POST /api/auth/login — 관측 서버 장애(임시 제한 표시)", () => {
  it("관측 서버에 닿지 않으면 맞는 자격은 200 + temporaryRestriction:true", async () => {
    respondAttempt = () => { throw new TypeError("fetch failed: ECONNREFUSED"); };
    const response = await loginPost(loginRequest());
    expect(response.status).toBe(200);
    expect((await response.json()).data.temporaryRestriction).toBe(true);
  });

  it("틀린 자격은 401 + 본문에 temporaryRestriction:true", async () => {
    respondAttempt = () => new Response("bad gateway", { status: 502 });
    const response = await loginPost(loginRequest({ body: { id: FAKE_ADMIN_ID, password: "fake-wrong" } }));
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).toContain("\"temporaryRestriction\":true");
  });

  it("임시 제한 3회 실패 → 423(잠금 중 맞는 자격도)", async () => {
    respondAttempt = () => { throw new TypeError("fetch failed"); };
    for (let index = 0; index < 2; index += 1) await loginPost(loginRequest({ body: { id: FAKE_ADMIN_ID, password: "fake-wrong" } }));
    expect((await loginPost(loginRequest({ body: { id: FAKE_ADMIN_ID, password: "fake-wrong" } }))).status).toBe(423);
    expect((await loginPost(loginRequest())).status).toBe(423);
  });
});

describe("POST /api/auth/login — 실행 중 방어: 설정이 없는 상태에 닿으면 401 거절만(기록 없음 — 세부 3)", () => {
  it.each([
    ["ADMIN_USER 빔", "ADMIN_USER", ""],
    ["ADMIN_PASSWORD_HASH 빔", "ADMIN_PASSWORD_HASH", ""],
    ["SESSION_SECRET 빔", "SESSION_SECRET", ""],
    ["ADMIN_ORIGIN 빔", "ADMIN_ORIGIN", ""],
    ["OBSERVE_URL 빔", "OBSERVE_URL", ""],
    ["OBSERVE_SECRET 빔", "OBSERVE_SECRET", ""],
  ])("%s → 맞는 자격도 401, 쿠키 없음, 관측 서버 호출 없음", async (_label, name, value) => {
    vi.stubEnv(name, value);
    const response = await loginPost(loginRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(observeCalls).toHaveLength(0);
  });

  it("ADMIN_USER 가 비면 응답이 '비밀번호 틀림'과 같다(설정 상태가 드러나지 않는다)", async () => {
    const wrongPassword = await loginPost(loginRequest({ body: { id: FAKE_ADMIN_ID, password: "fake-wrong" } }));
    delete (globalThis as Record<symbol, unknown>)[LOGIN_SERVICE_KEY];
    vi.stubEnv("ADMIN_USER", "");
    const configMissing = await loginPost(loginRequest({ ip: "198.51.100.150" }));
    expect(configMissing.status).toBe(wrongPassword.status);
    expect(await configMissing.text()).toBe(await wrongPassword.text());
  });

  it("세부 2: 해시 비용(m·t·p)이 더미와 다르면 맞는 비밀번호도 거절", async () => {
    vi.stubEnv("ADMIN_PASSWORD_HASH", expensiveHash);
    const response = await loginPost(loginRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(observeCalls).toHaveLength(0);   // 세부 3: 기록 없음
  });
});

describe("POST /api/auth/logout", () => {
  it("같은 출처 + 유효한 세션 → 200, 같은 이름·경로로 쿠키 삭제", async () => {
    cookieJar.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
    const response = await logoutPost(logoutRequest());
    expect(response.status).toBe(200);
    const cookie = cookieParts(response.headers.get("set-cookie"));
    expect(cookie.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie.value).toBe("");
    expect(cookie.attributes).toEqual(expect.arrayContaining(["path=/", "max-age=0", "httponly", "secure", "samesite=strict"]));
  });

  it.each([["없음", null], ["다른 출처", "https://evil.example.test"]])("Origin %s → 403, 쿠키를 건드리지 않는다", async (_label, origin) => {
    cookieJar.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, Date.now()));
    const response = await logoutPost(logoutRequest(origin));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    ["세션 없음", undefined],
    ["잘못된 서명", issueSessionToken("fake-other-signing-key-for-tests-0000000000", Date.now())],
    ["만료", issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
  ])("%s → 401", async (_label, token) => {
    if (token !== undefined) cookieJar.set(SESSION_COOKIE_NAME, token);
    const response = await logoutPost(logoutRequest());
    expect(response.status).toBe(401);
  });
});

describe("앱 로그(콘솔)에 IP · ID · 비밀번호 · UA 없음 — Route Handler 경로", () => {
  it("성공 · 실패 · Origin 거절 · 형식 오류 · 장애 · 속도 제한을 거친 뒤 콘솔 출력 검사", async () => {
    const typedId = "fake-typed-id-route-marker";
    const typedPassword = "fake-typed-password-route-marker";
    await loginPost(loginRequest());
    await loginPost(loginRequest({ body: { id: typedId, password: typedPassword } }));
    await loginPost(loginRequest({ origin: "https://evil.example.test", body: { id: typedId, password: typedPassword } }));
    await loginPost(loginRequest({ rawBody: `{"id":"${typedId}","password":` }));
    respondAttempt = () => { throw new TypeError("fetch failed"); };
    for (let index = 0; index < 12; index += 1) await loginPost(loginRequest({ body: { id: typedId, password: typedPassword } }));
    for (const line of consoleLines) {
      for (const forbidden of [FAKE_IP, typedId, typedPassword, FAKE_ADMIN_ID, FAKE_PASSWORD, FAKE_USER_AGENT, passwordHash, FAKE_SIGNING_KEY]) {
        expect(line, `logged: ${line}`).not.toContain(forbidden);
      }
    }
  });
});

describe("세부 3 — 본문 읽기: Origin 검사 · 속도 제한을 본문을 읽기 전에, 읽으면서 상한·기한", () => {
  /** 마이크로·매크로태스크만 돌려 본다(실제 대기 없음) — 그 안에 끝나지 않으면 본문을 기다리는 것. */
  async function settlesWithinMacrotasks(promise: Promise<unknown>, rounds = 50): Promise<boolean> {
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    for (let round = 0; round < rounds && !settled; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    return settled;
  }
  function stalledBody() {
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return new Promise<void>(() => undefined);
        sent = true;
        controller.enqueue(new TextEncoder().encode("{\"id\":\""));
        return undefined;
      },
    }, { highWaterMark: 0 });
  }
  function endlessBody() {
    const state = { pulledBytes: 0 };
    const stream = new ReadableStream<Uint8Array>({
      // 64KB 에서 닫는다 — 다 읽는 구현이 테스트를 멈추게 하지 않고(빨강으로 끝나게) 하기 위한 안전 상한
      pull(controller) {
        if (state.pulledBytes >= 65_536) { controller.close(); return; }
        state.pulledBytes += 1024;
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
    }, { highWaterMark: 0 });
    return { stream, state };
  }
  function streamLoginRequest(stream: ReadableStream<Uint8Array>, origin: string = FAKE_ORIGIN): Request {
    return new Request(new URL("/api/auth/login", FAKE_ORIGIN), {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-real-ip": FAKE_IP, "user-agent": FAKE_USER_AGENT },
      body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
  }

  it("틀린 Origin + 끝나지 않는 본문 → 본문을 기다리지 않고 403", async () => {
    const pending = loginPost(streamLoginRequest(stalledBody(), "https://evil.example.test"));
    expect(await settlesWithinMacrotasks(pending)).toBe(true);
    expect((await pending).status).toBe(403);
  });

  it("속도 제한 초과 + 끝나지 않는 본문 → 본문을 기다리지 않고 429", async () => {
    for (let index = 0; index < 10; index += 1) await loginPost(loginRequest({ body: { id: FAKE_ADMIN_ID, password: "fake-wrong" } }));
    const pending = loginPost(streamLoginRequest(stalledBody()));
    expect(await settlesWithinMacrotasks(pending)).toBe(true);
    expect((await pending).status).toBe(429);
  });

  it("4KB 를 넘는 끝없는 본문 → 다 읽지 않고 400, 기록 reason malformed", async () => {
    const { stream, state } = endlessBody();
    const pending = loginPost(streamLoginRequest(stream));
    expect(await settlesWithinMacrotasks(pending, 200)).toBe(true);
    expect((await pending).status).toBe(400);
    expect(state.pulledBytes).toBeLessThanOrEqual(4096 + 2048);
    expect(rejectedCalls().map((call) => call.body.reason)).toEqual(["malformed"]);
  });

  it("3초 안에 끝나지 않는 본문 → 400, 기록 reason malformed (가짜 타이머로 3초를 앞당긴다)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = loginPost(streamLoginRequest(stalledBody()));
      await vi.advanceTimersByTimeAsync(2_999);
      expect(await settlesWithinMacrotasks(pending, 5)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await settlesWithinMacrotasks(pending)).toBe(true);
      expect((await pending).status).toBe(400);
      expect(rejectedCalls().map((call) => call.body.reason)).toEqual(["malformed"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
