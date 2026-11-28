/** ⑬ T2g — 어드민이 요청 ID 를 잇는다(통신 규약 §1.2 · §1.3 · 1.4 #7 · 7.1 의 `T2 | admin` 줄 · 명세 "T2g").
 * 어드민 nginx 는 앱으로 늘 자기가 정한 `X-Request-Id`(`$request_id` — 16진 32자)를 넘긴다(`deploy/nginx/nginx.conf:59`). 앱은 그 값을 꼴만 다시 보고 받는다.
 * 고정하는 계약(진입마다 — API route · 쪽의 서버 렌더 · 로그인):
 * - 받는 꼴: 들어온 `X-Request-Id` 가 `^[A-Za-z0-9_-]{1,64}$` 이면 그 값, 없거나 틀리면(여러 값 · 65자 · 쌍점 · 빈 값) 새 16진수 소문자 32자 — 진입마다 같은 판정.
 * - 한 요청 = 한 값: 그 요청의 처리 중에 우리 서비스(관측 · 알림 · 마스터 · backend · llm-wrapper)를 부르는 **모든** 호출에 `X-Request-Id` 가 정확히 하나 · 그 값.
 *   한 쪽이 진입 함수 둘을 나란히 불러도(배포 이력 + 상세 · 로그 + 연관 로그) 같은 값. 그 요청의 서버 쪽 로그 줄의 ID 자리도 그 값(`screen-*` 의 고정 낱말이 아니다).
 * - 섞이지 않는다: 동시에 도는 두 요청은 서로의 값을 싣지 · 쓰지 않는다. 앞 요청의 값이 다음 요청(머리글 없음)에 남지 않는다.
 * - 들어온 요청 없이 시작되는 호출(통신 지도의 허브 · 의존 조회): 호출마다 새 16진수 소문자 32자 — 그 조회를 깨운 구독자의 요청 ID 를 쓰지 않는다(규약 1.2).
 * - 바깥(GitHub · Claude 실행 자리)에는 싣지 않는다(규약 1.2 "바깥 서비스를 부를 때는 싣지 않는다" — 실행 자리는 규약의 목록에 없고 앞에 nginx 가 없다).
 * - 쓰는 진입(POST — 재배포 접수 · Claude 상한 · 분석 보내기 · 주인 표시)도 같다: 그 요청의 호출에 그 값 하나, 고정 낱말(`redeploy` · `incident-analysis` · `owner-mark`)이나
 *   진입이 따로 만든 값 대신 그 요청의 값이 로그 줄의 ID 자리에. 본문의 `request_id`(재배포의 접수 번호 — 일의 ID)는 그대로이고 머리글로 올리지 않는다(규약 1.2).
 * - 그 밖의 머리글(`X-Caller-Service: admin` · 비밀값)은 그대로.
 * 열어 둔 것: ID 를 요청의 길 따라 넘기는 법(인자 · AsyncLocalStorage — 이 테스트는 진입의 바깥에서만 본다) · 응답 머리글로 돌려주는가(규약 1.2 는 "처음 받는 쪽" = admin nginx 의 일 — 7.1 T4) ·
 * 허브의 로그 줄과 그 조회의 호출 ID 를 잇는가(꼴 · 구독자의 값이 아님만 본다) · 로그인 대기열의 재전송이 싣는 값(꼴 · 하나만 본다 — 여기서는 부르지 않는다) ·
 * 일의 ID 가 ID 자리에 오는 로그 줄(재배포 접수의 확인 값을 본 뒤의 결과 줄 · 분석의 진행 줄 — 접수 번호 · 분석 번호)은 여기서 보지 않는다 ·
 * 다른 서버를 부르지 않고 로그도 없는 진입(GET /api/owner-mark · 쪽 /owner-mark)은 밖에서 볼 것이 없다.
 * `next/headers` 의 `headers()` 는 Next 처럼 요청마다의 범위(AsyncLocalStorage)로 흉내 낸다 — route 핸들러도 같은 범위 안에서 부른다(Next 에서 둘은 같은 머리글이다). */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requestScope = vi.hoisted(() => ({ storage: null as { getStore(): Headers | undefined } | null, cookieJar: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => false }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (requestScope.cookieJar.has(name) ? { name, value: requestScope.cookieJar.get(name)! } : undefined),
    has: (name: string) => requestScope.cookieJar.has(name),
    getAll: () => [...requestScope.cookieJar].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => {
    const current = requestScope.storage?.getStore();
    if (current === undefined) throw new Error("`headers` was called outside a request scope");
    return current;
  },
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import { hash } from "@node-rs/argon2";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as claudeLimitsPost } from "@/app/api/claude-usage/limits/route";
import { GET as claudeUsageGet } from "@/app/api/claude-usage/route";
import { GET as deployDetailGet } from "@/app/api/deploys/detail/route";
import { GET as redeployPreviewGet, POST as redeployAcceptPost } from "@/app/api/deploys/redeploy/route";
import { GET as deploysGet } from "@/app/api/deploys/route";
import { GET as deployVersionsGet } from "@/app/api/deploys/versions/route";
import { POST as incidentAnalysisPost } from "@/app/api/incidents/analysis/route";
import { GET as incidentsGet } from "@/app/api/incidents/route";
import { GET as loginAttemptsGet } from "@/app/api/login-attempts/route";
import { GET as logTraceGet } from "@/app/api/logs/trace/route";
import { GET as logsGet } from "@/app/api/logs/route";
import { POST as ownerMarkClearPost } from "@/app/api/owner-mark/clear/route";
import { POST as ownerMarkSetPost } from "@/app/api/owner-mark/route";
import { GET as resourcesGet } from "@/app/api/resources/route";
import { GET as statusGet } from "@/app/api/status/route";
import { GET as trafficStreamGet } from "@/app/api/traffic/stream/route";
import { GET as requestTraceGet } from "@/app/api/trace/route";
import { GET as visitsGet } from "@/app/api/visits/route";
import ClaudeUsagePage from "@/app/claude-usage/page";
import DeploysPage from "@/app/deploys/page";
import RedeployPreviewPage from "@/app/deploys/redeploy/page";
import DeployVersionsPage from "@/app/deploys/versions/page";
import IncidentAnalysisPage from "@/app/incidents/analysis/page";
import IncidentsPage from "@/app/incidents/page";
import LoginAttemptsPage from "@/app/login-attempts/page";
import LogsPage from "@/app/logs/page";
import ResourcesPage from "@/app/resources/page";
import StatusPage from "@/app/status/page";
import TracePage from "@/app/trace/page";
import TrafficPage from "@/app/traffic/page";
import VisitsPage from "@/app/visits/page";
import { SESSION_COOKIE_NAME, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { CLAUDE_SETTINGS_HEADER, FAKE_CLAUDE_RUNNER_SETTINGS_SECRET, FAKE_CLAUDE_RUNNER_URL } from "@/features/claude-usage/lib/claude-runner-test-fakes";
import { issueRedeployConfirmation, newRedeployRequestId } from "@/features/deploy-redeploy/lib/redeploy-confirmation";
import { monitorIncidentId } from "@/features/incidents/lib/incident-id";
import { FAKE_LLM_URL } from "@/features/traffic-map/lib/dependency-test-fakes";
import { defaultTrafficDependencyHub, defaultTrafficMapHub, loadTrafficDependencies } from "@/features/traffic-map/server/traffic-map";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, jsonBody,
} from "@/shared/lib/upstream-test-fakes";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

const storage = new AsyncLocalStorage<Headers>();
requestScope.storage = storage;

/** 우리 서비스의 주소(규약 §2.1 — 관측 서버 · 알림 서버 · ci-cd 마스터 · backend · llm-wrapper). */
const OUR_ORIGINS = [FAKE_OBSERVE_URL, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_BACKEND_URL, FAKE_LLM_URL].map((url) => new URL(url).origin);
const SECRET_BY_ORIGIN = new Map<string, string>([
  [new URL(FAKE_OBSERVE_URL).origin, "x-observe-secret"], [new URL(FAKE_ALERT_URL).origin, "x-alert-secret"], [new URL(FAKE_DEPLOY_MASTER_URL).origin, "x-deploy-secret"],
]);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const NEW_ID = /^[0-9a-f]{32}$/;
const SUBSCRIBER_ID = "subscriber_trace_01";

interface RecordedCall { url: URL; method: string; headers: Headers; body: unknown }

/** 모든 호출을 남기고 503(봉투의 실패)로 답하는 fetch — 실패 칸마다 로그 1줄이 나온다. 로그인 판정만 잠금 시작으로 답해 알림 서버까지 간다.
 * delayMilliseconds 를 주면 답하기 전에 그만큼 기다린다(두 요청이 서로 엇갈리게). */
function recordingFetch(options: { lockOnAttempt?: boolean; delayMilliseconds?: number } = {}) {
  const calls: RecordedCall[] = [];
  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers ?? {}), body: init.body ?? null });
    if (options.delayMilliseconds !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMilliseconds));
    if (options.lockOnAttempt && url.pathname === "/auth/attempts") {
      return jsonBody({ success: true, data: { allowed: false, outcome: "failure", locked_until: "2026-11-27T03:15:00.000Z", lock_started: true, failures: 5 } });
    }
    return jsonBody({ success: false, error: { code: "unavailable" } }, 503);
  });
  return { calls, fetch: fetch as unknown as (input: string, init: RequestInit) => Promise<Response> };
}

