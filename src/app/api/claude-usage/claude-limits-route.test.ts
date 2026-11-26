/** POST /api/claude-usage/limits — 상한 · 켬/끔 바꾸기(명세 §2 "상한 · 켬/끔은 어드민 화면에서 바꾼다(바꾼 사람 · 시각을 기록)" · §14).
 * 실제 route · 실제 loginService(argon2 · 잠금 판정 — 재배포 접수의 비밀번호 재확인을 그대로 다시 쓴다) · 실제 설정 읽기 +
 * 가짜 fetch(실행 자리 — GET /limits · PUT /limits, 관측 서버 — 로그인 시도 · 잠금, 알림 서버).
 * 차례: 출처 → 세션 → 입력의 꼴 · 값 → 계정 이름 → 설정 → 지금 상한을 서버가 다시 읽기 → (올림이면) 비밀번호 → PUT 한 번.
 * 앞 단계가 거절하면 뒤 단계의 호출(실행 자리 읽기 · 관측 서버의 시도 기록 · 실행 자리 PUT)이 0 임을 가짜의 기록으로 본다. */
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
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import { NextRequest } from "next/server";

import { hash } from "@node-rs/argon2";
import { POST } from "@/app/api/claude-usage/limits/route";
import { GET as claudeUsageGet } from "@/app/api/claude-usage/route";
import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  CLAUDE_FORBIDDEN_IN_RESULTS, CLAUDE_SETTINGS_HEADER, FAKE_CLAUDE_RUNNER_SETTINGS_SECRET, FAKE_CLAUDE_RUNNER_URL, createFakeClaudeRunner,
  defaultRunnerLimits, useTwoPurposes, type FakeClaudeRunner,
} from "@/features/claude-usage/lib/claude-runner-test-fakes";
import { CLAUDE_LIMITS_BODY_MAX_BYTES } from "@/features/claude-usage/server/claude-limits-change";
import { bodyCutResponse, fetchFailureWithoutCause, undiciFetchFailure } from "@/features/deploy-redeploy/lib/redeploy-test-fakes";
import { middleware } from "@/middleware";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, expectNoForbiddenText,
  jsonBody, leakyErrorBody, leakyNetworkError, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const LOGIN_SERVICE_KEY = Symbol.for("study-note-admin.login-service");
/** 틀린 비밀번호 — 응답 · 로그 어디에도 나오면 안 되는 표시 글자. */
const WRONG_PASSWORD = "fake-wrong-password-marker-pw7";

let passwordHash = "";
let baseTime = Date.UTC(2026, 10, 26, 0, 0, 0);
let runner: FakeClaudeRunner;
type ObserveResponder = (body: Record<string, unknown>) => Response | Promise<Response>;
let respondAttempt: ObserveResponder;
const observeCalls: { path: string; body: Record<string, unknown> }[] = [];
/** 모든 바깥 호출의 차례(메서드 + 주소의 경로) */
const callOrder: string[] = [];
const consoleLines: string[] = [];

const verdict = (overrides: Record<string, unknown> = {}) =>
  jsonBody({ success: true, data: { allowed: true, outcome: "success", locked_until: null, lock_started: false, failures: 0, ...overrides } });
const normalObserve: ObserveResponder = (body) => (body.credential_ok ? verdict() : verdict({ allowed: false, outcome: "failure", failures: 1 }));

const attemptCalls = () => observeCalls.filter((call) => call.path === "/auth/attempts");
const limitReads = () => runner.calls("GET", "/limits");
const limitPuts = () => runner.calls("PUT", "/limits");

function expectNoDownstreamCalls() {
  expect(attemptCalls(), "관측 서버 시도 기록").toHaveLength(0);
  expect(runner.requests, "실행 자리 호출").toHaveLength(0);
}

function expectNoPasswordCheckAndNoPut() {
  expect(attemptCalls(), "관측 서버 시도 기록").toHaveLength(0);
  expect(limitPuts(), "실행 자리 PUT").toHaveLength(0);
}

/** 폼의 칸 — 기본은 지금 값(30 · 10 · 30 · 10 · 켬)과 같다(올림 아님) · 비밀번호 빈 칸. */
function fields(overrides: Record<string, string | string[] | null> = {}): Record<string, string | string[] | null> {
  return { enabled: "true", total_per_day: "30", total_per_hour: "10", purpose_chat_per_day: "30", purpose_chat_per_hour: "10", password: "", ...overrides };
}

interface LimitsRequestOptions {
  fields?: Record<string, string | string[] | null>;
  origin?: string | null;
  /** null 이면 Content-Type 머리글이 없다 */
  contentType?: string | null;
  rawBody?: string;
}

function limitsRequest(options: LimitsRequestOptions = {}): Request {
  const headers = new Headers({ "x-real-ip": "198.51.100.77", "user-agent": "FakeBrowser/1.0" });
  if (options.contentType !== null) headers.set("content-type", options.contentType ?? "application/x-www-form-urlencoded");
  if (options.origin !== null) headers.set("origin", options.origin ?? FAKE_ORIGIN);
  let body = options.rawBody;
  if (body === undefined) {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(options.fields ?? fields())) {
      if (value === null) continue;
      for (const each of Array.isArray(value) ? value : [value]) search.append(name, each);
    }
    body = search.toString();
  }
  return new Request(new URL("/api/claude-usage/limits", FAKE_ORIGIN), { method: "POST", headers, body: options.contentType === null ? new TextEncoder().encode(body) : body });
}

