/** POST /api/deploys/redeploy — 재배포 접수(명세 ② 전부 · §10). 실제 route · 실제 loginService(argon2 · 잠금 판정) · 실제 설정 읽기 +
 * 가짜 fetch(master — 이력 · git · 접수, 관측 서버 — 로그인 시도 · 잠금, 알림 서버).
 * 순서: 출처 → 세션 → 속도 제한 → 입력의 꼴 → 계정 이름 → 확인 값 → 비밀번호(로그인과 같은 잠금 판정) → 이력 재확인 → master 접수 한 번.
 * 앞 단계가 거절하면 뒤 단계의 호출(관측 서버의 시도 기록 · master 이력 · master 접수)이 0 임을 가짜의 기록으로 본다.
 * 시계는 Date 만 가짜(사례마다 1시간씩 앞으로 — 속도 제한의 창이 사례 사이에 이어지지 않는다). */
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
import { POST } from "@/app/api/deploys/redeploy/route";
import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { issueRedeployConfirmation, newRedeployRequestId } from "@/features/deploy-redeploy/lib/redeploy-confirmation";
import {
  bodyCutResponse, branchFrom, fetchFailureWithoutCause, installCommitGraph, undiciFetchFailure, type GraphCommit,
} from "@/features/deploy-redeploy/lib/redeploy-test-fakes";
import { REDEPLOY_BODY_MAX_BYTES, REDEPLOY_RATE_LIMIT_PER_MINUTE } from "@/features/deploy-redeploy/server/redeploy-accept";
import {
  MASTER_DEPLOYS_PATH, MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH, createFakeMaster, deploymentJson, minutesAfterStart, type FakeMaster,
} from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import { middleware } from "@/middleware";
import type { RoutedFetchHandler } from "@/shared/lib/upstream-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, expectNoForbiddenText, headersOf,
  jsonBody, leakyErrorBody, leakyNetworkError, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const LOGIN_SERVICE_KEY = Symbol.for("study-note-admin.login-service");
const ACCEPT_PATH = "/deploy";
/** 틀린 비밀번호 — 응답 · 로그 · 주소 어디에도 나오면 안 되는 표시 글자. */
const WRONG_PASSWORD = "fake-wrong-password-marker-pw7";

let passwordHash = "";
let baseTime = Date.UTC(2026, 10, 25, 0, 0, 0);
let main: GraphCommit[];
let master: FakeMaster;
let acceptBehavior: RoutedFetchHandler;
type ObserveResponder = (body: Record<string, unknown>) => Response | Promise<Response>;
let respondAttempt: ObserveResponder;
const observeCalls: { path: string; body: Record<string, unknown> }[] = [];
/** 모든 바깥 호출의 순서(주소의 경로) */
const callOrder: string[] = [];
const consoleLines: string[] = [];

const verdict = (overrides: Record<string, unknown> = {}) =>
  jsonBody({ success: true, data: { allowed: true, outcome: "success", locked_until: null, lock_started: false, failures: 0, ...overrides } });
const normalObserve: ObserveResponder = (body) => (body.credential_ok ? verdict() : verdict({ allowed: false, outcome: "failure", failures: 1 }));

const attemptCalls = () => observeCalls.filter((call) => call.path === "/auth/attempts");
const historyCalls = () => master.requestedUrls().filter((url) => url.pathname === MASTER_DEPLOYS_PATH);
const acceptCalls = () => master.fetch.mock.calls.filter(([input]) => new URL(input).pathname === ACCEPT_PATH);
const acceptBodies = () => acceptCalls().map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

function expectNoDownstreamCalls() {
  expect(attemptCalls(), "관측 서버 시도 기록").toHaveLength(0);
  expect(historyCalls(), "master 이력").toHaveLength(0);
  expect(acceptCalls(), "master 접수").toHaveLength(0);
}

function confirmationFor(commitSha: string, options: { requestId?: string; issuedAt?: number; account?: string; service?: string } = {}): string {
  return issueRedeployConfirmation(FAKE_SIGNING_KEY, {
    service: options.service ?? "backend", commitSha, requestId: options.requestId ?? newRedeployRequestId(),
    issuedAt: options.issuedAt ?? Date.now(), account: options.account ?? FAKE_ADMIN_ID,
  });
}

interface AcceptRequestOptions {
  fields?: Record<string, string | string[]>;
  origin?: string | null;
  referer?: string;
  /** null 이면 Content-Type 머리글이 없다(본문을 바이트로 실어 Request 가 text/plain 을 붙이지 않게) */
  contentType?: string | null;
  rawBody?: string;
}

function acceptRequest(options: AcceptRequestOptions = {}): Request {
  const headers = new Headers({ "x-real-ip": "198.51.100.77", "user-agent": "FakeBrowser/1.0" });
  if (options.contentType !== null) headers.set("content-type", options.contentType ?? "application/x-www-form-urlencoded");
  if (options.origin !== null) headers.set("origin", options.origin ?? FAKE_ORIGIN);
  if (options.referer !== undefined) headers.set("referer", options.referer);
  let body = options.rawBody;
  if (body === undefined) {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(options.fields ?? defaultFields())) for (const each of Array.isArray(value) ? value : [value]) search.append(name, each);
    body = search.toString();
  }
  return new Request(new URL("/api/deploys/redeploy", FAKE_ORIGIN), { method: "POST", headers, body: options.contentType === null ? new TextEncoder().encode(body) : body });
}

