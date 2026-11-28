/** ⑬ T4b — 어드민(서버 쪽)이 우리 서비스(관측 서버 · 알림 서버 · ci-cd 마스터 · backend · llm-wrapper)를 부르는 **모든** 호출에 `X-Caller-Service: admin` 을 싣는다
 * (통신 규약 §2.2 · 명세 "T4b"). 받는 쪽 nginx 가 접속 기록의 "부른 쪽"으로 쓴다 — 인증에 쓰지 않는다.
 * 고정하는 계약:
 * - 값은 코드의 상수 `admin`(소문자) · 호출마다 **정확히 하나**(`Headers.get` 이 쉼표로 잇지 않은 `admin`).
 * - 들어온 `X-Caller-Service`(edge · front · 이상한 값 · 여러 값)를 옮겨 싣지 않는다 · 설정(SERVER_NAME 등)에서 읽지 않는다.
 * - 바깥(GitHub)에는 싣지 않는다. 그 밖의 머리글(비밀값) · 본문 · 메서드는 그대로. 브라우저 쪽 코드는 이 머리글을 싣지 않는다.
 * 두 겹으로 본다 — (가) 클라이언트마다 모든 메서드(전수 표의 호출 자리 하나하나) · (나) 화면 · API · 허브의 진입에서 실제 설정 · 실제 전역 fetch 로. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => false }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    has: (name: string) => cookieJar.has(name),
    getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers({ "x-caller-service": "edge" }),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import { hash } from "@node-rs/argon2";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as deployDetailGet } from "@/app/api/deploys/detail/route";
import { GET as deploysGet } from "@/app/api/deploys/route";
import { GET as loginAttemptsGet } from "@/app/api/login-attempts/route";
import { GET as logTraceGet } from "@/app/api/logs/trace/route";
import { GET as logsGet } from "@/app/api/logs/route";
import { GET as resourcesGet } from "@/app/api/resources/route";
import { GET as statusGet } from "@/app/api/status/route";
import { GET as requestTraceGet } from "@/app/api/trace/route";
import { createAlertClient } from "@/features/auth/lib/alert-client";
import { createObserveClient } from "@/features/auth/lib/observe-client";
import { SESSION_COOKIE_NAME, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { createDeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import { createGitHubClient } from "@/features/deploy-detail/lib/github-client";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import { parseDeployHistoryQuery } from "@/features/deploys/lib/deploy-history-query";
import { createIncidentClient } from "@/features/log-trace/lib/incident-client";
import { createLoginAttemptsClient } from "@/features/login-attempts/lib/login-attempts-client";
import { parseLoginAttemptsQuery } from "@/features/login-attempts/lib/login-attempts-query";
import { createLogClient } from "@/features/logs/lib/log-client";
import { parseLogQuery } from "@/features/logs/lib/log-query";
import { createTrafficSpanClient } from "@/features/request-trace/lib/traffic-span-client";
import { createResourceMetricsClient } from "@/features/resources/lib/resource-metrics-client";
import { collectStatusOverview } from "@/features/status/lib/status-overview";
import { createDependencyClient } from "@/features/traffic-map/lib/dependency-client";
import { FAKE_LLM_URL } from "@/features/traffic-map/lib/dependency-test-fakes";
import { createTrafficMapClient } from "@/features/traffic-map/lib/traffic-map-client";
import { defaultTrafficMapHub, loadTrafficDependencies } from "@/features/traffic-map/server/traffic-map";
import { ADMIN_CALLER_SERVICE, CALLER_SERVICE_HEADER } from "@/shared/lib/caller-service";
import { okValue } from "@/shared/lib/upstream-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, jsonBody,
} from "@/shared/lib/upstream-test-fakes";

const NOW = Date.UTC(2026, 10, 27, 3, 0, 0);
/** 우리 서비스의 주소(규약 §2.1 의 이름 — 관측 서버 · 알림 서버 · ci-cd 마스터 · backend · llm-wrapper). */
const OUR_ORIGINS = [FAKE_OBSERVE_URL, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_BACKEND_URL, FAKE_LLM_URL].map((url) => new URL(url).origin);
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface RecordedCall { url: URL; method: string; headers: Headers; body: unknown }

/** 모든 호출을 남기고 503(봉투의 실패)로 답하는 fetch — 응답의 꼴은 보지 않는다(나가는 머리글만 본다). 로그인 판정만 잠금 시작으로 답해 알림 서버까지 간다. */
function recordingFetch(options: { lockOnAttempt?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers ?? {}), body: init.body ?? null });
    if (options.lockOnAttempt && url.pathname === "/auth/attempts") {
      return jsonBody({ success: true, data: { allowed: false, outcome: "failure", locked_until: "2026-11-27T03:15:00.000Z", lock_started: true, failures: 5 } });
    }
    return jsonBody({ success: false, error: { code: "unavailable" } }, 503);
  });
  return { calls, fetch: fetch as unknown as (input: string, init: RequestInit) => Promise<Response> };
}