function validSession() {
  cookieJar.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
}

function expectHtml(response: Response) {
  expect(response.headers.get("content-type") ?? "").toContain("text/html");
  expect(response.headers.get("cache-control") ?? "").toContain("no-store");
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** 표의 줄 — 줄 머리(th scope=row)의 글 → 그 줄의 td 글들. */
function limitRows(html: string): Record<string, string[]> {
  const rows: Record<string, string[]> = {};
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const head = /<th[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/.exec(row);
    if (head === null) continue;
    rows[textOf(head[1]).trim()] = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => textOf(cell[1]).trim());
  }
  return rows;
}

beforeAll(async () => {
  passwordHash = await hash(FAKE_PASSWORD, { algorithm: 2 });
});

beforeEach(() => {
  baseTime += 3_600_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(baseTime);
  delete (globalThis as Record<symbol, unknown>)[LOGIN_SERVICE_KEY];
  cookieJar.clear();
  observeCalls.length = 0;
  callOrder.length = 0;
  consoleLines.length = 0;
  respondAttempt = normalObserve;
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_USER", FAKE_ADMIN_ID);
  vi.stubEnv("ADMIN_PASSWORD_HASH", passwordHash);
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("ALERT_URL", FAKE_ALERT_URL);
  vi.stubEnv("ALERT_SECRET", FAKE_ALERT_SECRET);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  vi.stubEnv("CLAUDE_RUNNER_URL", FAKE_CLAUDE_RUNNER_URL);
  vi.stubEnv("CLAUDE_RUNNER_SETTINGS_SECRET", FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
  runner = createFakeClaudeRunner();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    callOrder.push(`${(init.method ?? "GET").toUpperCase()} ${url.origin}${url.pathname}`);
    if (url.origin === new URL(FAKE_OBSERVE_URL).origin) {
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      observeCalls.push({ path: url.pathname, body });
      if (url.pathname === "/auth/attempts") return respondAttempt(body);
      return jsonBody({ success: true, data: {} });
    }
    if (url.origin === new URL(FAKE_ALERT_URL).origin) return jsonBody({ success: true, data: { sent: true } }, 202);
    if (url.origin === new URL(FAKE_CLAUDE_RUNNER_URL).origin) return runner.fetch(String(input), init);
    throw new Error(`unexpected upstream ${url.hostname}`);
  }));
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("1 출처 — 로그인 · 재배포 접수와 같은 검사(ADMIN_ORIGIN 과 글자까지 같은 Origin 만)", () => {
  it.each([
    ["Origin 없음", { origin: null }],
    ["다른 출처", { origin: "https://evil.example.test" }],
    ["null", { origin: "null" }],
    ["끝에 / 가 붙은 같은 출처", { origin: `${FAKE_ORIGIN}/` }],
  ] as const)("%s → 403 JSON origin_rejected · 실행 자리 · 관측 서버 호출 0", async (_label, options) => {
    validSession();
    const response = await POST(limitsRequest({ ...options, fields: fields({ total_per_day: "100", password: FAKE_PASSWORD }) }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: { code: "origin_rejected" } });
    expectNoDownstreamCalls();
  });
});

