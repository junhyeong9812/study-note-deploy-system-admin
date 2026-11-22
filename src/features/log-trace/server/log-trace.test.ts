/** 연관 로그 데이터 경로 — GET /api/logs/trace(Route Handler → server/ 진입). 명세 ② 인증 경계 · "비밀값은 서버 쪽에만" · §11.2.
 * 전역 fetch 를 가짜로 바꾼다(실제 관측 · master · 알림 서버를 부르지 않는다). 사례마다 모듈을 새로 읽는다(vi.resetModules). */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookieValue !== undefined && name === "admin_session" ? { name, value: state.cookieValue } : undefined),
    has: () => state.cookieValue !== undefined,
    getAll: () => [],
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import { SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  MINUTE, SELECTED_LOG_ID, SELECTED_MILLISECONDS, alertCalls, alertHandlerFor, alertIncident, createFakeObserveLogs, createTraceFetch, fakeLogLine,
  logEntryView, masterCalls, masterDeployment, masterHandlerFor, observeCalls, type FakeLogLine,
} from "@/features/log-trace/lib/log-trace-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, UPSTREAM_RAW_MARKER,
  expectNoForbiddenText, leakyErrorBody, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const T = SELECTED_MILLISECONDS;
const TRACE_PATH = "/api/logs/trace";
const SCRIPT_MESSAGE = `<script>alert("x")</script>\n</pre><img src=x onerror=1> & 끝`;

const SELECTED_LINE = fakeLogLine({ message: SCRIPT_MESSAGE });
const LINES: FakeLogLine[] = [
  fakeLogLine({ milliseconds: T - 1_000, sequence: 0, level: "info", service: "front", message: "GET /api/notes" }),
  SELECTED_LINE,
];

let observeHandler: RoutedFetchHandler = createFakeObserveLogs(LINES).handler;
let masterHandler: RoutedFetchHandler = masterHandlerFor([masterDeployment()]);
let alertHandler: RoutedFetchHandler = alertHandlerFor([alertIncident()]);

const networkFetch = createTraceFetch({
  observe: (url, init) => observeHandler(url, init),
  master: (url, init) => masterHandler(url, init),
  alert: (url, init) => alertHandler(url, init),
});

const consoleLines: string[] = [];