/** 우리 서비스로 간 호출마다 — 정확히 하나 · 값 admin. 바깥으로 간 호출은 없어야 한다(있으면 실패 — 그 테스트가 따로 본다). */
function expectAdminOnEveryCall(calls: RecordedCall[], label: string) {
  expect(calls.length, `${label} — 나간 호출이 없다(빈 검사)`).toBeGreaterThan(0);
  for (const call of calls) {
    const where = `${label} → ${call.method} ${call.url.origin}${call.url.pathname}`;
    expect(OUR_ORIGINS, `${where} 는 우리 서비스가 아니다`).toContain(call.url.origin);
    expect(call.headers.get("x-caller-service"), where).toBe("admin");
  }
}

describe("상수", () => {
  it("머리글 이름 X-Caller-Service · 값 admin(소문자)", () => {
    expect(CALLER_SERVICE_HEADER).toBe("X-Caller-Service");
    expect(ADMIN_CALLER_SERVICE).toBe("admin");
  });
});

describe("(가) 클라이언트마다 — 모든 호출 자리에 정확히 하나 · admin · 비밀값 머리글은 그대로", () => {
  const cases: [string, (fetch: ReturnType<typeof recordingFetch>["fetch"]) => Promise<unknown>, string | null][] = [
    ["관측 서버 — 로그인 시도 기록(POST /auth/attempts)", (fetch) => createObserveClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch, clock: () => NOW })
      .recordAttempt({ attempt_id: "11111111-1111-4111-8111-111111111111", at: new Date(NOW).toISOString(), credential_ok: false, ip: "198.51.100.77", user_agent: "FakeBrowser/1.0", replayed: false }), "x-observe-secret"],
    ["관측 서버 — 거절 기록(POST /auth/attempts/rejected)", (fetch) => createObserveClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch, clock: () => NOW })
      .recordRejected({ attempt_id: "22222222-2222-4222-8222-222222222222", at: new Date(NOW).toISOString(), reason: "rate_limited", ip: "198.51.100.77", user_agent: "FakeBrowser/1.0", replayed: false } as never), "x-observe-secret"],
    ["알림 서버 — 잠금 사건(POST /events)", (fetch) => createAlertClient({ baseUrl: FAKE_ALERT_URL, secret: FAKE_ALERT_SECRET, fetch }).sendLoginLocked("2026-11-27T03:15:00.000Z"), "x-alert-secret"],
    ["ci-cd 마스터 — 배포 이력(GET /deploys)", (fetch) => createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch })
      .listDeployments((parseDeployHistoryQuery({}) as { ok: true; query: never }).query), "x-deploy-secret"],
    ["ci-cd 마스터 — git 범위(GET /deploys/git/commits)", (fetch) => createDeployGitClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch }).listCommits("backend", SHA, SHA), "x-deploy-secret"],
    ["ci-cd 마스터 — git 커밋 하나(GET /deploys/git/commit)", (fetch) => createDeployGitClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch }).getCommit("backend", SHA), "x-deploy-secret"],
    ["알림 서버 — 사건 목록(GET /incidents)", (fetch) => createIncidentClient({ baseUrl: FAKE_ALERT_URL, secret: FAKE_ALERT_SECRET, fetch }).listIncidents(20), "x-alert-secret"],
    ["관측 서버 — 로그인 시도 기록 목록", (fetch) => createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch })
      .listAttempts((parseLoginAttemptsQuery({}, NOW) as { ok: true; query: never }).query), "x-observe-secret"],
    ["관측 서버 — 잠금 상태", (fetch) => createLoginAttemptsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).readLock(), "x-observe-secret"],
    ["관측 서버 — 로그 조회", (fetch) => createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch })
      .searchLogs((parseLogQuery({}, NOW) as { ok: true; query: never }).query), "x-observe-secret"],
    ["관측 서버 — 요청의 구간", (fetch) => createTrafficSpanClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).requestSpans("req-0123456789ab"), "x-observe-secret"],
    ["관측 서버 — 서버의 수신", (fetch) => createTrafficSpanClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch })
      .serverReceipts(new Date(NOW - 60_000).toISOString(), new Date(NOW).toISOString()), "x-observe-secret"],
    ["관측 서버 — 자원 지금(직접 fetch)", (fetch) => createResourceMetricsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).latest(), "x-observe-secret"],
    ["관측 서버 — 자원 계열(직접 fetch)", (fetch) => createResourceMetricsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch })
      .series({ server: "158", scope: "host", name: null, fromMilliseconds: NOW - 3_600_000, toMilliseconds: NOW } as never), "x-observe-secret"],
    ["관측 서버 — 그때의 컨테이너(직접 fetch)", (fetch) => createResourceMetricsClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }).containers("158", NOW), "x-observe-secret"],
    ["관측 서버 — 통신 지도", (fetch) => createTrafficMapClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch })
      .trafficMap(new Date(NOW - 300_000).toISOString(), new Date(NOW).toISOString()), "x-observe-secret"],
    ["상태 한눈에 — 알림 감시 · 알림 헬스 · 관측 헬스 · backend 의존 · 마스터 헬스(다섯)", (fetch) => collectStatusOverview({
      alertUrl: FAKE_ALERT_URL, alertSecret: FAKE_ALERT_SECRET, observeUrl: FAKE_OBSERVE_URL, backendUrl: FAKE_BACKEND_URL, deployMasterUrl: FAKE_DEPLOY_MASTER_URL, fetch,
    }), null],
    ["의존 상태(T9d — backend · llm-wrapper · observe)", (fetch) => createDependencyClient({ backendUrl: FAKE_BACKEND_URL, llmUrl: FAKE_LLM_URL, observeUrl: FAKE_OBSERVE_URL, fetch }).readDependencies(), null],
  ];

  for (const [label, call, secretHeader] of cases) {
    it(label, async () => {
      const recorder = recordingFetch();
      await call(recorder.fetch);
      expectAdminOnEveryCall(recorder.calls, label);
      if (secretHeader !== null) for (const recorded of recorder.calls) expect(recorded.headers.get(secretHeader), `${label} 의 비밀값`).not.toBeNull();
    });
  }

  it("상태 한눈에는 다섯 곳 모두 — 비밀값이 없는 헬스 호출에도 싣는다", async () => {
    const recorder = recordingFetch();
    await collectStatusOverview({ alertUrl: FAKE_ALERT_URL, alertSecret: FAKE_ALERT_SECRET, observeUrl: FAKE_OBSERVE_URL, backendUrl: FAKE_BACKEND_URL, deployMasterUrl: FAKE_DEPLOY_MASTER_URL, fetch: recorder.fetch });
    expect(recorder.calls.map((call) => `${call.url.origin}${call.url.pathname}`).sort()).toEqual([
      `${FAKE_ALERT_URL}/health`, `${FAKE_ALERT_URL}/monitors`, `${FAKE_BACKEND_URL}/api/health/dependencies`, `${FAKE_DEPLOY_MASTER_URL}/health`, `${FAKE_OBSERVE_URL}/health`,
    ].sort());
    expectAdminOnEveryCall(recorder.calls, "상태 한눈에");
  });

  it("바깥(GitHub)에는 싣지 않는다", async () => {
    const calls: RecordedCall[] = [];
    const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push({ url: new URL(input), method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers ?? {}), body: null });
      return jsonBody([], 200);
    });
    await createGitHubClient({ baseUrl: "https://api.github.com", token: null, fetch }).listPullRequestsForCommit({ owner: "junhyeong9812", name: "study-note-deploy-system-backend" }, SHA);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin).toBe("https://api.github.com");
    expect(calls[0].headers.get("x-caller-service")).toBeNull();
  });

  it("본문 · 메서드는 그대로 — 로그인 시도 기록은 POST · JSON 본문(머리글 하나가 더해질 뿐)", async () => {
    const recorder = recordingFetch();
    await createObserveClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch: recorder.fetch, clock: () => NOW })
      .recordAttempt({ attempt_id: "33333333-3333-4333-8333-333333333333", at: new Date(NOW).toISOString(), credential_ok: true, ip: "198.51.100.77", user_agent: "FakeBrowser/1.0", replayed: false });
    expect(recorder.calls[0].method).toBe("POST");
    expect(JSON.parse(String(recorder.calls[0].body))).toMatchObject({ attempt_id: "33333333-3333-4333-8333-333333333333", credential_ok: true });
    expect(recorder.calls[0].headers.get("content-type")).toContain("application/json");
  });
});