describe("2 세션 — 없음 · 위조 · 만료 → 401 JSON, 실행 자리 · 관측 서버 호출 0", () => {
  it.each([
    ["없음", (): string | undefined => undefined],
    ["위조(다른 키)", (): string | undefined => issueSessionToken("fake-other-signing-key-for-tests-0000000000", Date.now())],
    ["만료", (): string | undefined => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
  ] as [string, () => string | undefined][])("%s", async (_label, makeToken) => {
    const token = makeToken();
    if (token !== undefined) cookieJar.set(SESSION_COOKIE_NAME, token);
    const response = await POST(limitsRequest({ fields: fields({ total_per_day: "5" }) }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: { code: "unauthorized" } });
    expect(response.headers.get("set-cookie")).toBeNull();
    expectNoDownstreamCalls();
  });

  it("배포된 서버의 차례 — 세션이 없으면 middleware 가 먼저 401 · route 에 닿지 않는다", async () => {
    const request = limitsRequest();
    const gate = await middleware(new NextRequest(request.url, { method: "POST", headers: request.headers, body: await request.clone().text() }));
    expect(gate.headers.get("x-middleware-next")).not.toBe("1");
    expect(gate.status).toBe(401);
    expectNoDownstreamCalls();
  });
});

describe("3 입력의 꼴 · 값 — 거절하면 바꾸지 않는다", () => {
  // 본문 자체의 꼴(매체 종류 · 크기)은 실행 자리를 부르기 전에 거절한다
  const bodyMalformed: [string, () => LimitsRequestOptions][] = [
    ["JSON 본문", () => ({ contentType: "application/json", rawBody: JSON.stringify(fields()) })],
    ["Content-Type 접두만 같음", () => ({ contentType: "application/x-www-form-urlencodedevil" })],
    ["Content-Type 없음", () => ({ contentType: null })],
    ["본문 상한 넘음", () => ({ fields: { ...fields(), password: "p".repeat(CLAUDE_LIMITS_BODY_MAX_BYTES) } })],
  ];
  for (const [label, makeOptions] of bodyMalformed) {
    it(`${label} → 400 '요청의 꼴이 맞지 않습니다' · 실행 자리 · 관측 서버 0`, async () => {
      validSession();
      const response = await POST(limitsRequest(makeOptions()));
      expect(response.status).toBe(400);
      expectHtml(response);
      expect(await response.text()).toContain("요청의 꼴이 맞지 않습니다");
      expectNoDownstreamCalls();
    });
  }

  // 칸의 목록은 지금 상한의 용도에서 오므로, 칸의 꼴은 지금 상한을 한 번 읽은 뒤에 가른다 — 로그인 흐름 · PUT 0
  const fieldMalformed: [string, () => LimitsRequestOptions][] = [
    ["enabled 없음", () => ({ fields: fields({ enabled: null }) })],
    ["수의 칸 하나 없음", () => ({ fields: fields({ total_per_hour: null }) })],
    ["같은 칸이 둘", () => ({ fields: fields({ total_per_day: ["5", "6"] }) })],
    ["지금 상한에 없는 용도의 칸", () => ({ fields: { ...fields(), purpose_study_per_day: "5", purpose_study_per_hour: "1" } })],
    ["브라우저가 보낸 '지금 값'", () => ({ fields: { ...fields({ total_per_day: "100", password: FAKE_PASSWORD }), current_total_per_day: "1000" } })],
    ["바꾼 사람을 브라우저가 정함", () => ({ fields: { ...fields(), changed_by: "admin:someone-else" } })],
  ];
  for (const [label, makeOptions] of fieldMalformed) {
    it(`${label} → 400 '요청의 꼴이 맞지 않습니다' · 지금 상한 읽기 1 · 로그인 흐름 · PUT 0`, async () => {
      validSession();
      const response = await POST(limitsRequest(makeOptions()));
      expect(response.status).toBe(400);
      expectHtml(response);
      expect(await response.text()).toContain("요청의 꼴이 맞지 않습니다");
      expect(limitReads().length).toBeLessThanOrEqual(1);
      expectNoPasswordCheckAndNoPut();
    });
  }

  it.each([
    ["total_per_day", "1001"], ["total_per_hour", "-1"], ["purpose_chat_per_day", "2.5"], ["purpose_chat_per_hour", "열"],
  ])("%s=%j → 422 '상한 값이 맞지 않습니다'(0~1000 의 정수) · 그 칸의 이름", async (field, value) => {
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ [field]: value }) }));
    expect(response.status).toBe(422);
    expectHtml(response);
    const text = await response.text();
    expect(text).toContain("상한 값이 맞지 않습니다");
    expect(text).toContain("0~1000");
    expect(text).toContain(field);
    expectNoPasswordCheckAndNoPut();
  });

  it("charset 이 붙은 urlencoded 는 받는다", async () => {
    validSession();
    const response = await POST(limitsRequest({ contentType: "application/x-www-form-urlencoded; charset=UTF-8", fields: fields({ total_per_day: "5" }) }));
    expect(response.status).toBe(200);
    expect(limitPuts()).toHaveLength(1);
  });

  it("본문 상한은 4KB", () => {
    expect(CLAUDE_LIMITS_BODY_MAX_BYTES).toBe(4096);
  });
});

describe("4 계정 이름 — changed_by(admin:<계정>)로 쓸 수 없으면 실행 자리를 부르기 전에 거절", () => {
  it.each(["jun@example.com", "준형", "jun kim"])("ADMIN_USER %j → 422 · 실행 자리 · 관측 서버 0", async (account) => {
    vi.stubEnv("ADMIN_USER", account);
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ total_per_day: "5" }) }));
    expect(response.status).toBe(422);
    expectHtml(response);
    expect(await response.text()).toContain("이 계정 이름으로는 상한을 바꿀 수 없습니다");
    expectNoDownstreamCalls();
  });
});

describe("5 설정 — 실행 자리의 주소 · 설정용 비밀값이 없으면 503 · 부르지 않는다", () => {
  it.each([
    ["주소 없음", "CLAUDE_RUNNER_URL", ""],
    ["주소가 http(s) 가 아님", "CLAUDE_RUNNER_URL", "claude-runner.example.test:15200"],
    ["비밀값 없음", "CLAUDE_RUNNER_SETTINGS_SECRET", ""],
  ] as const)("%s", async (_label, name, value) => {
    vi.stubEnv(name, value);
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ total_per_day: "5" }) }));
    expect(response.status).toBe(503);
    expectHtml(response);
    const text = await response.text();
    expect(text).toContain("실행 자리 설정이 없습니다");
    expectNoForbiddenText(text, CLAUDE_FORBIDDEN_IN_RESULTS);
    expectNoDownstreamCalls();
  });
});