/** 콘솔로 나간 로그 줄(`<요청ID>:<서버>:<내용>`) — console.log · warn · error 를 모은다. */
const consoleLines: string[] = [];

function lineId(line: string): string {
  return line.slice(0, line.indexOf(":"));
}

/** 들어온 머리글로 한 요청의 범위를 연다 — Next 처럼 그 안의 `headers()` 는 이 머리글이다. */
function inRequest<Value>(requestHeaders: Headers, run: () => Promise<Value>): Promise<Value> {
  return storage.run(requestHeaders, run);
}

/** 들어온 `X-Request-Id` 의 경우 — expected 가 null 이면 새 16진 32자여야 한다. */
interface IncomingCase { label: string; headers: () => Headers; expected: string | null }

const INCOMING_CASES: IncomingCase[] = [
  { label: "nginx 의 16진 32자", headers: () => new Headers({ "x-request-id": "0123456789abcdef0123456789abcdef" }), expected: "0123456789abcdef0123456789abcdef" },
  { label: "밑줄을 품은 값", headers: () => new Headers({ "x-request-id": "trace_from_nginx_01" }), expected: "trace_from_nginx_01" },
  { label: "없음", headers: () => new Headers(), expected: null },
  { label: "65자", headers: () => new Headers({ "x-request-id": "A".repeat(65) }), expected: null },
  { label: "쌍점(로그의 구분자)", headers: () => new Headers({ "x-request-id": "bad:value" }), expected: null },
  {
    label: "두 값", headers: () => {
      const twoValues = new Headers();
      twoValues.append("x-request-id", "trace-a");
      twoValues.append("x-request-id", "trace-b");
      return twoValues;
    }, expected: null,
  },
];