async function callTrace(search: string): Promise<Response> {
  const route = await import("@/app/api/logs/trace/route");
  return route.GET(new Request(new URL(`${TRACE_PATH}${search}`, FAKE_ORIGIN)));
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("ALERT_URL", FAKE_ALERT_URL);
  vi.stubEnv("ALERT_SECRET", FAKE_ALERT_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  observeHandler = createFakeObserveLogs(LINES).handler;
  masterHandler = masterHandlerFor([masterDeployment()]);
  alertHandler = alertHandlerFor([alertIncident()]);
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  consoleLines.length = 0;
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("인증 경계", () => {
  it.each([
    ["쿠키 없음", () => undefined],
    ["잘못된 서명", () => issueSessionToken("fake-other-signing-key-for-tests-0000000000", Date.now())],
    ["만료", () => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
  ])("%s → 401, 다른 서버를 부르지 않는다", async (_label, makeCookie) => {
    state.cookieValue = makeCookie();
    const response = await callTrace(`?selected=${SELECTED_LOG_ID}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: { code: "unauthorized" } });
    expect(networkFetch).not.toHaveBeenCalled();
  });
});

describe("입력 거절 → 422 invalid_input(selected), 호출 0회", () => {
  it.each([
    ["없음", ""],
    ["빈 값", "?selected="],
    ["여러 번", `?selected=${SELECTED_LOG_ID}&selected=${SELECTED_LOG_ID}`],
    ["형식 밖", "?selected=abc"],
    ["순번 없음", `?selected=${T}-`],
    ["밀리초 16자리", "?selected=1234567890123456-1"],
    ["스크립트", `?selected=${encodeURIComponent("<script>")}`],
    ["상위 이동", `?selected=${encodeURIComponent("../logs")}`],
  ])("%s → 422 · no-store", async (_label, search) => {
    const response = await callTrace(search);
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: false, error: { code: "invalid_input", field: "selected" } });
    expect(networkFetch).not.toHaveBeenCalled();
  });
});

describe("고른 로그 없음 → 404", () => {
  it("관측 서버에 그 id 가 없으면 404 not_found · no-store · 연관 로그를 부르지 않는다", async () => {
    observeHandler = createFakeObserveLogs([LINES[0]]).handler;
    const response = await callTrace(`?selected=${SELECTED_LOG_ID}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: false, error: { code: "not_found" } });
    expect(observeCalls(networkFetch).some(([input]) => new URL(input).searchParams.get("request_id") !== null)).toBe(false);
  });
});

describe("정상 — 200 응답의 꼴", () => {
  it("네 구역 · 필요한 칸만 · no-store · 비밀값 · 주소 · 원문 없음", async () => {
    const response = await callTrace(`?selected=${SELECTED_LOG_ID}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.success).toBe(true);
    const data = body.data;
    expect(Object.keys(data).sort()).toEqual(["query", "relatedLogs", "requestSummary", "selected", "serverState"]);
    expect(data.query).toEqual({ selectedLogId: SELECTED_LOG_ID, selectedAtMilliseconds: T });
    expect(data.selected).toEqual({ ok: true, value: logEntryView(SELECTED_LINE) });
    expect(data.relatedLogs.value.lines.map((line: { id: string }) => line.id)).toEqual([`${T - 1_000}-0`, SELECTED_LOG_ID]);
    expect(data.requestSummary.value).toMatchObject({ services: ["front", "backend"], lineCount: 2, durationMilliseconds: 1_000, highestLevel: "error" });
    expect(Object.keys(data.serverState).sort()).toEqual(["deployments", "incidents", "levelCounts"]);
    expect(data.serverState.deployments.value.deployments).toHaveLength(1);
    expect(data.serverState.incidents.value.incidents).toHaveLength(1);
    expectNoForbiddenText(body);
    expect(JSON.stringify(body)).not.toContain("build output");
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });

  it("<script> 가 든 메시지는 JSON 안에서 글자 그대로(변형 · 해석 없음)", async () => {
    const body = await (await callTrace(`?selected=${SELECTED_LOG_ID}`)).json();
    expect(body.data.selected.value.message).toBe(SCRIPT_MESSAGE);
    expect(body.data.relatedLogs.value.lines[1].message).toBe(SCRIPT_MESSAGE);
  });

  it("세 출처를 각자의 비밀 헤더로 부른다 — 관측 4 · master 1 · 알림 1, 전부 GET", async () => {
    await callTrace(`?selected=${SELECTED_LOG_ID}`);
    expect(observeCalls(networkFetch)).toHaveLength(4);
    expect(masterCalls(networkFetch)).toHaveLength(1);
    expect(alertCalls(networkFetch)).toHaveLength(1);
    for (const [, init] of networkFetch.mock.calls) {
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
      expect(init?.redirect).toBe("manual");
    }
  });
});

describe("한 출처가 실패해도 200 · 그 칸만 가린 이유", () => {
  it("관측 서버 실패 → selected · relatedLogs · requestSummary · levelCounts 실패, 배포 · 알림은 값", async () => {
    observeHandler = () => textResponse(leakyErrorBody(), 503);
    const response = await callTrace(`?selected=${SELECTED_LOG_ID}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    for (const cell of [body.data.selected, body.data.relatedLogs, body.data.requestSummary, body.data.serverState.levelCounts]) {
      expect(cell).toEqual({ ok: false, reason: "unavailable", status: 503, message: "서버 일시 장애" });
    }
    expect(body.data.serverState.deployments.ok).toBe(true);
    expect(body.data.serverState.incidents.ok).toBe(true);
    expectNoForbiddenText(body);
  });

  it("master 실패 → deployments 만", async () => {
    masterHandler = () => textResponse(leakyErrorBody(), 500);
    const body = await (await callTrace(`?selected=${SELECTED_LOG_ID}`)).json();
    expect(body.data.serverState.deployments).toMatchObject({ ok: false, reason: "bad_status", status: 500 });
    expect(body.data.selected.ok).toBe(true);
    expect(body.data.serverState.incidents.ok).toBe(true);
    expectNoForbiddenText(body);
  });

  it("알림 서버 연결 실패 → incidents 만", async () => {
    alertHandler = () => { throw new TypeError(`fetch failed ${UPSTREAM_RAW_MARKER} ${FAKE_ALERT_URL} ${FAKE_ALERT_SECRET}`); };
    const body = await (await callTrace(`?selected=${SELECTED_LOG_ID}`)).json();
    expect(body.data.serverState.incidents).toMatchObject({ ok: false, reason: "unreachable" });
    expect(body.data.serverState.deployments.ok).toBe(true);
    expect(body.data.relatedLogs.ok).toBe(true);
    expectNoForbiddenText(body);
  });

  it("실패한 칸은 앱 로그 1줄 이상(이유 낱말 · 상태 코드만 — 비밀값 · 주소 · 원문 없음)", async () => {
    masterHandler = () => textResponse(leakyErrorBody(), 503);
    alertHandler = () => textResponse(leakyErrorBody(), 401);
    await callTrace(`?selected=${SELECTED_LOG_ID}`);
    const joined = consoleLines.join("\n");
    expect(joined).toContain("upstream=unavailable");
    expect(joined).toContain("upstream=unauthorized");
    expectNoForbiddenText(joined);
  });
});

describe("설정 없음 — 그 출처의 칸만 not_configured, 호출 없음", () => {
  it.each([
    ["OBSERVE_URL", "observe"], ["OBSERVE_SECRET", "observe"], ["DEPLOY_MASTER_URL", "master"], ["DEPLOY_SECRET", "master"],
    ["ALERT_URL", "alert"], ["ALERT_SECRET", "alert"],
  ] as const)("%s 가 비면 %s 의 칸만", async (key, source) => {
    vi.stubEnv(key, "");
    const response = await callTrace(`?selected=${SELECTED_LOG_ID}`);
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    const notConfigured = { ok: false, reason: "not_configured", message: "설정 없음" };
    if (source === "observe") {
      expect(data.selected).toEqual(notConfigured);
      expect(data.serverState.levelCounts).toEqual(notConfigured);
      expect(observeCalls(networkFetch)).toHaveLength(0);
      expect(data.serverState.deployments.ok).toBe(true);
    } else if (source === "master") {
      expect(data.serverState.deployments).toEqual(notConfigured);
      expect(masterCalls(networkFetch)).toHaveLength(0);
      expect(data.selected.ok).toBe(true);
    } else {
      expect(data.serverState.incidents).toEqual(notConfigured);
      expect(alertCalls(networkFetch)).toHaveLength(0);
      expect(data.selected.ok).toBe(true);
    }
  });

  it("주소가 http(s) 로 해석되지 않아도 설정 없음", async () => {
    vi.stubEnv("ALERT_URL", "ftp://alert.example.test");
    const data = (await (await callTrace(`?selected=${SELECTED_LOG_ID}`)).json()).data;
    expect(data.serverState.incidents).toMatchObject({ ok: false, reason: "not_configured" });
    expect(alertCalls(networkFetch)).toHaveLength(0);
  });
});

describe("화면용 진입 loadLogTrace", () => {
  it("세션이 없으면 /login 으로 보낸다 · 다른 서버를 부르지 않는다", async () => {
    state.cookieValue = undefined;
    const { loadLogTrace } = await import("@/features/log-trace/server/log-trace");
    await expect(loadLogTrace({ selected: SELECTED_LOG_ID })).rejects.toThrow("redirect:/login");
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("입력이 틀리면 invalid_input(selected) · 호출 없음", async () => {
    const { loadLogTrace } = await import("@/features/log-trace/server/log-trace");
    expect(await loadLogTrace({ selected: "abc" })).toEqual({ kind: "invalid_input", field: "selected" });
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("없는 id → not_found · 있으면 view(데이터 경로와 같은 조립)", async () => {
    const { loadLogTrace } = await import("@/features/log-trace/server/log-trace");
    expect(await loadLogTrace({ selected: `${T}-9` })).toEqual({ kind: "not_found" });
    const outcome = await loadLogTrace({ selected: SELECTED_LOG_ID });
    expect(outcome.kind).toBe("view");
    if (outcome.kind === "view") expect(outcome.view.selected).toEqual({ ok: true, value: logEntryView(SELECTED_LINE) });
  });

  it("창의 기준은 id 의 시각 — 배포 창은 T±30분", async () => {
    const { loadLogTrace } = await import("@/features/log-trace/server/log-trace");
    const outcome = await loadLogTrace({ selected: SELECTED_LOG_ID });
    if (outcome.kind !== "view") throw new Error("expected view");
    expect(outcome.view.serverState.deployments).toMatchObject({
      ok: true, value: { from: new Date(T - 30 * MINUTE).toISOString(), to: new Date(T + 30 * MINUTE).toISOString() },
    });
  });
});

describe("소스 검사 — 진입은 server-only · 세션 검증, lib 는 순수, 화면은 lib 를 직접 쓰지 않는다", () => {
  const featureDirectory = fileURLToPath(new URL("..", import.meta.url));
  const sourceDirectory = fileURLToPath(new URL("../../..", import.meta.url));

  function sourceFiles(directory: string): string[] {
    if (!existsSync(directory)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) files.push(...sourceFiles(fullPath));
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) && !/test-fakes\.ts$/.test(entry)) files.push(fullPath);
    }
    return files;
  }

  it("server/ 진입 모듈 — server-only · requireApiSession · requireSession", () => {
    const files = sourceFiles(join(featureDirectory, "server"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/^import "server-only";/m);
      expect(source).toMatch(/\brequireApiSession\s*\(/);
      expect(source).toMatch(/\brequireSession\s*\(/);
    }
  });

  it("lib/ — 설정 · 환경 변수 · Next · server-only · server/ 를 읽지 않는다", () => {
    const files = sourceFiles(join(featureDirectory, "lib"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/process\.env/);
      for (const match of source.matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)) {
        expect(match[1], file).not.toBe("server-only");
        expect(match[1], file).not.toMatch(/^next(\/|$)/);
        expect(match[1], file).not.toBe("@/shared/config/server-config");
        expect(match[1], file).not.toMatch(/\/server\//);
      }
    }
  });

  it("src/app 은 log-trace 의 lib 를 값으로 임포트하지 않는다(server/ · ui/ 만)", () => {
    const appFiles = sourceFiles(join(sourceDirectory, "app"));
    expect(appFiles.length).toBeGreaterThan(0);
    for (const file of appFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/^\s*import\s+(?!type\b)[^;]*?\s+from\s+["'](@\/features\/log-trace\/[^"']+)["']/gm)) {
        expect(match[1], file).toMatch(/^@\/features\/log-trace\/(server|ui)\//);
      }
      expect(source, file).not.toMatch(/\bcreateIncidentClient\b|\bbuildLogTrace\b/);
    }
  });

  it("route.ts 는 진입 모듈을 쓴다", () => {
    const routeSource = readFileSync(join(sourceDirectory, "app", "api", "logs", "trace", "route.ts"), "utf8");
    expect(routeSource).toContain(`from "@/features/log-trace/server/`);
  });
});