describe("6 내리거나 끄는 변경 — 비밀번호 재확인 없이(로그인 흐름 0) · 서버가 지금 값을 한 번 읽은 뒤 PUT 한 번", () => {
  it.each([
    ["모두 내림", fields({ total_per_day: "20", total_per_hour: "5", purpose_chat_per_day: "0", purpose_chat_per_hour: "0" })],
    ["끔", fields({ enabled: "false" })],
    ["같은 값(바꾼 사람 · 시각만 남는다)", fields()],
  ] as const)("%s → 200 · 관측 서버 0 · GET /limits 1 → PUT 1", async (_label, form) => {
    validSession();
    const response = await POST(limitsRequest({ fields: form }));
    expect(response.status).toBe(200);
    expectHtml(response);
    expect(attemptCalls()).toHaveLength(0);
    expect(limitReads()).toHaveLength(1);
    expect(limitPuts()).toHaveLength(1);
    const runnerOrder = callOrder.filter((entry) => entry.includes(FAKE_CLAUDE_RUNNER_URL));
    expect(runnerOrder).toEqual([`GET ${FAKE_CLAUDE_RUNNER_URL}/limits`, `PUT ${FAKE_CLAUDE_RUNNER_URL}/limits`]);
  });

  it("내림에 비밀번호를 (틀리게) 넣어도 보지 않는다 — 로그인 흐름 0 · 바뀐다", async () => {
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ total_per_day: "1", password: WRONG_PASSWORD }) }));
    expect(response.status).toBe(200);
    expect(attemptCalls()).toHaveLength(0);
    expect(limitPuts()).toHaveLength(1);
    expect(await response.text()).not.toContain(WRONG_PASSWORD);
  });

  it("PUT 의 본문 — 폼의 값(snake_case) · changed_by 는 서버가 정한 admin:<ADMIN_USER> · 비밀값은 머리글로만", async () => {
    validSession();
    await POST(limitsRequest({ fields: fields({ enabled: "false", total_per_day: "20", total_per_hour: "5", purpose_chat_per_day: "15", purpose_chat_per_hour: "4" }) }));
    const [put] = limitPuts();
    expect(put.body).toEqual({
      enabled: false, total: { per_day: 20, per_hour: 5 }, purposes: { chat: { per_day: 15, per_hour: 4 } }, changed_by: `admin:${FAKE_ADMIN_ID}`,
    });
    expect(put.headers.get(CLAUDE_SETTINGS_HEADER)).toBe(FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
    expect(limitReads()[0].headers.get(CLAUDE_SETTINGS_HEADER)).toBe(FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
  });
});

describe("7 올리거나 켜는 변경 — 비밀번호 재확인(재배포 접수와 같은 로그인 흐름)", () => {
  const raises: [string, Record<string, string | string[] | null>, () => void][] = [
    ["전체 하루를 올림", fields({ total_per_day: "31" }), () => undefined],
    ["채팅 한 시간을 올림", fields({ purpose_chat_per_hour: "11" }), () => undefined],
    ["하나를 올리고 나머지는 내림", fields({ total_per_day: "1", total_per_hour: "1", purpose_chat_per_day: "1", purpose_chat_per_hour: "11" }), () => undefined],
    ["꺼진 것을 켬(값은 그대로)", fields(), () => { runner.limits = defaultRunnerLimits({ enabled: false }); }],
  ];

  for (const [label, form, arrange] of raises) {
    it(`${label} · 비밀번호 없음 → 401 '비밀번호를 다시 넣어야 합니다' · 로그인 흐름 0 · PUT 0`, async () => {
      arrange();
      validSession();
      const response = await POST(limitsRequest({ fields: { ...form, password: null } }));
      expect(response.status).toBe(401);
      expectHtml(response);
      expect(await response.text()).toContain("비밀번호를 다시 넣어야 합니다");
      expectNoPasswordCheckAndNoPut();
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it(`${label} · 빈 비밀번호 → 401 · 로그인 흐름 0 · PUT 0`, async () => {
      arrange();
      validSession();
      const response = await POST(limitsRequest({ fields: { ...form, password: "" } }));
      expect(response.status).toBe(401);
      expectNoPasswordCheckAndNoPut();
    });

    it(`${label} · 틀린 비밀번호 → 401 '비밀번호가 맞지 않습니다' · 실패 시도 기록(credential_ok false) · PUT 0`, async () => {
      arrange();
      validSession();
      const response = await POST(limitsRequest({ fields: { ...form, password: WRONG_PASSWORD } }));
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).toContain("비밀번호가 맞지 않습니다");
      expect(text).not.toContain(WRONG_PASSWORD);
      expect(attemptCalls()).toHaveLength(1);
      expect(attemptCalls()[0].body.credential_ok).toBe(false);
      expect(limitPuts()).toHaveLength(0);
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it(`${label} · 맞는 비밀번호 → 200 · 성공 시도 기록 → PUT 한 번(그 차례)`, async () => {
      arrange();
      validSession();
      const response = await POST(limitsRequest({ fields: { ...form, password: FAKE_PASSWORD } }));
      expect(response.status).toBe(200);
      expect(attemptCalls()).toHaveLength(1);
      expect(attemptCalls()[0].body.credential_ok).toBe(true);
      expect(JSON.stringify(attemptCalls()[0].body)).not.toContain(FAKE_PASSWORD);
      expect(limitPuts()).toHaveLength(1);
      const readIndex = callOrder.indexOf(`GET ${FAKE_CLAUDE_RUNNER_URL}/limits`);
      const attemptIndex = callOrder.indexOf(`POST ${FAKE_OBSERVE_URL}/auth/attempts`);
      const putIndex = callOrder.indexOf(`PUT ${FAKE_CLAUDE_RUNNER_URL}/limits`);
      expect(readIndex).toBeGreaterThanOrEqual(0);
      expect(readIndex).toBeLessThan(attemptIndex);
      expect(attemptIndex).toBeLessThan(putIndex);
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  }

  it("잠겨 있으면 맞는 비밀번호도 423 '잠겨 있습니다' · PUT 0", async () => {
    respondAttempt = () => verdict({ allowed: false, outcome: "locked", locked_until: "2026-11-26T01:15:00.000Z", failures: 5 });
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ total_per_day: "100", password: FAKE_PASSWORD }) }));
    expect(response.status).toBe(423);
    expect(await response.text()).toContain("잠겨 있습니다");
    expect(limitPuts()).toHaveLength(0);
  });

  it("관측 서버에 닿지 않는 동안 틀린 비밀번호가 쌓이면 로그인처럼 잠근다(임시 제한 3회) — 그 뒤 맞는 비밀번호도 423 · PUT 0", async () => {
    respondAttempt = () => Promise.reject(leakyNetworkError());
    validSession();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) statuses.push((await POST(limitsRequest({ fields: fields({ total_per_day: "100", password: WRONG_PASSWORD }) }))).status);
    expect(statuses).toEqual([401, 401, 423]);
    expect((await POST(limitsRequest({ fields: fields({ total_per_day: "100", password: FAKE_PASSWORD }) }))).status).toBe(423);
    expect(limitPuts()).toHaveLength(0);
  });
});