/** 호출 · 로그 줄이 모두 한 값인가 — 그 값을 돌려준다. 바깥으로 간 호출이 있으면 실패(바깥은 따로 본다). */
function expectOneIdOnEveryCallAndLine(calls: RecordedCall[], lines: string[], label: string, incoming: IncomingCase, options: { linesRequired: boolean }): string {
  expect(calls.length, `${label} — 나간 호출이 없다(빈 검사)`).toBeGreaterThan(0);
  const carried = calls.map((call) => call.headers.get("x-request-id"));
  const id = carried[0];
  expect(id, `${label} — 첫 호출에 X-Request-Id 가 없다`).not.toBeNull();
  if (incoming.expected !== null) expect(id, label).toBe(incoming.expected);
  else {
    expect(id, `${label} — 새 값의 꼴`).toMatch(NEW_ID);
    expect(incoming.headers().get("x-request-id") ?? "", label).not.toContain(id!);
  }
  for (const call of calls) {
    const where = `${label} → ${call.method} ${call.url.origin}${call.url.pathname}`;
    expect(OUR_ORIGINS, `${where} 는 우리 서비스가 아니다`).toContain(call.url.origin);
    expect(call.headers.get("x-request-id"), `${where} — 정확히 하나 · 그 요청의 값`).toBe(id);
    expect(call.headers.get("x-caller-service"), `${where} — 호출자 머리글은 그대로`).toBe("admin");
    const secretHeader = SECRET_BY_ORIGIN.get(call.url.origin);
    if (secretHeader !== undefined && call.url.pathname !== "/health") expect(call.headers.get(secretHeader), `${where} — 비밀값은 그대로`).not.toBeNull();
  }
  if (options.linesRequired) expect(lines.length, `${label} — 로그 줄이 없다(빈 검사)`).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line.startsWith("screen-"), `${label} — 옛 고정 낱말: ${line}`).toBe(false);
    expect(lineId(line), `${label} — 로그 줄의 ID 자리: ${line}`).toBe(id);
  }
  return id!;
}

let passwordHash = "";
beforeAll(async () => {
  passwordHash = await hash(FAKE_PASSWORD, { algorithm: 2 });
});

let recorder: ReturnType<typeof recordingFetch>;

function useFetch(next: ReturnType<typeof recordingFetch>) {
  recorder = next;
  vi.stubGlobal("fetch", next.fetch);
}

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
  // 설정의 함정 — 어느 것도 요청 ID 가 되면 안 된다
  vi.stubEnv("REQUEST_ID", "trace-from-config");
  vi.stubEnv("X_REQUEST_ID", "trace-from-config");
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("study-note-admin.login-service")];
  requestScope.cookieJar.clear();
  requestScope.cookieJar.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
  useFetch(recordingFetch());
  consoleLines.length = 0;
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function apiRequest(path: string, requestHeaders: Headers): Request {
  const merged = new Headers(requestHeaders);
  merged.set("origin", FAKE_ORIGIN);
  return new Request(new URL(path, FAKE_ORIGIN), { method: "GET", headers: merged });
}

function page(render: (props: { searchParams: Promise<SearchParamsInput> }) => Promise<unknown>, input: SearchParamsInput) {
  return () => render({ searchParams: Promise.resolve(input) });
}

/** 진입의 전수 — 요청을 받아 우리 서비스를 부르는 곳(로그인은 따로 · 통신 지도의 허브는 "들어온 요청 없이"에서). 세 번째 칸: 503 이면 실패 로그 줄이 나오는가. */
const ENTRIES: [string, (requestHeaders: Headers) => Promise<unknown>, boolean][] = [
  ["GET /api/deploys", (requestHeaders) => deploysGet(apiRequest("/api/deploys?service=backend", requestHeaders)), true],
  ["GET /api/deploys/detail", (requestHeaders) => deployDetailGet(apiRequest(`/api/deploys/detail?service=backend&selected=req-1&commit=${SHA}`, requestHeaders)), true],
  ["GET /api/logs", (requestHeaders) => logsGet(apiRequest("/api/logs", requestHeaders)), true],
  ["GET /api/logs/trace", (requestHeaders) => logTraceGet(apiRequest("/api/logs/trace?selected=1764212400000-0", requestHeaders)), true],
  ["GET /api/login-attempts", (requestHeaders) => loginAttemptsGet(apiRequest("/api/login-attempts", requestHeaders)), true],
  ["GET /api/resources", (requestHeaders) => resourcesGet(apiRequest("/api/resources", requestHeaders)), true],
  ["GET /api/status", (requestHeaders) => statusGet(apiRequest("/api/status", requestHeaders)), true],
  ["GET /api/trace", (requestHeaders) => requestTraceGet(apiRequest("/api/trace?request_id=req-0123456789ab", requestHeaders)), true],
  ["쪽 /deploys(이력 + 상세 — 진입 함수 둘)", page(DeploysPage, { service: "backend", selected: "req-1", commit: SHA }), true],
  ["쪽 /login-attempts", page(LoginAttemptsPage, {}), true],
  ["쪽 /logs(목록 + 연관 로그 · 그때 자원 — 진입 함수 둘)", page(LogsPage, { selected: "1764212400000-0" }), true],
  ["쪽 /resources", page(ResourcesPage, {}), true],
  ["쪽 /status", () => StatusPage(), true],
  ["쪽 /trace", page(TracePage, { request_id: "req-0123456789ab" }), true],
  ["GET /api/deploys/versions", (requestHeaders) => deployVersionsGet(apiRequest("/api/deploys/versions?service=backend", requestHeaders)), true],
  ["GET /api/deploys/redeploy(확인 화면의 데이터)", (requestHeaders) => redeployPreviewGet(apiRequest(`/api/deploys/redeploy?service=backend&commit=${SHA}`, requestHeaders)), true],
  ["GET /api/incidents(목록의 네 출처)", (requestHeaders) => incidentsGet(apiRequest("/api/incidents", requestHeaders)), true],
  ["GET /api/visits", (requestHeaders) => visitsGet(apiRequest("/api/visits", requestHeaders)), true],
  ["쪽 /deploys/versions", page(DeployVersionsPage, { service: "backend" }), true],
  ["쪽 /deploys/redeploy", page(RedeployPreviewPage, { service: "backend", commit: SHA }), true],
  ["쪽 /incidents", page(IncidentsPage, {}), true],
  ["쪽 /incidents/analysis(그 문제를 찾는 목록의 호출)", page(IncidentAnalysisPage, { incident: monitorIncidentId("front") }), true],
  ["쪽 /visits", page(VisitsPage, {}), true],
];