// ---- (나) 진입에서 — 실제 설정 · 실제 전역 fetch · 들어온 머리글 · 설정의 함정 ----

let passwordHash = "";
beforeAll(async () => {
  passwordHash = await hash(FAKE_PASSWORD, { algorithm: 2 });
});

const INCOMING_CALLERS: [string, Record<string, string>][] = [
  ["들어온 머리글 없음", {}],
  ["edge", { "x-caller-service": "edge" }],
  ["front", { "x-caller-service": "front" }],
  ["대문자 ADMIN", { "x-caller-service": "ADMIN" }],
  ["이상한 값", { "x-caller-service": "../../etc;drop" }],
  ["여러 값", { "x-caller-service": "edge, front" }],
];

let recorder: ReturnType<typeof recordingFetch>;

beforeEach(() => {
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
  vi.stubEnv("BACKEND_URL", FAKE_BACKEND_URL);
  vi.stubEnv("LLM_URL", FAKE_LLM_URL);
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("LOG_REDIS_URL", "");
  // 설정의 함정 — 어느 것도 머리글의 값이 되면 안 된다
  vi.stubEnv("SERVER_NAME", "observe");
  vi.stubEnv("CALLER_SERVICE", "front");
  vi.stubEnv("X_CALLER_SERVICE", "edge");
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("study-note-admin.login-service")];
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
  recorder = recordingFetch();
  vi.stubGlobal("fetch", recorder.fetch);
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function apiRequest(path: string, incoming: Record<string, string>): Request {
  return new Request(new URL(path, FAKE_ORIGIN), { method: "GET", headers: { origin: FAKE_ORIGIN, "x-request-id": "trace-from-nginx_01", ...incoming } });
}

const ENTRIES: [string, (incoming: Record<string, string>) => Promise<unknown>][] = [
  ["GET /api/deploys", (incoming) => deploysGet(apiRequest("/api/deploys?service=backend", incoming))],
  ["GET /api/deploys/detail", (incoming) => deployDetailGet(apiRequest(`/api/deploys/detail?service=backend&selected=req-1&commit=${SHA}`, incoming))],
  ["GET /api/logs", (incoming) => logsGet(apiRequest("/api/logs", incoming))],
  ["GET /api/logs/trace", (incoming) => logTraceGet(apiRequest("/api/logs/trace?selected=1764212400000-0", incoming))],
  ["GET /api/login-attempts", (incoming) => loginAttemptsGet(apiRequest("/api/login-attempts", incoming))],
  ["GET /api/resources", (incoming) => resourcesGet(apiRequest("/api/resources", incoming))],
  ["GET /api/status", (incoming) => statusGet(apiRequest("/api/status", incoming))],
  ["GET /api/trace", (incoming) => requestTraceGet(apiRequest("/api/trace?request_id=req-0123456789ab", incoming))],
  ["통신 지도의 허브 — 주기 조회(snapshot)", async () => { defaultTrafficMapHub().clear(); return defaultTrafficMapHub().snapshot("5m"); }],
  ["통신 지도의 의존 조회(허브의 load)", () => loadTrafficDependencies()],
];

describe("(나) 진입마다 — 들어온 값을 옮기지 않고 · 설정에서 읽지 않고 · 늘 admin 하나", () => {
  for (const [entry, call] of ENTRIES) {
    for (const [incomingLabel, incoming] of INCOMING_CALLERS) {
      it(`${entry} · ${incomingLabel}`, async () => {
        await call(incoming);
        expectAdminOnEveryCall(recorder.calls, `${entry} · ${incomingLabel}`);
      });
    }
  }

  it("POST /api/auth/login — 관측 서버의 판정 · 잠금이 걸리면 알림 서버의 사건까지(들어온 머리글 edge)", async () => {
    recorder = recordingFetch({ lockOnAttempt: true });
    vi.stubGlobal("fetch", recorder.fetch);
    const response = await loginPost(new Request(new URL("/api/auth/login", FAKE_ORIGIN), {
      method: "POST", body: JSON.stringify({ id: FAKE_ADMIN_ID, password: "fake-wrong-password-marker-pw7" }),
      headers: { origin: FAKE_ORIGIN, "content-type": "application/json", "x-real-ip": "198.51.100.77", "x-caller-service": "edge" },
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    await vi.waitFor(() => expect(recorder.calls.some((call) => call.url.origin === new URL(FAKE_ALERT_URL).origin)).toBe(true));
    expect(recorder.calls.some((call) => call.url.pathname === "/auth/attempts")).toBe(true);
    expectAdminOnEveryCall(recorder.calls, "로그인");
  });

  it("통신 지도의 허브 결과는 그대로 — 실패도 사건으로(머리글 하나가 더해질 뿐)", async () => {
    defaultTrafficMapHub().clear();
    const event = await defaultTrafficMapHub().snapshot("5m");
    expect(event.map.ok).toBe(false);
    expect(() => okValue(event.map)).toThrow();
  });
});

describe("브라우저 쪽 코드는 이 머리글을 싣지 않는다(fetch · EventSource 는 그대로)", () => {
  it.each([
    "../features/auth/ui/LoginForm.tsx", "../features/auth/ui/LogoutButton.tsx",
    "../features/traffic-map/ui/TrafficMapLive.tsx", "../features/traffic-map/lib/traffic-map-stream-state.ts",
  ])("%s", (relativePath) => {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
    expect(source).not.toMatch(/x-caller-service/i);
    expect(source).not.toContain("@/shared/lib/caller-service");
  });
});