describe("8 올림의 판정은 서버가 지금 상한을 다시 읽어서 — 브라우저 · 화면을 연 때의 값을 믿지 않는다", () => {
  it("화면을 연 뒤 다른 곳에서 5 로 내려 두었으면, 화면의 30 보다 낮은 20 도 올림 — 비밀번호 없이 401 · PUT 0", async () => {
    runner.limits = defaultRunnerLimits({ total: { per_day: 5, per_hour: 10 } });
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ total_per_day: "20" }) }));
    expect(response.status).toBe(401);
    expect(limitReads()).toHaveLength(1);
    expectNoPasswordCheckAndNoPut();
  });

  it("화면을 연 뒤 다른 곳에서 꺼 두었으면, 켬을 그대로 보내는 것도 켜기 — 비밀번호 없이 401 · PUT 0", async () => {
    runner.limits = defaultRunnerLimits({ enabled: false });
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ total_per_day: "1" }) }));
    expect(response.status).toBe(401);
    expectNoPasswordCheckAndNoPut();
  });

  const unreadable: [string, () => Response | Promise<Response>][] = [
    ["503 limits_unavailable", () => jsonBody({ success: false, error: { code: "limits_unavailable" } }, 503)],
    ["연결 실패", () => Promise.reject(leakyNetworkError())],
    ["꼴이 틀림", () => jsonBody({ success: true, data: { enabled: true } })],
    ["용도 이름이 꼴 밖", () => jsonBody({ success: true, data: defaultRunnerLimits({ purposes: { "Chat!": { per_day: 1, per_hour: 1 } } }) })],
    ["401(설정 비밀값 거절)", () => jsonBody({ success: false, error: { code: "unauthorized" } }, 401)],
  ];
  for (const [label, respond] of unreadable) {
    it(`지금 값을 읽지 못하면(${label}) 바꾸지 않는다 — 503 '지금 상한을 읽지 못해 바꿀 수 없습니다' · 맞는 비밀번호여도 · 로그인 흐름 · PUT 0`, async () => {
      runner.override["GET /limits"] = () => respond();
      validSession();
      for (const form of [fields({ total_per_day: "1", enabled: "false" }), fields({ total_per_day: "100", password: FAKE_PASSWORD })]) {
        const response = await POST(limitsRequest({ fields: form }));
        expect(response.status).toBe(503);
        expectHtml(response);
        const html = await response.text();
        expect(textOf(html)).toContain("지금 상한을 읽지 못해 바꿀 수 없습니다");
        expect(html).toContain('href="/claude-usage"');
        expectNoForbiddenText(html, CLAUDE_FORBIDDEN_IN_RESULTS);
      }
      expect(limitReads().length).toBeLessThanOrEqual(2);
      expectNoPasswordCheckAndNoPut();
    });
  }
});