describe("진입마다 — 들어온 ID 를 꼴만 보고 받고, 그 요청의 모든 호출 · 로그 줄에 그 값 하나", () => {
  for (const [entry, call, linesRequired] of ENTRIES) {
    for (const incoming of INCOMING_CASES) {
      it(`${entry} · ${incoming.label}`, async () => {
        const requestHeaders = incoming.headers();
        await inRequest(requestHeaders, () => call(requestHeaders));
        expectOneIdOnEveryCallAndLine(recorder.calls, consoleLines, `${entry} · ${incoming.label}`, incoming, { linesRequired });
      });
    }
  }

  it("한 쪽이 진입 함수 둘을 나란히 불러도 호출이 둘 이상 · 모두 같은 새 값(/deploys — 머리글 없음)", async () => {
    const requestHeaders = new Headers();
    await inRequest(requestHeaders, page(DeploysPage, { service: "backend", selected: "req-1", commit: SHA }));
    expect(recorder.calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(recorder.calls.map((call) => call.headers.get("x-request-id"))).size).toBe(1);
  });

  it("상태 한눈에는 다섯 곳 모두 같은 값(비밀값이 없는 헬스 호출 포함)", async () => {
    const requestHeaders = new Headers({ "x-request-id": "status_trace_01" });
    await inRequest(requestHeaders, () => statusGet(apiRequest("/api/status", requestHeaders)));
    expect(recorder.calls.map((call) => `${call.url.origin}${call.url.pathname}`).sort()).toEqual([
      `${FAKE_ALERT_URL}/health`, `${FAKE_ALERT_URL}/monitors`, `${FAKE_BACKEND_URL}/api/health/dependencies`, `${FAKE_DEPLOY_MASTER_URL}/health`, `${FAKE_OBSERVE_URL}/health`,
    ].sort());
    for (const call of recorder.calls) expect(call.headers.get("x-request-id")).toBe("status_trace_01");
  });
});

describe("로그인 — 같은 판정(밑줄을 받는다) · 관측 서버의 판정과 알림 서버의 잠금 사건까지 같은 값", () => {
  for (const incoming of INCOMING_CASES) {
    it(`POST /api/auth/login · ${incoming.label}`, async () => {
      useFetch(recordingFetch({ lockOnAttempt: true }));
      const requestHeaders = incoming.headers();
      requestHeaders.set("origin", FAKE_ORIGIN);
      requestHeaders.set("content-type", "application/json");
      requestHeaders.set("x-real-ip", "198.51.100.77");
      const response = await inRequest(requestHeaders, () => loginPost(new Request(new URL("/api/auth/login", FAKE_ORIGIN), {
        method: "POST", body: JSON.stringify({ id: FAKE_ADMIN_ID, password: "fake-wrong-password-marker-pw7" }), headers: requestHeaders,
      })));
      expect(response.status).toBeGreaterThanOrEqual(400);
      await vi.waitFor(() => expect(recorder.calls.some((call) => call.url.origin === new URL(FAKE_ALERT_URL).origin)).toBe(true));
      expect(recorder.calls.some((call) => call.url.pathname === "/auth/attempts")).toBe(true);
      const id = expectOneIdOnEveryCallAndLine(recorder.calls, consoleLines, `로그인 · ${incoming.label}`, incoming, { linesRequired: true });
      // 본문 · 메서드는 그대로 — 머리글 하나가 더해질 뿐
      const attempt = recorder.calls.find((call) => call.url.pathname === "/auth/attempts")!;
      expect(attempt.method).toBe("POST");
      expect(JSON.parse(String(attempt.body))).toMatchObject({ credential_ok: false });
      expect(JSON.stringify(JSON.parse(String(attempt.body)))).not.toContain(id);
    });
  }
});