function defaultFields(overrides: Record<string, string> = {}): Record<string, string> {
  return { service: "backend", commit: main[1].sha, confirmation: confirmationFor(main[1].sha), password: FAKE_PASSWORD, ...overrides };
}

function validSession() {
  cookieJar.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
}

function expectHtml(response: Response) {
  expect(response.headers.get("content-type") ?? "").toContain("text/html");
  expect(response.headers.get("cache-control") ?? "").toContain("no-store");
}

/** 303 의 이동 주소 — 상대 경로이거나 ADMIN_ORIGIN 기준 절대 주소. */
function locationPath(response: Response): string {
  const location = response.headers.get("location") ?? "";
  return location.startsWith(FAKE_ORIGIN) ? location.slice(FAKE_ORIGIN.length) : location;
}

function progressPath(requestId: string): string {
  return `/deploys?service=backend&selected=${encodeURIComponent(requestId)}&selectedService=backend`;
}

function requestIdOf(confirmation: string): string {
  return confirmation.split(".")[1];
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
  main = branchFrom(null, ["첫 커밋", "로그인 고침", "표에 칸 더함", "목록 정렬", "배포 스크립트"]);
  master = createFakeMaster([
    deploymentJson("backend", main[4].sha, "succeeded", minutesAfterStart(40)),
    deploymentJson("backend", main[3].sha, "succeeded", minutesAfterStart(30)),
    deploymentJson("backend", main[1].sha, "succeeded", minutesAfterStart(20)),
    deploymentJson("backend", main[0].sha, "succeeded", minutesAfterStart(10)),
  ]);
  installCommitGraph(master, main);
  acceptBehavior = (_url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return jsonBody({ success: true, data: { request_id: body.request_id, service: body.service, state: "accepted" } }, 202);
  };
  (master.override as Record<string, RoutedFetchHandler>)[ACCEPT_PATH] = (url, init) => acceptBehavior(url, init);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    callOrder.push(`${url.origin}${url.pathname}`);
    if (url.origin === new URL(FAKE_OBSERVE_URL).origin) {
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      observeCalls.push({ path: url.pathname, body });
      if (url.pathname === "/auth/attempts") return respondAttempt(body);
      return jsonBody({ success: true, data: {} });
    }
    if (url.origin === new URL(FAKE_ALERT_URL).origin) return jsonBody({ success: true, data: { sent: true } }, 202);
    return master.fetch(String(input), init);
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

describe("1 출처 — 로그인 · 로그아웃과 같은 검사(ADMIN_ORIGIN 과 글자까지 같은 Origin 만, Referer 로 갈음하지 않는다)", () => {
  it.each([
    ["Origin 없음", { origin: null }],
    ["다른 출처", { origin: "https://evil.example.test" }],
    ["null", { origin: "null" }],
    ["끝에 / 가 붙은 같은 출처", { origin: `${FAKE_ORIGIN}/` }],
    ["Origin 없이 같은 출처의 Referer", { origin: null, referer: `${FAKE_ORIGIN}/deploys/redeploy` }],
  ] as const)("%s → 403, 뒤 단계 호출 0", async (_label, options) => {
    validSession();
    const response = await POST(acceptRequest(options));
    expect(response.status).toBe(403);
    expectNoDownstreamCalls();
  });

  it("route 단위(middleware 를 거치지 않고 route 를 바로 부를 때) — 출처가 세션보다 먼저: 세션도 없고 출처도 틀리면 403", async () => {
    expect((await POST(acceptRequest({ origin: "https://evil.example.test" }))).status).toBe(403);
  });
});

describe("2 세션 — 없음 · 위조 · 만료 → 401, 뒤 단계 호출 0", () => {
  it.each([
    ["없음", (): string | undefined => undefined],
    ["위조(다른 키)", (): string | undefined => issueSessionToken("fake-other-signing-key-for-tests-0000000000", Date.now())],
    ["만료", (): string | undefined => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
  ] as [string, () => string | undefined][])("%s", async (_label, makeToken) => {
    const token = makeToken();
    if (token !== undefined) cookieJar.set(SESSION_COOKIE_NAME, token);
    const response = await POST(acceptRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expectNoDownstreamCalls();
  });
});

describe("3 속도 제한 — 계정당 60초에 5번", () => {
  it(`${REDEPLOY_RATE_LIMIT_PER_MINUTE}번 뒤의 요청은 429(비밀번호 확인 · master 0) — 60초가 지나면 다시 받는다`, async () => {
    expect(REDEPLOY_RATE_LIMIT_PER_MINUTE).toBe(5);
    validSession();
    for (let attempt = 0; attempt < REDEPLOY_RATE_LIMIT_PER_MINUTE; attempt += 1) {
      const response = await POST(acceptRequest({ fields: defaultFields({ confirmation: "rc1.broken" }) }));
      expect(response.status, `시도 ${attempt + 1}`).toBe(400);
    }
    const limited = await POST(acceptRequest());
    expect(limited.status).toBe(429);
    expectHtml(limited);
    expect(await limited.text()).toContain("잠시 뒤 다시");
    expectNoDownstreamCalls();
    vi.setSystemTime(Date.now() + 60_001);
    const fields = defaultFields();
    const later = await POST(acceptRequest({ fields }));
    expect(later.status).toBe(303);
    expect(acceptCalls()).toHaveLength(1);
  });
});

describe("4 입력의 꼴 — 400, 비밀번호 확인 · master 0", () => {
  const cases: [string, () => AcceptRequestOptions][] = [
    ["비밀번호 없음", () => ({ fields: (({ password: _password, ...rest }) => rest)(defaultFields()) })],
    ["빈 비밀번호", () => ({ fields: defaultFields({ password: "" }) })],
    ["확인 값 없음", () => ({ fields: (({ confirmation: _confirmation, ...rest }) => rest)(defaultFields()) })],
    ["서비스가 허용 목록 밖", () => ({ fields: defaultFields({ service: "nope" }) })],
    ["커밋이 짧음", () => ({ fields: defaultFields({ commit: main[1].sha.slice(0, 7) }) })],
    ["커밋이 대문자", () => ({ fields: defaultFields({ commit: main[1].sha.toUpperCase() }) })],
    ["같은 이름이 두 번", () => ({ fields: { ...defaultFields(), service: ["backend", "front"] } })],
    ["비밀번호가 1024자 넘음", () => ({ fields: defaultFields({ password: "p".repeat(1025) }) })],
    ["JSON 본문", () => ({ contentType: "application/json", rawBody: JSON.stringify(defaultFields()) })],
    ["본문 상한 넘음", () => ({ fields: { ...defaultFields(), padding: "x".repeat(REDEPLOY_BODY_MAX_BYTES) } })],
  ];
  for (const [label, makeOptions] of cases) {
    it(label, async () => {
      validSession();
      const response = await POST(acceptRequest(makeOptions()));
      expect(response.status).toBe(400);
      expectHtml(response);
      expect(await response.text()).toContain("요청의 꼴이 맞지 않습니다");
      expectNoDownstreamCalls();
    });
  }

  it("본문 상한은 4KB", () => {
    expect(REDEPLOY_BODY_MAX_BYTES).toBe(4096);
  });
});

describe("5 계정 이름 — requested_by 로 쓸 수 없으면 master 를 부르기 전에 거절", () => {
  it.each(["jun@example.com", "준형", "jun kim"])("ADMIN_USER %j → 422 · 알아들을 글 · 비밀번호 확인 · master 0", async (account) => {
    vi.stubEnv("ADMIN_USER", account);
    validSession();
    const response = await POST(acceptRequest({ fields: defaultFields({ confirmation: confirmationFor(main[1].sha, { account }) }) }));
    expect(response.status).toBe(422);
    expectHtml(response);
    expect(await response.text()).toContain("이 계정 이름으로는 배포를 일으킬 수 없습니다");
    expectNoDownstreamCalls();
  });
});

describe("6 확인 값 — 틀리면 비밀번호를 확인하지 않는다(잠금 횟수가 늘지 않는다)", () => {
  const cases: [string, number, string, () => string][] = [
    ["다른 커밋의 확인 값", 400, "확인 값이 맞지 않습니다", () => confirmationFor(main[3].sha)],
    ["다른 서비스의 확인 값", 400, "확인 값이 맞지 않습니다", () => confirmationFor(main[1].sha, { service: "front" })],
    ["다른 계정의 확인 값", 400, "확인 값이 맞지 않습니다", () => confirmationFor(main[1].sha, { account: "fake-other-admin" })],
    ["세션 토큰을 확인 값 자리에", 400, "확인 값이 맞지 않습니다", () => issueSessionToken(FAKE_SIGNING_KEY, Date.now())],
    ["5분 지난 값", 410, "확인 화면을 다시 열어 주세요", () => confirmationFor(main[1].sha, { issuedAt: Date.now() - 300_000 })],
  ];
  for (const [label, status, words, makeConfirmation] of cases) {
    it(`${label} → ${status}`, async () => {
      validSession();
      const response = await POST(acceptRequest({ fields: defaultFields({ confirmation: makeConfirmation() }) }));
      expect(response.status).toBe(status);
      expectHtml(response);
      expect(await response.text()).toContain(words);
      expectNoDownstreamCalls();
    });
  }

  it("4분 59초 된 값은 통한다", async () => {
    validSession();
    const response = await POST(acceptRequest({ fields: defaultFields({ confirmation: confirmationFor(main[1].sha, { issuedAt: Date.now() - 299_000 }) }) }));
    expect(response.status).toBe(303);
  });
});

describe("7 비밀번호 — 로그인과 같은 확인 · 같은 잠금 판정", () => {
  it("틀리면 401 '비밀번호가 맞지 않습니다' · 실패 시도가 관측 서버에 기록된다(credential_ok false) · 이력 · master 0", async () => {
    validSession();
    const response = await POST(acceptRequest({ fields: defaultFields({ password: WRONG_PASSWORD }) }));
    expect(response.status).toBe(401);
    expectHtml(response);
    const text = await response.text();
    expect(text).toContain("비밀번호가 맞지 않습니다");
    expect(attemptCalls()).toHaveLength(1);
    expect(attemptCalls()[0].body.credential_ok).toBe(false);
    expect(historyCalls()).toHaveLength(0);
    expect(acceptCalls()).toHaveLength(0);
    expect(text).not.toContain(WRONG_PASSWORD);
  });

  it("잠겨 있으면 맞는 비밀번호도 423 '잠겨 있습니다' · master 0", async () => {
    respondAttempt = () => verdict({ allowed: false, outcome: "locked", locked_until: "2026-11-25T01:15:00.000Z", failures: 5 });
    validSession();
    const response = await POST(acceptRequest());
    expect(response.status).toBe(423);
    expect(await response.text()).toContain("잠겨 있습니다");
    expect(attemptCalls()[0].body.credential_ok).toBe(true);
    expect(acceptCalls()).toHaveLength(0);
  });

  it("이 시도로 잠금이 걸리면(lock_started) 423 · master 0", async () => {
    respondAttempt = () => verdict({ allowed: false, outcome: "failure", locked_until: "2026-11-25T01:15:00.000Z", lock_started: true, failures: 5 });
    validSession();
    const response = await POST(acceptRequest({ fields: defaultFields({ password: WRONG_PASSWORD }) }));
    expect(response.status).toBe(423);
    expect(acceptCalls()).toHaveLength(0);
  });

  it("맞으면 성공 시도가 기록된다(credential_ok true) — 그 뒤에 이력 · 접수", async () => {
    validSession();
    const response = await POST(acceptRequest());
    expect(response.status).toBe(303);
    expect(attemptCalls()).toHaveLength(1);
    expect(attemptCalls()[0].body.credential_ok).toBe(true);
    expect(JSON.stringify(attemptCalls()[0].body)).not.toContain(FAKE_PASSWORD);
    const attemptIndex = callOrder.indexOf(`${FAKE_OBSERVE_URL}/auth/attempts`);
    const historyIndex = callOrder.indexOf(`${FAKE_DEPLOY_MASTER_URL}${MASTER_DEPLOYS_PATH}`);
    const acceptIndex = callOrder.indexOf(`${FAKE_DEPLOY_MASTER_URL}${ACCEPT_PATH}`);
    expect(attemptIndex).toBeGreaterThanOrEqual(0);
    expect(attemptIndex).toBeLessThan(historyIndex);
    expect(historyIndex).toBeLessThan(acceptIndex);
  });

  it("관측 서버에 닿지 않으면 로그인처럼 임시 제한으로 판정한다 — 맞는 비밀번호는 통한다", async () => {
    respondAttempt = () => Promise.reject(leakyNetworkError());
    validSession();
    const response = await POST(acceptRequest());
    expect(response.status).toBe(303);
    expect(acceptCalls()).toHaveLength(1);
  });

  it("관측 서버에 닿지 않는 동안 틀린 비밀번호가 쌓이면 로그인처럼 잠근다(임시 제한 3회) — 그 뒤 맞는 비밀번호도 423", async () => {
    respondAttempt = () => Promise.reject(leakyNetworkError());
    validSession();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) statuses.push((await POST(acceptRequest({ fields: defaultFields({ password: WRONG_PASSWORD }) }))).status);
    expect(statuses).toEqual([401, 401, 423]);
    expect((await POST(acceptRequest())).status).toBe(423);
    expect(acceptCalls()).toHaveLength(0);
  });
});

describe("8 이력 재확인 — 그 서비스의 성공 이력에 없는 커밋은 접수하지 않는다", () => {
  it.each([
    ["배포된 적 없는 커밋", () => main[2].sha],
    ["실패만 한 커밋", () => {
      master.deployments.unshift(deploymentJson("backend", main[2].sha, "failed", minutesAfterStart(45)));
      return main[2].sha;
    }],
    ["다른 서비스에서만 성공한 커밋", () => {
      master.deployments.unshift(deploymentJson("front", main[2].sha, "succeeded", minutesAfterStart(45)));
      return main[2].sha;
    }],
  ] as const)("%s → 409 '배포된 적 없는 버전은 고를 수 없습니다' · master 접수 0", async (_label, choose) => {
    validSession();
    const commit = choose();
    const response = await POST(acceptRequest({ fields: defaultFields({ commit, confirmation: confirmationFor(commit) }) }));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("배포된 적 없는 버전은 고를 수 없습니다");
    expect(historyCalls().length).toBeGreaterThanOrEqual(1);
    expect(acceptCalls()).toHaveLength(0);
  });

  it("이력을 읽지 못하면 502 '배포 이력을 확인하지 못해 접수하지 않았습니다' · master 접수 0", async () => {
    master.override[MASTER_DEPLOYS_PATH] = () => textResponse(leakyErrorBody(), 503);
    validSession();
    const response = await POST(acceptRequest());
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("배포 이력을 확인하지 못해 접수하지 않았습니다");
    expectNoForbiddenText(text);
    expect(acceptCalls()).toHaveLength(0);
  });

  it("지금 버전과 같은 커밋도 접수한다(같은 버전을 다시 올리기)", async () => {
    validSession();
    const response = await POST(acceptRequest({ fields: defaultFields({ commit: main[4].sha, confirmation: confirmationFor(main[4].sha) }) }));
    expect(response.status).toBe(303);
    expect(acceptBodies()[0].commit_sha).toBe(main[4].sha);
  });
});

describe("9 master 접수 — 한 번 · requested_by · 결과를 가른다", () => {
  it("접수됨 → 303 진행 화면(배포 상세 — 그 요청 ID) · 본문 네 칸 · 비밀값은 머리글로만 · 주소에 확인 값 · 비밀번호 없음", async () => {
    validSession();
    const fields = defaultFields();
    const response = await POST(acceptRequest({ fields }));
    expect(response.status).toBe(303);
    const requestId = requestIdOf(fields.confirmation);
    expect(locationPath(response)).toBe(progressPath(requestId));
    expect(acceptCalls()).toHaveLength(1);
    expect(acceptBodies()[0]).toEqual({ service: "backend", commit_sha: main[1].sha, request_id: requestId, requested_by: `admin:${FAKE_ADMIN_ID}` });
    const [acceptUrl, acceptInit] = acceptCalls()[0];
    expect(acceptInit?.method).toBe("POST");
    expect(headersOf(acceptInit).get("x-deploy-secret")).toBe(FAKE_DEPLOY_SECRET);
    expect(acceptUrl).not.toContain(FAKE_DEPLOY_SECRET);
    const location = response.headers.get("location") ?? "";
    for (const secret of [fields.confirmation, FAKE_PASSWORD, FAKE_DEPLOY_SECRET, FAKE_SIGNING_KEY]) expect(location).not.toContain(secret);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("같은 폼을 두 번 내면(새로 고침 · 두 번 누름) 같은 요청 ID 가 가고 master 의 duplicate 도 같은 진행 화면", async () => {
    validSession();
    const fields = defaultFields();
    const first = await POST(acceptRequest({ fields }));
    acceptBehavior = (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonBody({ success: true, data: { request_id: body.request_id, service: body.service, state: "ci_running", duplicate: true } }, 202);
    };
    const second = await POST(acceptRequest({ fields }));
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(locationPath(second)).toBe(locationPath(first));
    expect(acceptBodies().map((body) => body.request_id)).toEqual([requestIdOf(fields.confirmation), requestIdOf(fields.confirmation)]);
  });

  const outcomes: [string, RoutedFetchHandler, number, string, string[]][] = [
    ["409 deploy_in_progress", () => textResponse(JSON.stringify({ success: false, error: { code: "deploy_in_progress", detail: "backend" } }), 409),
      409, "그 서비스의 배포가 진행 중입니다", []],
    ["409 request_id_conflict", () => textResponse(JSON.stringify({ success: false, error: { code: "request_id_conflict" } }), 409),
      409, "확인 화면을 다시 열어 주세요", []],
    ["422 invalid_requested_by", () => textResponse(JSON.stringify({ success: false, error: { code: "invalid_requested_by" } }), 422),
      502, "배포 서버가 이 접수를 받지 않았습니다", ["invalid_requested_by"]],
    ["401(접수 비밀값 거절)", () => textResponse(JSON.stringify({ success: false, error: { code: "unauthorized" } }), 401),
      502, "배포 서버가 이 접수를 받지 않았습니다", []],
    ["503", () => textResponse(leakyErrorBody(), 503), 502, "접수하지 못함", []],
    ["연결 거부(ECONNREFUSED)", () => Promise.reject(undiciFetchFailure("ECONNREFUSED")), 502, "접수하지 못함", []],
  ];
  for (const [label, behavior, status, words, absent] of outcomes) {
    it(`${label} → ${status} '${words}' · 원시 코드 · 원문 없음 · master 1회`, async () => {
      acceptBehavior = behavior;
      validSession();
      const response = await POST(acceptRequest());
      expect(response.status).toBe(status);
      expectHtml(response);
      const text = await response.text();
      expect(text).toContain(words);
      for (const word of absent) expect(text).not.toContain(word);
      expectNoForbiddenText(text);
      expect(acceptCalls()).toHaveLength(1);
    });
  }

  it("접수 여부 모름(시간 초과) → 504 '접수됐는지 확인하지 못했습니다' + 같은 확인 값으로 다시 내는 폼(새 요청 ID 없음) + 배포 이력 링크", async () => {
    acceptBehavior = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    validSession();
    const fields = defaultFields();
    const response = await POST(acceptRequest({ fields }));
    expect(response.status).toBe(504);
    expectHtml(response);
    const text = await response.text();
    expect(text).toContain("접수됐는지 확인하지 못했습니다");
    expect(text).toMatch(/<form[^>]*method="post"[^>]*action="\/api\/deploys\/redeploy"|<form[^>]*action="\/api\/deploys\/redeploy"[^>]*method="post"/i);
    expect(text).toMatch(new RegExp(`<input[^>]*name="confirmation"[^>]*value="${fields.confirmation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    expect(text).toMatch(new RegExp(`<input[^>]*name="commit"[^>]*value="${main[1].sha}"`));
    expect(text).toMatch(/<input[^>]*type="password"/);
    expect(text).toContain('href="/deploys?service=backend"');
    expect(text).not.toContain(FAKE_PASSWORD);
    expect(acceptCalls()).toHaveLength(1);
    // 그 폼으로 다시 내면 같은 요청 ID 가 간다
    acceptBehavior = (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonBody({ success: true, data: { request_id: body.request_id, service: body.service, state: "ci_running", duplicate: true } }, 202);
    };
    const retried = await POST(acceptRequest({ fields }));
    expect(retried.status).toBe(303);
    expect(acceptBodies().map((body) => body.request_id)).toEqual([requestIdOf(fields.confirmation), requestIdOf(fields.confirmation)]);
  });
});

describe("세션 쿠키를 새로 놓지 않는다 — 비밀번호 확인이 로그인 흐름을 지나도", () => {
  const scenarios: [string, () => void, () => Record<string, string>][] = [
    ["접수됨(303)", () => undefined, () => defaultFields()],
    ["비밀번호 틀림(401)", () => undefined, () => defaultFields({ password: WRONG_PASSWORD })],
    ["잠김(423)", () => { respondAttempt = () => verdict({ allowed: false, outcome: "locked", locked_until: "2026-11-25T01:15:00.000Z", failures: 5 }); }, () => defaultFields()],
    ["관측 서버에 닿지 않음 + 맞는 비밀번호(303)", () => { respondAttempt = () => Promise.reject(leakyNetworkError()); }, () => defaultFields()],
    ["이력에 없음(409)", () => undefined, () => defaultFields({ commit: main[2].sha, confirmation: confirmationFor(main[2].sha) })],
    ["접수 여부 모름(504)", () => { acceptBehavior = () => Promise.reject(new DOMException("timeout", "TimeoutError")); }, () => defaultFields()],
    ["진행 중(409)", () => { acceptBehavior = () => textResponse(JSON.stringify({ success: false, error: { code: "deploy_in_progress" } }), 409); }, () => defaultFields()],
  ];
  for (const [label, arrange, makeFields] of scenarios) {
    it(`${label} → Set-Cookie 없음`, async () => {
      arrange();
      validSession();
      const response = await POST(acceptRequest({ fields: makeFields() }));
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  }
});

describe("10 로그 — 접수 한 건에 한 줄(누가 · 서비스 · 커밋 · 결과), 비밀번호 · 확인 값 · 비밀값은 어디에도 없다", () => {
  it("접수됨 · 비밀번호 틀림 · 확인 값 틀림", async () => {
    validSession();
    const accepted = defaultFields();
    await POST(acceptRequest({ fields: accepted }));
    const wrongPassword = defaultFields({ password: WRONG_PASSWORD });
    const wrongPasswordResponse = await POST(acceptRequest({ fields: wrongPassword }));
    const wrongConfirmation = defaultFields({ confirmation: confirmationFor(main[3].sha) });
    await POST(acceptRequest({ fields: wrongConfirmation }));
    const redeployLines = consoleLines.filter((line) => line.includes("redeploy"));
    expect(redeployLines.some((line) => line.includes("accepted") && line.includes("backend") && line.includes(main[1].sha.slice(0, 7)) && line.includes(FAKE_ADMIN_ID))).toBe(true);
    expect(redeployLines.some((line) => line.includes("password"))).toBe(true);
    expect(redeployLines.some((line) => line.includes("confirmation"))).toBe(true);
    const everything = consoleLines.join("\n") + await wrongPasswordResponse.text();
    for (const secret of [FAKE_PASSWORD, WRONG_PASSWORD, accepted.confirmation, wrongPassword.confirmation, wrongConfirmation.confirmation, FAKE_DEPLOY_SECRET, FAKE_SIGNING_KEY, passwordHash]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe("접수 여부의 갈래 — '모름'이면 504 와 같은 확인 값의 다시 보내기 폼, '접수되지 않음'이면 폼이 없다", () => {
  const unknownCases: [string, RoutedFetchHandler][] = [
    ["보낸 뒤 소켓이 끊김(UND_ERR_SOCKET)", () => Promise.reject(undiciFetchFailure("UND_ERR_SOCKET"))],
    ["ECONNRESET", () => Promise.reject(undiciFetchFailure("ECONNRESET"))],
    ["cause 가 없는 TypeError", () => Promise.reject(fetchFailureWithoutCause())],
    ["응답은 왔는데 본문을 읽다 끊김", () => bodyCutResponse(202)],
  ];
  for (const [label, behavior] of unknownCases) {
    it(`${label} → 504 · 같은 확인 값의 다시 보내기 폼 · '접수되지 않았습니다'라고 단정하지 않는다 · 원문 없음`, async () => {
      acceptBehavior = behavior;
      validSession();
      const fields = defaultFields();
      const response = await POST(acceptRequest({ fields }));
      expect(response.status).toBe(504);
      expectHtml(response);
      const text = await response.text();
      expect(text).toContain("접수됐는지 확인하지 못했습니다");
      expect(text).not.toContain("접수되지 않았습니다");
      expect(text).toMatch(/<form[^>]*action="\/api\/deploys\/redeploy"/);
      const confirmationValues = [...text.matchAll(/<input[^>]*name="confirmation"[^>]*value="([^"]*)"/g)].map((match) => match[1]);
      expect(confirmationValues).toEqual([fields.confirmation]);
      expectNoForbiddenText(text);
      expect(acceptCalls()).toHaveLength(1);
    });
  }

  const notAcceptedCases: [string, RoutedFetchHandler][] = [
    ["ECONNREFUSED", () => Promise.reject(undiciFetchFailure("ECONNREFUSED"))],
    ["ENOTFOUND", () => Promise.reject(undiciFetchFailure("ENOTFOUND"))],
    ["연결 기한(UND_ERR_CONNECT_TIMEOUT)", () => Promise.reject(undiciFetchFailure("UND_ERR_CONNECT_TIMEOUT"))],
    ["503 답", () => textResponse(leakyErrorBody(), 503)],
  ];
  for (const [label, behavior] of notAcceptedCases) {
    it(`${label} → 502 '접수하지 못함' · 다시 보내기 폼 없음`, async () => {
      acceptBehavior = behavior;
      validSession();
      const response = await POST(acceptRequest());
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain("접수하지 못함");
      expect(text).not.toMatch(/<form/i);
      expect(text).not.toContain('name="confirmation"');
      expectNoForbiddenText(text);
      expect(acceptCalls()).toHaveLength(1);
    });
  }
});

describe("이력 재확인은 배포 이력만 읽는다 — git 조회를 하지 않는다", () => {
  it("접수 한 번에 이력 조회 한 번(service · limit 200) · git 조회(커밋 범위 · 커밋 하나) 0", async () => {
    validSession();
    const response = await POST(acceptRequest());
    expect(response.status).toBe(303);
    expect(historyCalls()).toHaveLength(1);
    expect(historyCalls()[0].searchParams.get("service")).toBe("backend");
    expect(historyCalls()[0].searchParams.get("limit")).toBe("200");
    expect(master.gitRequests()).toEqual([]);
    expect(callOrder.filter((path) => path.endsWith(MASTER_GIT_COMMITS_PATH) || path.endsWith(MASTER_GIT_COMMIT_PATH))).toEqual([]);
    expect(acceptCalls()).toHaveLength(1);
  });

  it("git 중계가 실패해도(503 · 연결 거부) 접수된다", async () => {
    master.override[MASTER_GIT_COMMITS_PATH] = () => textResponse(leakyErrorBody(), 503);
    master.override[MASTER_GIT_COMMIT_PATH] = () => Promise.reject(undiciFetchFailure("ECONNREFUSED"));
    validSession();
    const fields = defaultFields();
    const response = await POST(acceptRequest({ fields }));
    expect(response.status).toBe(303);
    expect(locationPath(response)).toBe(progressPath(requestIdOf(fields.confirmation)));
    expect(acceptCalls()).toHaveLength(1);
  });

  it("성공 이력에 없는 커밋은 여전히 409 · git 조회 0 · master 접수 0", async () => {
    validSession();
    const response = await POST(acceptRequest({ fields: defaultFields({ commit: main[2].sha, confirmation: confirmationFor(main[2].sha) }) }));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("배포된 적 없는 버전은 고를 수 없습니다");
    expect(master.gitRequests()).toEqual([]);
    expect(acceptCalls()).toHaveLength(0);
  });

  it.each([
    ["503", (): Response | Promise<Response> => textResponse(leakyErrorBody(), 503)],
    ["연결 거부", (): Response | Promise<Response> => Promise.reject(undiciFetchFailure("ECONNREFUSED"))],
  ] as const)("이력 조회가 실패하면(%s) 접수하지 않는다 — 502 · git 조회 0 · master 접수 0", async (_label, respond) => {
    master.override[MASTER_DEPLOYS_PATH] = () => respond();
    validSession();
    const response = await POST(acceptRequest());
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("배포 이력을 확인하지 못해 접수하지 않았습니다");
    expectNoForbiddenText(text);
    expect(master.gitRequests()).toEqual([]);
    expect(acceptCalls()).toHaveLength(0);
  });
});

describe("배포 서버가 돌려준 요청 번호 — 꼴(^[A-Za-z0-9_-]{1,64}$)이 맞을 때만 로그 · 주소에 쓴다", () => {
  function acceptReturning(requestId: unknown, duplicate = false) {
    acceptBehavior = () => jsonBody({ success: true, data: { request_id: requestId, service: "backend", state: "ci_running", ...(duplicate ? { duplicate: true } : {}) } }, 202);
  }

  /** 접수 결과를 남긴 로그(console 한 번 = 한 항목). */
  const outcomeLines = () => consoleLines.filter((line) => /redeploy:(accepted|duplicate)/.test(line));

  it.each([
    ["줄바꿈을 실은 값", "abc\r\nX: y"],
    ["65자", "a".repeat(65)],
    ["빈 글자", ""],
    ["숫자(글자가 아닌 형)", 12_345],
    ["null", null],
    ["허용 밖 글자(점 · 슬래시)", "../adm.other"],
  ] as const)("%s → 303 주소와 로그의 요청 번호 자리는 어드민이 보낸 번호 · 로그는 한 줄로 남는다", async (_label, returned) => {
    acceptReturning(returned, true);
    validSession();
    const fields = defaultFields();
    const sentRequestId = requestIdOf(fields.confirmation);
    const response = await POST(acceptRequest({ fields }));
    expect(response.status).toBe(303);
    expect(locationPath(response)).toBe(progressPath(sentRequestId));
    expect(outcomeLines()).toHaveLength(1);
    expect(outcomeLines()[0].startsWith(`${sentRequestId}:`)).toBe(true);
    for (const line of consoleLines) expect(line).not.toMatch(/[\r\n]/);
    if (typeof returned === "string" && returned.length > 0) {
      expect(consoleLines.join("\n")).not.toContain(returned);
      expect(response.headers.get("location") ?? "").not.toContain(encodeURIComponent(returned));
    }
  });

  it.each([
    ["옛 요청 번호(duplicate)", "adm-OldRequest_01", true],
    ["64자(경계 안)", "b".repeat(64), false],
  ] as const)("꼴이 맞으면 돌려받은 번호를 쓴다 — %s", async (_label, returned, duplicate) => {
    acceptReturning(returned, duplicate);
    validSession();
    const response = await POST(acceptRequest());
    expect(response.status).toBe(303);
    expect(locationPath(response)).toBe(progressPath(returned));
    expect(outcomeLines()).toHaveLength(1);
    expect(outcomeLines()[0].startsWith(`${returned}:`)).toBe(true);
  });
});

describe("Content-Type — 매체 종류가 정확히 application/x-www-form-urlencoded 일 때만(뒤의 매개변수는 허용 · 접두 일치는 거절)", () => {
  it.each([
    "application/x-www-form-urlencoded",
    "application/x-www-form-urlencoded; charset=UTF-8",
    "application/x-www-form-urlencoded;charset=utf-8",
    "APPLICATION/X-WWW-FORM-URLENCODED",
    "Application/X-Www-Form-Urlencoded; Charset=UTF-8",
  ])("%j → 받는다(303)", async (contentType) => {
    validSession();
    const response = await POST(acceptRequest({ contentType }));
    expect(response.status).toBe(303);
    expect(acceptCalls()).toHaveLength(1);
  });

  it.each([
    ["접두만 같음(evil)", "application/x-www-form-urlencodedevil"],
    ["접두만 같음(-x)", "application/x-www-form-urlencoded-x"],
    ["접두만 같음(+json)", "application/x-www-form-urlencoded+json; charset=UTF-8"],
    ["text/plain", "text/plain"],
    ["머리글 없음", null],
  ] as const)("%s → 400 · 비밀번호 확인 · 이력 · master 0", async (_label, contentType) => {
    validSession();
    const response = await POST(acceptRequest({ contentType }));
    expect(response.status).toBe(400);
    expectHtml(response);
    expect(await response.text()).toContain("요청의 꼴이 맞지 않습니다");
    expectNoDownstreamCalls();
  });
});

describe("배포된 서버의 차례 — middleware 가 route 앞에 선다", () => {
  /** 배포된 서버처럼 middleware 를 먼저 지나고(세션 쿠키는 요청의 Cookie 머리글로), 통과할 때만 route 를 부른다. */
  async function throughMiddleware(request: Request): Promise<{ response: Response; reachedRoute: boolean }> {
    const headers = new Headers(request.headers);
    const sessionToken = cookieJar.get(SESSION_COOKIE_NAME);
    if (sessionToken !== undefined) headers.set("cookie", `${SESSION_COOKIE_NAME}=${sessionToken}`);
    const gate = await middleware(new NextRequest(request.url, { method: request.method, headers, body: await request.clone().text() }));
    if (gate.headers.get("x-middleware-next") !== "1") return { response: gate, reachedRoute: false };
    return { response: await POST(request), reachedRoute: true };
  }

  it("세션 없음 + 틀린 출처 → middleware 가 먼저 401(JSON unauthorized) · route 에 닿지 않는다", async () => {
    const { response, reachedRoute } = await throughMiddleware(acceptRequest({ origin: "https://evil.example.test" }));
    expect(reachedRoute).toBe(false);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: { code: "unauthorized" } });
    expect(consoleLines.filter((line) => line.includes("redeploy:"))).toEqual([]);
    expectNoDownstreamCalls();
  });

  it("세션 있음 + 틀린 출처 → middleware 는 통과시키고 route 가 403", async () => {
    validSession();
    const { response, reachedRoute } = await throughMiddleware(acceptRequest({ origin: "https://evil.example.test" }));
    expect(reachedRoute).toBe(true);
    expect(response.status).toBe(403);
    expectNoDownstreamCalls();
  });
});