describe("8b 용도의 목록은 지금 상한에서 — 용도 둘(chat · analysis)", () => {
  const twoFields = (overrides: Record<string, string | string[] | null> = {}) =>
    fields({ purpose_analysis_per_day: "6", purpose_analysis_per_hour: "2", ...overrides });

  it("analysis 의 한 시간만 내림 → 올림 아님 · 200 · PUT 본문의 purposes 에 두 용도 · 결과 표에 analysis 줄(이름 그대로)", async () => {
    useTwoPurposes(runner);
    validSession();
    const response = await POST(limitsRequest({ fields: twoFields({ purpose_analysis_per_hour: "1" }) }));
    expect(response.status).toBe(200);
    expect(attemptCalls()).toHaveLength(0);
    expect(limitPuts()[0].body).toMatchObject({ purposes: { chat: { per_day: 30, per_hour: 10 }, analysis: { per_day: 6, per_hour: 1 } } });
    expect(limitRows(await response.text())).toMatchObject({ "전체": ["30", "10"], "채팅 (chat)": ["30", "10"], "analysis": ["6", "1"] });
  });

  it("analysis 하나만 올려도 올림 — 비밀번호 없이 401 · PUT 0, 맞는 비밀번호면 PUT 한 번", async () => {
    useTwoPurposes(runner);
    validSession();
    const without = await POST(limitsRequest({ fields: twoFields({ purpose_analysis_per_day: "7" }) }));
    expect(without.status).toBe(401);
    expectNoPasswordCheckAndNoPut();
    const withPassword = await POST(limitsRequest({ fields: twoFields({ purpose_analysis_per_day: "7", password: FAKE_PASSWORD }) }));
    expect(withPassword.status).toBe(200);
    expect(limitPuts()).toHaveLength(1);
    expect(limitPuts()[0].body).toMatchObject({ purposes: { analysis: { per_day: 7, per_hour: 2 } } });
  });

  it("지금 상한의 용도(analysis)가 폼에 빠지면 400 — 일부만 바꾸지 않는다 · 로그인 흐름 · PUT 0", async () => {
    useTwoPurposes(runner);
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ total_per_day: "1" }) }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("요청의 꼴이 맞지 않습니다");
    expectNoPasswordCheckAndNoPut();
  });

  it("지금 상한에 없는 용도(analysis)의 칸이 오면 400 · PUT 0 — 화면을 연 뒤 실행 자리에서 용도가 빠진 경우", async () => {
    validSession();
    const response = await POST(limitsRequest({ fields: twoFields({ total_per_day: "1" }) }));
    expect(response.status).toBe(400);
    expectNoPasswordCheckAndNoPut();
  });

  it("chat 이 없는 실행 자리 — 그 용도의 칸만으로 바꾼다", async () => {
    runner.purposeNames = ["analysis"];
    runner.limits = defaultRunnerLimits({ purposes: { analysis: { per_day: 6, per_hour: 2 } } });
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ purpose_chat_per_day: null, purpose_chat_per_hour: null, purpose_analysis_per_day: "5", purpose_analysis_per_hour: "2" }) }));
    expect(response.status).toBe(200);
    expect(limitPuts()[0].body).toMatchObject({ purposes: { analysis: { per_day: 5, per_hour: 2 } } });
    expect(Object.keys((limitPuts()[0].body as { purposes: object }).purposes)).toEqual(["analysis"]);
  });
});