describe("섞이지 않는다 — 동시에 도는 두 요청 · 앞 요청의 값", () => {
  const CONCURRENT: [string, (requestHeaders: Headers) => Promise<unknown>][] = [
    ["GET /api/status", (requestHeaders) => statusGet(apiRequest("/api/status", requestHeaders))],
    ["GET /api/resources", (requestHeaders) => resourcesGet(apiRequest("/api/resources", requestHeaders))],
    ["GET /api/logs/trace", (requestHeaders) => logTraceGet(apiRequest("/api/logs/trace?selected=1764212400000-0", requestHeaders))],
    ["쪽 /login-attempts", page(LoginAttemptsPage, {})],
    ["쪽 /deploys(이력 + 상세)", page(DeploysPage, { service: "backend", selected: "req-1", commit: SHA })],
    ["GET /api/incidents(목록의 네 출처)", (requestHeaders) => incidentsGet(apiRequest("/api/incidents", requestHeaders))],
    ["쪽 /deploys/redeploy", page(RedeployPreviewPage, { service: "backend", commit: SHA })],
    ["쪽 /visits", page(VisitsPage, {})],
  ];

  for (const [entry, call] of CONCURRENT) {
    it(`${entry} — 두 요청을 겹쳐 돌려도 각자의 값만(호출 수 · 로그 줄 수가 혼자 돌 때와 같다)`, async () => {
      useFetch(recordingFetch({ delayMilliseconds: 5 }));
      const aloneHeaders = new Headers({ "x-request-id": "alone_trace_00" });
      await inRequest(aloneHeaders, () => call(aloneHeaders));
      const aloneCalls = recorder.calls.length;
      const aloneLines = consoleLines.length;
      expect(aloneCalls).toBeGreaterThan(0);

      useFetch(recordingFetch({ delayMilliseconds: 5 }));
      consoleLines.length = 0;
      const firstHeaders = new Headers({ "x-request-id": "first_trace_01" });
      const secondHeaders = new Headers({ "x-request-id": "second_trace_02" });
      await Promise.all([inRequest(firstHeaders, () => call(firstHeaders)), inRequest(secondHeaders, () => call(secondHeaders))]);
      const carried = recorder.calls.map((recorded) => recorded.headers.get("x-request-id"));
      expect(carried.filter((id) => id === "first_trace_01")).toHaveLength(aloneCalls);
      expect(carried.filter((id) => id === "second_trace_02")).toHaveLength(aloneCalls);
      expect(carried).toHaveLength(aloneCalls * 2);
      expect(consoleLines.filter((line) => lineId(line) === "first_trace_01")).toHaveLength(aloneLines);
      expect(consoleLines.filter((line) => lineId(line) === "second_trace_02")).toHaveLength(aloneLines);
      expect(consoleLines).toHaveLength(aloneLines * 2);
    });
  }

  it("두 요청이 모두 머리글 없이 겹치면 — 새 값 둘이 서로 다르고 요청마다 하나", async () => {
    useFetch(recordingFetch({ delayMilliseconds: 5 }));
    const firstHeaders = new Headers();
    const secondHeaders = new Headers();
    await Promise.all([
      inRequest(firstHeaders, () => statusGet(apiRequest("/api/status", firstHeaders))),
      inRequest(secondHeaders, () => statusGet(apiRequest("/api/status", secondHeaders))),
    ]);
    const counts = new Map<string, number>();
    for (const recorded of recorder.calls) {
      const id = recorded.headers.get("x-request-id") ?? "(없음)";
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect([...counts.keys()]).toHaveLength(2);
    for (const [id, count] of counts) {
      expect(id).toMatch(NEW_ID);
      expect(count).toBe(recorder.calls.length / 2);
    }
  });

  it("앞 요청의 값이 다음 요청(머리글 없음)에 남지 않는다", async () => {
    const firstHeaders = new Headers({ "x-request-id": "previous_trace_01" });
    await inRequest(firstHeaders, () => statusGet(apiRequest("/api/status", firstHeaders)));
    useFetch(recordingFetch());
    consoleLines.length = 0;
    const secondHeaders = new Headers();
    await inRequest(secondHeaders, () => statusGet(apiRequest("/api/status", secondHeaders)));
    for (const recorded of recorder.calls) {
      expect(recorded.headers.get("x-request-id")).toMatch(NEW_ID);
      expect(recorded.headers.get("x-request-id")).not.toBe("previous_trace_01");
    }
    for (const line of consoleLines) expect(lineId(line)).not.toBe("previous_trace_01");
  });
});

// ---- 들어온 요청 없이 시작되는 호출 — 통신 지도의 허브 · 의존 조회(규약 1.2) ----

const HUB_KEYS = ["__studyNoteTrafficMapHub", "__studyNoteTrafficDependencyHub"] as const;

function freshHubs() {
  const holder = globalThis as unknown as Record<string, { stop(): void } | undefined>;
  for (const key of HUB_KEYS) {
    holder[key]?.stop();
    delete holder[key];
  }
}

/** 허브의 호출마다 — 새 16진 32자 · 구독자의 값이 아니다 · 호출마다 다르다. 허브의 로그 줄도 같은 규칙(옛 낱말 아님). */
function expectHubIds(calls: RecordedCall[], lines: string[], label: string) {
  expect(calls.length, `${label} — 나간 호출이 없다(빈 검사)`).toBeGreaterThan(0);
  const ids = calls.map((call) => call.headers.get("x-request-id"));
  for (const [index, id] of ids.entries()) {
    const where = `${label} → ${calls[index].url.origin}${calls[index].url.pathname}`;
    expect(OUR_ORIGINS).toContain(calls[index].url.origin);
    expect(id, `${where} — 새 16진 32자`).toMatch(NEW_ID);
    expect(id, `${where} — 구독자의 요청 ID 를 쓰지 않는다`).not.toBe(SUBSCRIBER_ID);
    expect(calls[index].headers.get("x-caller-service")).toBe("admin");
  }
  expect(new Set(ids).size, `${label} — 호출마다 새 값`).toBe(ids.length);
  for (const line of lines) {
    expect(line.startsWith("screen-"), `${label} — 옛 고정 낱말: ${line}`).toBe(false);
    expect(lineId(line), `${label} — 로그 줄의 ID 자리: ${line}`).toMatch(NEW_ID);
    expect(lineId(line)).not.toBe(SUBSCRIBER_ID);
  }
}

describe("들어온 요청 없이 시작되는 호출 — 호출마다 새 ID · 구독자의 요청 ID 를 쓰지 않는다", () => {
  beforeEach(() => freshHubs());
  afterEach(() => freshHubs());

  it("통신 지도의 허브 — 구독자의 요청 안에서 깨워도(snapshot) 새 값 · 실패 로그 줄도", async () => {
    const subscriberHeaders = new Headers({ "x-request-id": SUBSCRIBER_ID });
    await inRequest(subscriberHeaders, () => defaultTrafficMapHub().snapshot("5m"));
    expect(recorder.calls).toHaveLength(1);
    expect(consoleLines.length, "실패 로그 줄(빈 검사)").toBeGreaterThan(0);
    expectHubIds(recorder.calls, consoleLines, "통신 지도의 허브");
  });

  it("통신 지도의 허브 — 다음 바퀴는 또 새 값", async () => {
    const subscriberHeaders = new Headers({ "x-request-id": SUBSCRIBER_ID });
    await inRequest(subscriberHeaders, () => defaultTrafficMapHub().snapshot("5m"));
    defaultTrafficMapHub().clear();
    await inRequest(subscriberHeaders, () => defaultTrafficMapHub().snapshot("5m"));
    expect(recorder.calls).toHaveLength(2);
    expectHubIds(recorder.calls, consoleLines, "통신 지도의 허브 두 바퀴");
  });

  it("의존 조회 — 세 경로가 호출마다 다른 새 값 · 두 바퀴의 여섯이 모두 다르다(구독자의 요청 안에서 불러도)", async () => {
    const subscriberHeaders = new Headers({ "x-request-id": SUBSCRIBER_ID });
    await inRequest(subscriberHeaders, () => loadTrafficDependencies());
    await inRequest(subscriberHeaders, () => loadTrafficDependencies());
    expect(recorder.calls).toHaveLength(6);
    expectHubIds(recorder.calls, consoleLines, "의존 조회");
  });

  it("쪽 /traffic — 첫 그림의 허브 조회도 구독자의 값이 아니다", async () => {
    const subscriberHeaders = new Headers({ "x-request-id": SUBSCRIBER_ID });
    await inRequest(subscriberHeaders, page(TrafficPage, {}));
    expectHubIds(recorder.calls, consoleLines, "쪽 /traffic");
  });

  it("GET /api/traffic/stream — 흐름을 연 구독자의 요청 ID 가 허브 · 의존 허브의 호출에 실리지 않는다", async () => {
    const subscriberHeaders = new Headers({ "x-request-id": SUBSCRIBER_ID });
    const abort = new AbortController();
    const request = new Request(new URL("/api/traffic/stream?range=5m", FAKE_ORIGIN), { method: "GET", headers: subscriberHeaders, signal: abort.signal });
    const response = await inRequest(subscriberHeaders, () => trafficStreamGet(request));
    expect(response.status).toBe(200);
    try {
      await vi.waitFor(() => {
        expect(recorder.calls.length).toBeGreaterThanOrEqual(4);   // 지도 1 + 의존 3
        // 두 허브의 실패 로그 줄까지 나온 뒤에 본다(503 — 지도 칸 · 의존 칸)
        expect(consoleLines.some((line) => line.includes("cell=map"))).toBe(true);
        expect(consoleLines.some((line) => line.includes("cell=dependencies:"))).toBe(true);
      });
    } finally {
      abort.abort();
      await response.body?.cancel().catch(() => undefined);
    }
    expectHubIds(recorder.calls, consoleLines, "흐름");
  });
});

describe("바깥(GitHub)에는 싣지 않는다 — 배포 상세가 GitHub 까지 갈 때", () => {
  it("마스터 호출에는 그 요청의 값 · GitHub 호출에는 X-Request-Id 도 X-Caller-Service 도 없다", async () => {
    vi.resetModules();
    const rows = [
      { request_id: "selected-1", service: "backend", commit_sha: SHA, state: "succeeded", accepted_at: "2026-11-22T02:00:00Z", finished_at: "2026-11-22T02:05:00Z", ci_ms: 60000, cd_ms: 30000 },
      { request_id: "previous-1", service: "backend", commit_sha: "1111111111111111111111111111111111111111", state: "succeeded", accepted_at: "2026-11-22T01:00:00Z",
        finished_at: "2026-11-22T01:05:00Z", ci_ms: 60000, cd_ms: 30000 },
    ];
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers ?? {}), body: null });
      if (url.hostname === "api.github.com") return jsonBody([], 200);
      if (url.pathname === "/deploys") return jsonBody({ success: true, data: { deployments: rows } });
      return jsonBody({ success: false, error: { code: "unavailable" } }, 503);
    }));
    const route = await import("@/app/api/deploys/detail/route");
    const requestHeaders = new Headers({ "x-request-id": "detail_trace_01" });
    await inRequest(requestHeaders, () => route.GET(apiRequest("/api/deploys/detail?service=backend&selected=selected-1", requestHeaders)));
    const github = calls.filter((call) => call.url.hostname === "api.github.com");
    const ours = calls.filter((call) => call.url.hostname !== "api.github.com");
    expect(github.length, "GitHub 까지 가지 않았다(빈 검사)").toBeGreaterThan(0);
    expect(ours.length).toBeGreaterThan(0);
    for (const call of github) {
      expect(call.headers.get("x-request-id"), `${call.url.pathname}`).toBeNull();
      expect(call.headers.get("x-caller-service")).toBeNull();
    }
    for (const call of ours) expect(call.headers.get("x-request-id"), `${call.url.pathname}`).toBe("detail_trace_01");
  });
});