describe("9 실행 자리의 답 — 바뀜은 돌려받은 값을 보인다 · 거절은 그대로 · 모름은 '다시 읽어 확인'(다시 보내지 않는다)", () => {
  it("바뀜 → 200 '상한을 바꿨습니다' · 실행 자리가 돌려준 값(보낸 값이 아니라) · 바꾼 사람 · 시각 · 화면으로 돌아가는 링크", async () => {
    runner.override["PUT /limits"] = () => jsonBody({ success: true, data: defaultRunnerLimits({
      enabled: true, total: { per_day: 25, per_hour: 7 }, purposes: { chat: { per_day: 24, per_hour: 6 } },
      changed_at: "2026-11-26T13:12:00+09:00", changed_by: `admin:${FAKE_ADMIN_ID}`,
    }) });
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ total_per_day: "20", total_per_hour: "5", purpose_chat_per_day: "19", purpose_chat_per_hour: "3" }) }));
    expect(response.status).toBe(200);
    expectHtml(response);
    const html = await response.text();
    const text = textOf(html);
    expect(text).toContain("상한을 바꿨습니다");
    // 새 값의 표 — 열 머리(scope=col) 범위 · 하루 · 한 시간, 줄 머리(scope=row) 전체 · 채팅 (chat)
    expect([...html.matchAll(/<th[^>]*scope="col"[^>]*>([^<]*)<\/th>/g)].map((match) => match[1].trim())).toEqual(["범위", "하루", "한 시간"]);
    expect(limitRows(html)).toEqual({ "전체": ["25", "7"], "채팅 (chat)": ["24", "6"] });
    for (const sent of ["20", "19"]) expect(text, `보낸 값 ${sent} 을 보인다`).not.toMatch(new RegExp(`(^|[^0-9])${sent}([^0-9]|$)`));
    expect(text).toContain(`admin:${FAKE_ADMIN_ID}`);
    expect(text).toContain("13:12");
    expect(text).toContain("켜짐");
    expect(html).toContain('href="/claude-usage"');
    expect(html).not.toContain("<script");
    expectNoForbiddenText(html, CLAUDE_FORBIDDEN_IN_RESULTS);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  const rejected: [string, () => Response, number, string, string[]][] = [
    ["422 invalid_limits", () => jsonBody({ success: false, error: { code: "invalid_limits" } }, 422), 422, "실행 자리가 값을 거절했습니다 (invalid_limits)", []],
    ["422 invalid_changed_by", () => jsonBody({ success: false, error: { code: "invalid_changed_by" } }, 422), 422, "실행 자리가 값을 거절했습니다 (invalid_changed_by)", []],
    ["422 unknown_field(detail 없음)", () => jsonBody({ success: false, error: { code: "unknown_field", detail: "secret_field" } }, 422), 422, "실행 자리가 값을 거절했습니다 (unknown_field)", ["secret_field"]],
    ["422 모르는 code(원문 없음)", () => textResponse(leakyErrorBody(), 422), 422, "실행 자리가 값을 거절했습니다 (unexpected)", ["boom"]],
    ["401 설정 비밀값 거절", () => jsonBody({ success: false, error: { code: "unauthorized" } }, 401), 502, "실행 자리가 어드민의 설정 비밀값을 받지 않았습니다", []],
    ["302(따라가지 않는다 — 바뀌지 않았다)", () => new Response(null, { status: 302, headers: { Location: "http://elsewhere.example.test/" } }), 422, "실행 자리가 값을 거절했습니다 (unexpected)", ["elsewhere.example.test"]],
  ];
  for (const [label, respond, status, words, absent] of rejected) {
    it(`${label} → ${status} '${words}' · PUT 한 번 · 원문 없음`, async () => {
      runner.override["PUT /limits"] = respond;
      validSession();
      const response = await POST(limitsRequest({ fields: fields({ total_per_day: "5" }) }));
      expect(response.status).toBe(status);
      expectHtml(response);
      const html = await response.text();
      expect(textOf(html)).toContain(words);
      for (const word of absent) expect(html).not.toContain(word);
      expectNoForbiddenText(html, CLAUDE_FORBIDDEN_IN_RESULTS);
      expect(limitPuts()).toHaveLength(1);
    });
  }

  it("연결을 맺지 못함(ECONNREFUSED) → 502 '바뀌지 않았습니다' · PUT 한 번", async () => {
    runner.override["PUT /limits"] = () => Promise.reject(undiciFetchFailure("ECONNREFUSED"));
    validSession();
    const response = await POST(limitsRequest({ fields: fields({ total_per_day: "5" }) }));
    expect(response.status).toBe(502);
    expect(textOf(await response.text())).toContain("바뀌지 않았습니다");
    expect(limitPuts()).toHaveLength(1);
  });

  // 명세 §15: 5xx 는 code 가 무엇이든 모름 — 실행 자리는 값을 쓴 뒤에도 503 을 낼 수 있다
  const serverErrors: [number, () => Response][] = [
    [503, () => jsonBody({ success: false, error: { code: "limits_unavailable" } }, 503)],
    [500, () => textResponse(leakyErrorBody(), 500)],
    [502, () => textResponse(leakyErrorBody(), 502)],
    [504, () => textResponse(leakyErrorBody(), 504)],
  ];
  for (const [status, respond] of serverErrors) {
    it(`PUT 이 ${status} → 504 '바뀌었는지 모릅니다' · '바뀌지 않았습니다'라고 말하지 않는다 · PUT 한 번 · 로그 claude-limits:unknown status=${status}`, async () => {
      runner.override["PUT /limits"] = respond;
      validSession();
      const response = await POST(limitsRequest({ fields: fields({ total_per_day: "5" }) }));
      expect(response.status).toBe(504);
      const html = await response.text();
      expect(textOf(html)).toContain("바뀌었는지 모릅니다 — 다시 읽어 확인하세요");
      expect(textOf(html)).not.toContain("바뀌지 않았습니다");
      expectNoForbiddenText(html, CLAUDE_FORBIDDEN_IN_RESULTS);
      expect(limitPuts()).toHaveLength(1);
      const lines = consoleLines.filter((line) => line.includes(":claude-limits:"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`:claude-limits:unknown status=${status}\\b`));
    });
  }

  const writtenThenFailed: [string, Record<string, string | string[] | null>, { per_day: number; per_hour: number }, boolean][] = [
    ["내림", fields({ total_per_day: "5", total_per_hour: "3" }), { per_day: 5, per_hour: 3 }, false],
    ["올림(맞는 비밀번호)", fields({ total_per_day: "50", total_per_hour: "20", password: FAKE_PASSWORD }), { per_day: 50, per_hour: 20 }, true],
  ];
  for (const [label, form, expectedTotal, raise] of writtenThenFailed) {
    it(`실행 자리가 값을 쓴 뒤 503 을 낸다 — ${label} → 504 모름(바뀌지 않았다고 말하지 않는다) · PUT 한 번 · 다시 읽으면 바뀐 값`, async () => {
      runner.failAfterWrite = 503;
      validSession();
      const response = await POST(limitsRequest({ fields: form }));
      expect(response.status).toBe(504);
      const text = textOf(await response.text());
      expect(text).toContain("바뀌었는지 모릅니다 — 다시 읽어 확인하세요");
      expect(text).not.toContain("바뀌지 않았습니다");
      expect(text).not.toContain("상한을 바꿨습니다");
      expect(limitPuts()).toHaveLength(1);
      expect(attemptCalls()).toHaveLength(raise ? 1 : 0);
      expect(runner.limits.total).toEqual(expectedTotal);   // 실제 실행 자리처럼 값은 바뀌어 있다
      expect(consoleLines.filter((line) => line.includes(":claude-limits:"))[0]).toMatch(new RegExp(`:claude-limits:unknown status=503\\b.*raise=${raise}`));
      // 화면을 다시 읽으면(GET /api/claude-usage — 실행 자리를 새로 읽는다) 바뀐 값이 보인다
      runner.failAfterWrite = null;
      const screen = await (await claudeUsageGet(new Request(new URL("/api/claude-usage", FAKE_ORIGIN)))).json() as { data: { limits: { ok: boolean; value: { total: unknown } } } };
      expect(screen.data.limits).toMatchObject({ ok: true, value: { total: { perDay: expectedTotal.per_day, perHour: expectedTotal.per_hour } } });
    });
  }

  const unknowns: [string, () => Response | Promise<Response>][] = [
    ["시간 초과", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    ["보낸 뒤 끊김(UND_ERR_SOCKET)", () => Promise.reject(undiciFetchFailure("UND_ERR_SOCKET"))],
    ["cause 없는 실패", () => Promise.reject(fetchFailureWithoutCause())],
    ["200 인데 본문을 읽다 끊김", () => bodyCutResponse(200)],
  ];
  for (const [label, respond] of unknowns) {
    it(`${label} → 504 '바뀌었는지 모릅니다 — 다시 읽어 확인하세요' · 화면 링크 · PUT 한 번(다시 보내지 않는다) · '바뀌지 않았습니다'라고 단정하지 않는다`, async () => {
      runner.override["PUT /limits"] = () => respond();
      validSession();
      const response = await POST(limitsRequest({ fields: fields({ total_per_day: "5" }) }));
      expect(response.status).toBe(504);
      expectHtml(response);
      const html = await response.text();
      expect(textOf(html)).toContain("바뀌었는지 모릅니다 — 다시 읽어 확인하세요");
      expect(html).toContain('href="/claude-usage"');
      expect(textOf(html)).not.toContain("바뀌지 않았습니다");
      expect(textOf(html)).not.toContain("상한을 바꿨습니다");
      expect(html).not.toMatch(/<form/i);
      expectNoForbiddenText(html, CLAUDE_FORBIDDEN_IN_RESULTS);
      expect(limitPuts()).toHaveLength(1);
      expect(runner.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    });
  }
});

describe("10 로그 — 한 번에 한 줄(결과 · 계정 · 올림 여부), 비밀번호 · 비밀값 · 실행 자리의 주소는 어디에도 없다", () => {
  it("바뀜(내림) · 재확인 없는 올림 · 틀린 비밀번호 · 맞는 비밀번호의 올림", async () => {
    validSession();
    await POST(limitsRequest({ fields: fields({ total_per_day: "5" }) }));
    const needPassword = await POST(limitsRequest({ fields: fields({ total_per_day: "100" }) }));
    const wrong = await POST(limitsRequest({ fields: fields({ total_per_day: "100", password: WRONG_PASSWORD }) }));
    await POST(limitsRequest({ fields: fields({ total_per_day: "100", password: FAKE_PASSWORD }) }));
    const lines = consoleLines.filter((line) => line.includes(":claude-limits:"))   // 로그 한 줄 = `<요청ID>:admin:claude-limits:<결과> …`;
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.includes(`account=${FAKE_ADMIN_ID}`))).toBe(true);
    expect(lines[0]).toMatch(/claude-limits:replaced\b.*raise=false/);
    expect(lines[1]).toMatch(/claude-limits:password_required\b.*raise=true/);
    expect(lines[2]).toMatch(/claude-limits:password_failure\b.*raise=true/);
    expect(lines[3]).toMatch(/claude-limits:replaced\b.*raise=true/);
    const everything = consoleLines.join("\n") + await needPassword.text() + await wrong.text();
    for (const secret of [FAKE_PASSWORD, WRONG_PASSWORD, FAKE_CLAUDE_RUNNER_SETTINGS_SECRET, FAKE_SIGNING_KEY, passwordHash, "claude-runner.example.test"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("모름(시간 초과)도 한 줄 — claude-limits:unknown", async () => {
    runner.override["PUT /limits"] = () => Promise.reject(new DOMException("timeout", "TimeoutError"));
    validSession();
    await POST(limitsRequest({ fields: fields({ total_per_day: "5" }) }));
    const lines = consoleLines.filter((line) => line.includes(":claude-limits:"))   // 로그 한 줄 = `<요청ID>:admin:claude-limits:<결과> …`;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/claude-limits:unknown\b/);
  });
});