// ---- 바깥(Claude 실행 자리) — 규약의 목록에 없다: 머리글 둘을 싣지 않고, 그 요청의 로그 줄만 그 값 ----

const RUNNER_ORIGIN = new URL(FAKE_CLAUDE_RUNNER_URL).origin;

/** 들어온 ID 가 있을 때와 없을 때 — 쓰는 진입 · 실행 자리의 진입은 이 둘로 본다(받는 꼴의 판정은 위의 전수가 본다). */
const GIVEN_AND_NEW: IncomingCase[] = [INCOMING_CASES[1], INCOMING_CASES[2]];

/** 그 줄들의 ID 자리가 모두 그 요청의 값인가(들어온 값이 없으면 새 16진 32자 하나) — 그 값을 돌려준다. */
function expectLinesCarryRequestId(lines: string[], label: string, incoming: IncomingCase): string {
  expect(lines.length, `${label} — 로그 줄이 없다(빈 검사)`).toBeGreaterThan(0);
  const id = lineId(lines[0]);
  if (incoming.expected !== null) expect(id, `${label} — 로그 줄의 ID 자리: ${lines[0]}`).toBe(incoming.expected);
  else expect(id, `${label} — 새 값의 꼴: ${lines[0]}`).toMatch(NEW_ID);
  for (const line of lines) expect(lineId(line), `${label} — 로그 줄의 ID 자리: ${line}`).toBe(id);
  return id;
}

function formRequest(path: string, requestHeaders: Headers, body: string, contentType = "application/x-www-form-urlencoded"): Request {
  const merged = new Headers(requestHeaders);
  merged.set("origin", FAKE_ORIGIN);
  merged.set("content-type", contentType);
  merged.set("x-real-ip", "198.51.100.77");
  return new Request(new URL(path, FAKE_ORIGIN), { method: "POST", headers: merged, body });
}

describe("바깥(Claude 실행 자리)에는 싣지 않는다 — 그 요청의 로그 줄은 그 값", () => {
  beforeEach(() => {
    vi.stubEnv("CLAUDE_RUNNER_URL", FAKE_CLAUDE_RUNNER_URL);
    vi.stubEnv("CLAUDE_RUNNER_SETTINGS_SECRET", FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
  });

  const RUNNER_ENTRIES: [string, (requestHeaders: Headers) => Promise<unknown>][] = [
    ["GET /api/claude-usage", (requestHeaders) => claudeUsageGet(apiRequest("/api/claude-usage", requestHeaders))],
    ["쪽 /claude-usage", () => ClaudeUsagePage()],
  ];

  for (const [entry, call] of RUNNER_ENTRIES) {
    for (const incoming of GIVEN_AND_NEW) {
      it(`${entry} · ${incoming.label} — 헬스 · 사용량 · 상한의 세 호출에 X-Request-Id 도 X-Caller-Service 도 없다 · 실패 줄 셋의 ID 자리는 그 요청의 값`, async () => {
        const requestHeaders = incoming.headers();
        await inRequest(requestHeaders, () => call(requestHeaders));
        expect(recorder.calls.map((recorded) => recorded.url.pathname).sort()).toEqual(["/health", "/limits", "/usage"]);
        for (const recorded of recorder.calls) {
          const where = `${entry} → ${recorded.method} ${recorded.url.pathname}`;
          expect(recorded.url.origin, where).toBe(RUNNER_ORIGIN);
          expect(recorded.headers.get("x-request-id"), `${where} — 추적 ID 를 싣지 않는다`).toBeNull();
          expect(recorded.headers.get("x-caller-service"), `${where} — 호출자 머리글을 싣지 않는다`).toBeNull();
          if (recorded.url.pathname !== "/health") expect(recorded.headers.get(CLAUDE_SETTINGS_HEADER), `${where} — 설정용 비밀값은 그대로`).toBe(FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
        }
        expect(consoleLines).toHaveLength(3);
        for (const line of consoleLines) expect(line.startsWith("screen-"), `${entry} — 옛 고정 낱말: ${line}`).toBe(false);
        expectLinesCarryRequestId(consoleLines, `${entry} · ${incoming.label}`, incoming);
      });
    }
  }

  for (const incoming of GIVEN_AND_NEW) {
    it(`POST /api/claude-usage/limits · ${incoming.label} — 지금 상한을 다시 읽는 호출에 싣지 않는다 · 결과 줄의 ID 자리는 그 요청의 값(진입이 따로 만든 값이 아니다)`, async () => {
      const requestHeaders = incoming.headers();
      const response = await inRequest(requestHeaders, () => claudeLimitsPost(formRequest("/api/claude-usage/limits", requestHeaders, "enabled=true")));
      expect(response.status).toBe(503);   // 지금 상한을 읽지 못해 바꾸지 않았다(실행 자리가 503)
      expect(recorder.calls.map((recorded) => `${recorded.method} ${recorded.url.origin}${recorded.url.pathname}`)).toEqual([`GET ${RUNNER_ORIGIN}/limits`]);
      expect(recorder.calls[0].headers.get("x-request-id")).toBeNull();
      expect(recorder.calls[0].headers.get("x-caller-service")).toBeNull();
      const lines = consoleLines.filter((line) => line.includes(":claude-limits:"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("claude-limits:limits_unreadable");
      expectLinesCarryRequestId(consoleLines, `상한 바꾸기 · ${incoming.label}`, incoming);
    });
  }
});

// ---- 쓰는 진입(POST) — 로그 줄의 ID 자리 · 재배포 접수의 호출 ----

describe("쓰는 진입 — 고정 낱말 대신 그 요청의 값이 로그 줄의 ID 자리에", () => {
  for (const incoming of GIVEN_AND_NEW) {
    it(`POST /api/deploys/redeploy(꼴이 틀린 본문) · ${incoming.label} — 줄 redeploy:malformed 의 ID 자리`, async () => {
      const requestHeaders = incoming.headers();
      const response = await inRequest(requestHeaders, () => redeployAcceptPost(formRequest("/api/deploys/redeploy", requestHeaders, "not a form", "text/plain")));
      expect(response.status).toBe(400);
      expect(recorder.calls).toEqual([]);
      expect(consoleLines.filter((line) => line.includes(":redeploy:malformed "))).toHaveLength(1);
      const id = expectLinesCarryRequestId(consoleLines, `재배포 접수(꼴) · ${incoming.label}`, incoming);
      expect(id).not.toBe("redeploy");
    });

    it(`POST /api/incidents/analysis(꼴이 틀린 본문) · ${incoming.label} — 줄 incident-analysis:malformed 의 ID 자리`, async () => {
      const requestHeaders = incoming.headers();
      const response = await inRequest(requestHeaders, () => incidentAnalysisPost(formRequest("/api/incidents/analysis", requestHeaders, "not a form", "text/plain")));
      expect(response.status).toBe(400);
      expect(recorder.calls).toEqual([]);
      expect(consoleLines.filter((line) => line.includes(":incident-analysis:malformed "))).toHaveLength(1);
      const id = expectLinesCarryRequestId(consoleLines, `분석 보내기(꼴) · ${incoming.label}`, incoming);
      expect(id).not.toBe("incident-analysis");
    });

    it(`POST /api/owner-mark(설정 없음) · ${incoming.label} — 줄 owner-mark:not_configured 의 ID 자리`, async () => {
      const requestHeaders = incoming.headers();
      const response = await inRequest(requestHeaders, () => ownerMarkSetPost(formRequest("/api/owner-mark", requestHeaders, "")));
      expect(response.status).toBe(503);
      expect(consoleLines.filter((line) => line.includes(":owner-mark:not_configured action=set "))).toHaveLength(1);
      const id = expectLinesCarryRequestId(consoleLines, `주인 표시 심기 · ${incoming.label}`, incoming);
      expect(id).not.toBe("owner-mark");
    });
  }

  it("POST /api/owner-mark/clear(설정 없음) — 줄 owner-mark:not_configured action=clear 의 ID 자리", async () => {
    const incoming = GIVEN_AND_NEW[0];
    const requestHeaders = incoming.headers();
    const response = await inRequest(requestHeaders, () => ownerMarkClearPost(formRequest("/api/owner-mark/clear", requestHeaders, "")));
    expect(response.status).toBe(503);
    expect(consoleLines.filter((line) => line.includes(":owner-mark:not_configured action=clear "))).toHaveLength(1);
    expectLinesCarryRequestId(consoleLines, "주인 표시 지우기", incoming);
  });
});

describe("재배포 접수(POST /api/deploys/redeploy) — 접수까지 가는 세 호출이 그 요청의 값 하나 · 접수 번호(일의 ID)는 본문에만", () => {
  for (const incoming of GIVEN_AND_NEW) {
    it(`${incoming.label} — 관측 서버의 판정 · 마스터의 이력 · 마스터의 접수(직접 fetch)`, async () => {
      const calls: RecordedCall[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const method = (init.method ?? "GET").toUpperCase();
        calls.push({ url, method, headers: new Headers(init.headers ?? {}), body: init.body ?? null });
        if (url.pathname === "/auth/attempts") return jsonBody({ success: true, data: { allowed: true, outcome: "success", locked_until: null, lock_started: false, failures: 0 } });
        if (url.pathname === "/deploys") {
          return jsonBody({ success: true, data: { deployments: [
            { request_id: "deployed-1", service: "backend", commit_sha: SHA, state: "succeeded", accepted_at: "2026-11-22T02:00:00Z", finished_at: "2026-11-22T02:05:00Z", ci_ms: 60000, cd_ms: 30000 },
          ] } });
        }
        if (url.pathname === "/deploy" && method === "POST") {
          const sent = JSON.parse(String(init.body)) as { request_id: string };
          return jsonBody({ success: true, data: { request_id: sent.request_id, service: "backend", state: "ci_running" } }, 202);
        }
        return jsonBody({ success: false, error: { code: "unavailable" } }, 503);
      }));
      const jobId = newRedeployRequestId();
      const confirmation = issueRedeployConfirmation(FAKE_SIGNING_KEY, { service: "backend", commitSha: SHA, requestId: jobId, issuedAt: Date.now(), account: FAKE_ADMIN_ID });
      const body = new URLSearchParams({ service: "backend", commit: SHA, confirmation, password: FAKE_PASSWORD }).toString();
      const requestHeaders = incoming.headers();
      const response = await inRequest(requestHeaders, () => redeployAcceptPost(formRequest("/api/deploys/redeploy", requestHeaders, body)));
      expect(response.status).toBe(303);
      expect(calls.map((call) => `${call.method} ${call.url.origin}${call.url.pathname}`)).toEqual([
        `POST ${FAKE_OBSERVE_URL}/auth/attempts`, `GET ${FAKE_DEPLOY_MASTER_URL}/deploys`, `POST ${FAKE_DEPLOY_MASTER_URL}/deploy`,
      ]);
      const id = calls[0].headers.get("x-request-id");
      if (incoming.expected !== null) expect(id).toBe(incoming.expected);
      else expect(id).toMatch(NEW_ID);
      for (const call of calls) {
        const where = `${call.method} ${call.url.origin}${call.url.pathname}`;
        expect(call.headers.get("x-request-id"), `${where} — 정확히 하나 · 그 요청의 값`).toBe(id);
        expect(call.headers.get("x-caller-service"), `${where} — 호출자 머리글`).toBe("admin");
        expect(call.headers.get(SECRET_BY_ORIGIN.get(call.url.origin)!), `${where} — 비밀값은 그대로`).not.toBeNull();
      }
      // 접수의 본문 · 메서드는 그대로 — 접수 번호(일의 ID)는 본문에만 있고 머리글의 추적 ID 와 다른 값이다
      const accept = calls[2];
      expect(JSON.parse(String(accept.body))).toEqual({ service: "backend", commit_sha: SHA, request_id: jobId, requested_by: `admin:${FAKE_ADMIN_ID}` });
      expect(accept.headers.get("content-type")).toContain("application/json");
      expect(accept.headers.get("x-request-id")).not.toBe(jobId);
    });
  }
});

describe("브라우저 쪽 코드는 요청 ID 모듈을 가져오지 않는다(서버 전용)", () => {
  it.each([
    "../features/auth/ui/LoginForm.tsx", "../features/auth/ui/LogoutButton.tsx",
    "../features/traffic-map/ui/TrafficMapLive.tsx", "../features/traffic-map/lib/traffic-map-stream-state.ts",
  ])("%s", (relativePath) => {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
    expect(source).not.toContain("@/shared/lib/request-id");
  });
});
