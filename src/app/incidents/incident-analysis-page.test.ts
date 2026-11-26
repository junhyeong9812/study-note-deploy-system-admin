/** 분석 — 화면(GET /incidents/analysis) · 보내기(POST /api/incidents/analysis)를 실제 렌더와 진입 함수로(명세 ⑫ §19 · §2).
 * 가짜: 알림 · 관측 · 배포 마스터 · 실행 자리(전역 fetch — 실제 응답 꼴) · Redis(vi.mock("ioredis") → FakeIoRedis — 모든 연결이 한 상태를 본다).
 * 계약:
 * - 두 걸음: `/incidents/analysis?incident=<id>` 은 저장된 분석과 "분석 요청" 링크만(목록의 네 호출 · Redis 읽기 — 근거 · 실행 자리 호출 없음) →
 *   `&preview=1` 은 보낼 글 그대로(가린 뒤 · 자른 뒤)와 서명 값을 실은 폼(근거 호출 · 배포 실패면 출력 조회 — 실행 자리 · Redis 쓰기 없음) →
 *   POST(폼: incident · preview · prompt)만 보낸다. 미리본 글과 한 바이트라도 다르면 409(부르지 않는다) · 10분 지난 미리보기 409 ·
 *   보내는 글은 POST 로 받은 글 그대로(서명이 맞을 때 — 다시 만들지 않는다: 그 사이 근거가 바뀌어도 사람이 본 글을 보낸다).
 * - POST 의 차례: 출처(403 JSON) → 세션(401 JSON) → 본문(urlencoded · 1MB · UTF-8 · 칸마다 하나 · 식별자의 꼴 — 아니면 400 HTML) → 서명(꼴 400 · 다름 409 · 지남 409)
 *   → 설정(실행 자리 주소 · 호출 비밀값 CLAUDE_RUNNER_SECRET · 저장소 LOG_REDIS_URL — 없으면 503) → 그 문제가 아직 열려 있는가(목록 네 호출 — 닫힘 · 확인하지 못함 409)
 *   → 시작(Redis 에 닿지 못하면 503 · 부르지 않는다)
 *   → 303 `/incidents/analysis?incident=<id>`(진행 중이 있으면 새로 부르지 않고 같은 303). GET 은 없다.
 * - 닫힌 문제 · 확인하지 못한 문제 · 틀린 식별자 — 미리보기 · 폼이 없다(근거 호출 없음).
 * - 실행 자리의 실패 · 답의 꼴이 틀림은 화면에 저마다의 고정 글(실행 자리의 글 · 주소 없음).
 * - 새지 않는다: 응답 · 화면 · 로그 · Redis 의 값에 실행 자리 · 배포 마스터의 주소 · 비밀값이 없다 · 로그에 보낸 글 · 답의 내용이 없다.
 * - 종료(SIGTERM 의 본체 logQueueOnShutdown)는 도는 분석의 수를 한 줄로 — 기록은 running 으로 남아 5분 뒤 끊김으로 보인다. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => false }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    has: (name: string) => cookieJar.has(name),
    getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));
vi.mock("ioredis", async () => {
  const fakes = await import("@/features/incident-analysis/lib/analysis-test-fakes");
  return { default: fakes.FakeIoRedis, Redis: fakes.FakeIoRedis };
});

import IncidentAnalysisPage from "@/app/incidents/analysis/page";
import IncidentsPage from "@/app/incidents/page";
import * as analysisRoute from "@/app/api/incidents/analysis/route";
import { SESSION_COOKIE_NAME, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD_HASH, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { register } from "@/instrumentation";
import { logQueueOnShutdown } from "@/features/auth/server/shutdown-logging";
import { FAKE_CLAUDE_RUNNER_URL } from "@/features/claude-usage/lib/claude-runner-test-fakes";
import {
  CLAUDE_CALL_SECRET_HEADER, FAKE_CLAUDE_RUNNER_CALL_SECRET, FAKE_LOG_REDIS_URL, FAKE_TOKENS, SHARED_FAKE_REDIS_STATE, everythingStored, fakeCharacters,
  resetFakeRedisState, runnerFailureBody, runnerSuccessBody, validRunnerAnswer,
} from "@/features/incident-analysis/lib/analysis-test-fakes";
import { ANALYSIS_FAILURE_TEXTS, INCIDENT_ANALYSIS_TEXT } from "@/features/incident-analysis/lib/incident-analysis-screen";
import { ANALYSIS_RUNNING_LIMIT_MILLISECONDS, incidentAnalysisKeys, type StoredAnalysisAttempt } from "@/features/incident-analysis/lib/incident-analysis-service";
import {
  INCIDENT_ANALYSIS_BODY_MAX_BYTES, existingIncidentAnalysisService, resetIncidentAnalysisService,
} from "@/features/incident-analysis/server/incident-analysis";
import { deployIncidentId, monitorIncidentId } from "@/features/incidents/lib/incident-id";
import {
  MINUTE, NOW, alertRecordRow, alertRecordsBody, deploymentRow, deploymentsBody, emptySeriesBody, firingRow, iso, latestBody, latestServerRow, logRow, logsBody,
  monitorsBody, seenContainersBody,
} from "@/features/incidents/lib/incidents-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, FORBIDDEN_IN_RESULTS,
  createRoutedFetch, headersOf, jsonBody, leakyErrorBody, textResponse,
} from "@/shared/lib/upstream-test-fakes";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

const DOWN_AT = NOW - 20 * MINUTE;
const FRONT = monitorIncidentId("front");
const DEPLOY = deployIncidentId("backend", "req-failed-1");
/** 근거의 로그에 심은 비밀값 · 표식 — 보낸 글에서는 가려지고, 로그에는 어느 것도 나오면 안 된다. */
const LOG_SECRET = `Zq81${fakeCharacters(71, 14)}`;
const LOG_MARK = "근거-로그-표식-G4";
const ANSWER_MARK = "답-원인-표식-R2";
const OUTPUT_SECRET = `Zq81${fakeCharacters(72, 14)}`;
/** 결과 · 화면 · 로그 · Redis 어디에도 나오면 안 되는 글자. */
const FORBIDDEN = [
  ...FORBIDDEN_IN_RESULTS, FAKE_CLAUDE_RUNNER_CALL_SECRET, "claude-runner.example.test", "X-Claude-Runner-Secret", CLAUDE_CALL_SECRET_HEADER,
  "redis.example.test", LOG_SECRET, OUTPUT_SECRET, FAKE_TOKENS.github,
];

let overrides: Record<string, Handler> = {};
let runnerResponder: () => Response | Promise<Response> = () => jsonBody(runnerSuccessBody(validRunnerAnswer({ cause: `원인 ${ANSWER_MARK}` })));
const runnerCalls: { body: Record<string, unknown>; headers: Headers }[] = [];
const consoleLines: string[] = [];
/** 사례가 붙잡아 둔 실행 자리의 답 — 단언이 먼저 실패해도 afterEach 가 풀어 준다. */
const pendingReleases: (() => void)[] = [];

const ROUTES: Record<string, Handler> = {
  [`${FAKE_ALERT_URL}/monitors`]: () => jsonBody(monitorsBody([
    { name: "front", status: "DOWN", down_since: iso(DOWN_AT), reason: "status 502" }, { name: "backend", status: "UP", down_since: "", reason: "" },
  ])),
  [`${FAKE_ALERT_URL}/incidents`]: () => jsonBody(alertRecordsBody([alertRecordRow({ at: iso(DOWN_AT), kind: "monitor_down", key: "front", title: "응답 없음: front" })])),
  [`${FAKE_OBSERVE_URL}/metrics/latest`]: () => jsonBody(latestBody([latestServerRow("s158", [["front-app-green", "front-app"], ["backend-app-blue", "backend-app"]])], [])),
  [`${FAKE_OBSERVE_URL}/metrics/containers`]: (url) => jsonBody(seenContainersBody(url.searchParams.get("server")!, Date.parse(url.searchParams.get("at")!), ["front-app", "backend-app"])),
  [`${FAKE_OBSERVE_URL}/metrics/series`]: (url) => jsonBody(emptySeriesBody(url.searchParams)),
  [`${FAKE_OBSERVE_URL}/logs`]: (url) => {
    const parameters = url.searchParams;
    const rows = parameters.get("service") === "front" && parameters.get("level") === "error"
      ? [logRow({ id: `${DOWN_AT + MINUTE}-0`, at: iso(DOWN_AT + MINUTE), level: "error", service: "front", message: `${LOG_MARK} DB_PASSWORD=${LOG_SECRET} token ${FAKE_TOKENS.github}` })]
      : [];
    return jsonBody(logsBody(rows, parameters.get("from")!, parameters.get("to")!));
  },
  [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: () => jsonBody(deploymentsBody([
    deploymentRow({ request_id: "req-failed-1", service: "backend", state: "failed", failed_stage: "ci_test", commit_sha: "b".repeat(40), accepted_at: iso(NOW - 40 * MINUTE), finished_at: iso(NOW - 30 * MINUTE) }),
    deploymentRow({ request_id: "req-ok-1", service: "backend", state: "succeeded", commit_sha: "c".repeat(40), accepted_at: iso(NOW - 3 * 60 * MINUTE) }),
  ])),
  [`${FAKE_DEPLOY_MASTER_URL}/deploys/git/commits`]: () => jsonBody({ success: true, data: { commits: [], truncated: false, range_complete: true, relation: "ancestor" } }),
  [`${FAKE_DEPLOY_MASTER_URL}/deploys/req-failed-1/output`]: () => jsonBody({ success: true, data: {
    request_id: "req-failed-1", service: "backend", commit_sha: "b".repeat(40), failed_stage: "ci_test", recorded_at: "2026-11-25T05:30:00.123456789Z",
    output: `go test ./...\nAPI_TOKEN=${OUTPUT_SECRET}\npassword=[가림:secret_field]\n--- FAIL: TestPool`, truncated: false, omitted_bytes: 0, bytes: 90, redactions: { secret_field: 1 },
  } }),
  [`${FAKE_CLAUDE_RUNNER_URL}/runs`]: (_url, init) => {
    runnerCalls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: headersOf(init) });
    return runnerResponder();
  },
};

const upstreamFetch = createRoutedFetch((url, init) => {
  const key = `${url.origin}${url.pathname}`;
  const route = overrides[key] ?? ROUTES[key];
  if (!route) throw new Error(`unexpected ${url.pathname}`);
  return route(url, init);
});

function calledPaths(): string[] {
  return upstreamFetch.mock.calls.map(([input]) => new URL(String(input)).pathname);
}

async function renderPage(searchParams: Record<string, string>): Promise<string> {
  const element = await IncidentAnalysisPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
}

function textOf(html: string): string {
  return unescapeHtml(html.replace(/<[^>]+>/g, ""));
}

/** 미리보기 화면의 폼 칸 셋. */
function formFields(html: string): { incident: string; preview: string; prompt: string } {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(html);
  expect(form, "폼이 없다").not.toBeNull();
  const value = (name: string) => {
    const tag = [...form![1].matchAll(/<input\b([^>]*)\/?>/g)].map((match) => match[1]).find((attributes) => attributes.includes(`name="${name}"`));
    expect(tag, name).toBeDefined();
    return unescapeHtml(/value="([^"]*)"/.exec(tag!)![1]);
  };
  return { incident: value("incident"), preview: value("preview"), prompt: value("prompt") };
}

function postRequest(fields: Record<string, string> | URLSearchParams, init: { origin?: string | null; contentType?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": init.contentType ?? "application/x-www-form-urlencoded" };
  if (init.origin !== null) headers.origin = init.origin ?? FAKE_ORIGIN;
  const body = fields instanceof URLSearchParams ? fields : new URLSearchParams(fields);
  return new Request(new URL("/api/incidents/analysis", FAKE_ORIGIN), { method: "POST", headers, body: body.toString() });
}

async function post(fields: Record<string, string> | URLSearchParams, init: Parameters<typeof postRequest>[1] = {}): Promise<Response> {
  const response = await analysisRoute.POST(postRequest(fields, init));
  await existingIncidentAnalysisService()?.whenIdle();
  return response;
}

async function previewFields(incidentId = FRONT) {
  return formFields(await renderPage({ incident: incidentId, preview: "1" }));
}

function storedAttempts(incidentId = FRONT): StoredAnalysisAttempt[] {
  const keys = incidentAnalysisKeys(incidentId);
  const ids = SHARED_FAKE_REDIS_STATE.lists.get(keys.history)?.items ?? [];
  return ids.map((id) => JSON.parse(SHARED_FAKE_REDIS_STATE.strings.get(keys.attempt(id))!.value) as StoredAnalysisAttempt);
}

function redisWrites(): string[] {
  return SHARED_FAKE_REDIS_STATE.commands.filter((command) => /^(set|lpush|ltrim|pexpire|del) /.test(command));
}

function expectNothingLeaked(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const word of FORBIDDEN) expect(text, `${word} 가 새었다`).not.toContain(word);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries({
    SESSION_SECRET: FAKE_SIGNING_KEY, ADMIN_ORIGIN: FAKE_ORIGIN, ADMIN_USER: FAKE_ADMIN_ID, ALERT_URL: FAKE_ALERT_URL, ALERT_SECRET: FAKE_ALERT_SECRET,
    OBSERVE_URL: FAKE_OBSERVE_URL, OBSERVE_SECRET: FAKE_OBSERVE_SECRET, BACKEND_URL: FAKE_BACKEND_URL, DEPLOY_MASTER_URL: FAKE_DEPLOY_MASTER_URL,
    DEPLOY_SECRET: FAKE_DEPLOY_SECRET, CLAUDE_RUNNER_URL: FAKE_CLAUDE_RUNNER_URL, CLAUDE_RUNNER_SECRET: FAKE_CLAUDE_RUNNER_CALL_SECRET,
    CLAUDE_RUNNER_SETTINGS_SECRET: "fake-claude-settings-secret-marker-c74", LOG_REDIS_URL: FAKE_LOG_REDIS_URL,
  })) vi.stubEnv(name, value);
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, NOW - 60_000));
  overrides = {};
  runnerResponder = () => jsonBody(runnerSuccessBody(validRunnerAnswer({ cause: `원인 ${ANSWER_MARK}` })));
  runnerCalls.length = 0;
  consoleLines.length = 0;
  resetFakeRedisState(SHARED_FAKE_REDIS_STATE);
  resetIncidentAnalysisService();
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(async () => {
  for (const release of pendingReleases.splice(0)) release();
  await existingIncidentAnalysisService()?.whenIdle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("첫 걸음 — 화면은 저장된 것만, 미리보기는 보낼 글 그대로", () => {
  it("분석 화면 — 목록의 네 호출뿐(근거 · 실행 자리 없음) · 아직 분석 없음 · 요청 링크", async () => {
    const html = await renderPage({ incident: FRONT });
    expect(calledPaths().sort()).toEqual(["/deploys", "/logs", "/metrics/latest", "/monitors"]);
    expect(textOf(html)).toContain(INCIDENT_ANALYSIS_TEXT.noAnalysis);
    expect(textOf(html)).toContain(INCIDENT_ANALYSIS_TEXT.disclaimer);
    expect(html).toContain('href="/incidents/analysis?incident=monitor%3Afront&amp;preview=1"');
    expect(redisWrites()).toEqual([]);
    expect(runnerCalls).toEqual([]);
  });

  it("미리보기 — 근거를 모아 가린 뒤 자른 글 · 실행 자리를 부르지 않고 Redis 에 쓰지 않는다", async () => {
    const html = await renderPage({ incident: FRONT, preview: "1" });
    const fields = formFields(html);
    expect(fields.incident).toBe(FRONT);
    expect(fields.preview).toMatch(/^ap2\.\d+\.(-|s[A-Za-z0-9_-]*)\.[A-Za-z0-9_-]{43}$/);
    expect(fields.prompt).toContain(LOG_MARK);
    expect(fields.prompt).toContain("DB_PASSWORD=[가림:secret_field]");
    expect(fields.prompt).not.toContain(LOG_SECRET);
    expect(fields.prompt).not.toContain(FAKE_TOKENS.github);
    expect(fields.prompt.split("\n").filter((line) => /^<<<자료 (시작|끝) [0-9a-f]{32}>>>$/.test(line))).toHaveLength(2);
    const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html);
    expect(unescapeHtml(pre![1])).toBe(fields.prompt);
    expect(textOf(html)).toContain(`${new TextEncoder().encode(fields.prompt).length}바이트 · ${Array.from(fields.prompt).length}자`);
    expect(calledPaths()).toContain("/incidents");
    expect(runnerCalls).toEqual([]);
    expect(redisWrites()).toEqual([]);
    expectNothingLeaked(html);
  });

  it("미리보기의 표지는 요청마다 다르다", async () => {
    const first = await previewFields();
    const second = await previewFields();
    const boundary = (prompt: string) => /<<<자료 시작 ([0-9a-f]{32})>>>/.exec(prompt)![1];
    expect(boundary(first.prompt)).not.toBe(boundary(second.prompt));
  });

  it.each([
    ["닫힌 문제(UP)", { incident: monitorIncidentId("backend"), preview: "1" }, INCIDENT_ANALYSIS_TEXT.closed],
    ["확인하지 못한 문제(감시 대상 출처 실패)", { incident: FRONT, preview: "1" }, INCIDENT_ANALYSIS_TEXT.unchecked],
  ])("%s — 미리보기 · 폼이 없고 근거를 모으지 않는다", async (label, searchParams, text) => {
    if (label.startsWith("확인하지")) overrides[`${FAKE_ALERT_URL}/monitors`] = () => textResponse("", 503);
    const html = await renderPage(searchParams);
    expect(textOf(html)).toContain(text);
    expect(html).not.toContain("<form");
    expect(calledPaths()).not.toContain("/incidents");
    expect(runnerCalls).toEqual([]);
  });

  it("틀린 식별자 — 입력 거절 · 다른 서버를 부르지 않는다", async () => {
    const html = await renderPage({ incident: "monitor:<script>", preview: "1" });
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("둘째 걸음 — 미리본 글 그대로를 보낸다", () => {
  it("POST → 303 분석 화면 · 실행 자리에 미리본 글과 바이트까지 같은 글 한 번 · 보낸 글 그대로를 저장 · 다시 열면 결과(부르지 않는다)", async () => {
    const fields = await previewFields();
    const response = await post(fields);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/incidents/analysis?incident=monitor%3Afront");
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0].body).toEqual({ purpose: "analysis", prompt: fields.prompt, request_id: expect.stringMatching(/^[A-Za-z0-9._-]{1,64}$/) });
    expect(new TextEncoder().encode(String(runnerCalls[0].body.prompt))).toEqual(new TextEncoder().encode(fields.prompt));
    expect(runnerCalls[0].headers.get(CLAUDE_CALL_SECRET_HEADER)).toBe(FAKE_CLAUDE_RUNNER_CALL_SECRET);
    const [stored] = storedAttempts();
    expect(stored).toMatchObject({ state: "succeeded", prompt: fields.prompt, incidentId: FRONT, incidentSince: iso(DOWN_AT), account: `admin:${FAKE_ADMIN_ID}` });
    const html = await renderPage({ incident: FRONT });
    expect(textOf(html)).toContain(`원인 ${ANSWER_MARK}`);
    expect(textOf(html)).toContain("되돌리기를 권함");
    expect(runnerCalls).toHaveLength(1);
  });

  it("두 번 누름(같은 폼을 동시에 두 번) — 하나는 303, 하나는 409 이미 보낸 미리보기 · 실행 자리는 한 번", async () => {
    const fields = await previewFields();
    let release: () => void = () => undefined;
    pendingReleases.push(() => release());   // 단언이 먼저 실패해도 afterEach 가 뒤에서 도는 분석을 풀어 준다
    runnerResponder = () => new Promise((resolve) => { release = () => resolve(jsonBody(runnerSuccessBody())); });
    const responses = await Promise.all([analysisRoute.POST(postRequest(fields)), analysisRoute.POST(postRequest(fields))]);
    expect(responses.map((response) => response.status).sort()).toEqual([303, 409]);
    expect(textOf(await responses.find((response) => response.status === 409)!.text())).toContain(INCIDENT_ANALYSIS_TEXT.previewUsed);
    await vi.waitFor(() => expect(runnerCalls).toHaveLength(1));
    release();
    await existingIncidentAnalysisService()?.whenIdle();
    expect(runnerCalls).toHaveLength(1);
  });

  it("두 탭(미리보기를 따로 연 두 폼) — 둘 다 303(진행 중이면 새로 부르지 않는다), 실행 자리는 한 번", async () => {
    const first = await previewFields();
    const second = await previewFields();
    expect(second.preview).not.toBe(first.preview);
    let release: () => void = () => undefined;
    pendingReleases.push(() => release());   // 단언이 먼저 실패해도 afterEach 가 뒤에서 도는 분석을 풀어 준다
    runnerResponder = () => new Promise((resolve) => { release = () => resolve(jsonBody(runnerSuccessBody())); });
    const responses = await Promise.all([analysisRoute.POST(postRequest(first)), analysisRoute.POST(postRequest(second))]);
    expect(responses.map((response) => response.status)).toEqual([303, 303]);
    await vi.waitFor(() => expect(runnerCalls).toHaveLength(1));
    const running = await renderPage({ incident: FRONT });
    expect(running).toContain('<meta http-equiv="refresh" content="5"/>');
    expect(textOf(running)).toContain(INCIDENT_ANALYSIS_TEXT.running);
    release();
    await existingIncidentAnalysisService()?.whenIdle();
    expect(runnerCalls).toHaveLength(1);
    expect(await renderPage({ incident: FRONT })).not.toContain("http-equiv");
  });

  it("미리본 글과 한 글자라도 다르면 409 — 부르지 않고 쓰지 않는다", async () => {
    const fields = await previewFields();
    const response = await post({ ...fields, prompt: `${fields.prompt} ` });
    expect(response.status).toBe(409);
    expect(textOf(await response.text())).toContain("미리본 글과 다릅니다");
    expect(runnerCalls).toEqual([]);
    expect(redisWrites()).toEqual([]);
  });

  it("다른 문제의 미리보기 · 꼴이 틀린 서명 · 10분 지난 미리보기 — 부르지 않는다", async () => {
    const fields = await previewFields();
    expect((await post({ ...fields, incident: monitorIncidentId("backend") })).status).toBe(409);
    expect((await post({ ...fields, preview: "rc1.x.1.abc" })).status).toBe(400);
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    const expired = await post(fields);
    expect(expired.status).toBe(409);
    expect(textOf(await expired.text())).toContain("미리보기가 지났습니다");
    expect(runnerCalls).toEqual([]);
  });

  it("미리본 뒤 문제가 닫혔거나(UP) 열려 있는지 모르게 됐으면 409 — 부르지 않는다", async () => {
    const fields = await previewFields();
    overrides[`${FAKE_ALERT_URL}/monitors`] = () => jsonBody(monitorsBody([{ name: "front", status: "UP", down_since: "", reason: "" }]));
    const closed = await post(fields);
    expect(closed.status).toBe(409);
    expect(textOf(await closed.text())).toContain(INCIDENT_ANALYSIS_TEXT.closed);
    overrides[`${FAKE_ALERT_URL}/monitors`] = () => textResponse("", 503);
    const unchecked = await post(fields);
    expect(unchecked.status).toBe(409);
    expect(textOf(await unchecked.text())).toContain(INCIDENT_ANALYSIS_TEXT.unchecked);
    expect(runnerCalls).toEqual([]);
    expect(redisWrites()).toEqual([]);
  });

  it("출처 · 세션 · 본문의 꼴 — 부르지 않는다", async () => {
    const fields = await previewFields();
    expect((await post(fields, { origin: null })).status).toBe(403);
    expect((await post(fields, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await post(fields, { contentType: "application/json" })).status).toBe(400);
    const duplicated = new URLSearchParams(fields);
    duplicated.append("prompt", "다른 글");
    expect((await post(duplicated)).status).toBe(400);
    expect((await post({ incident: FRONT, preview: fields.preview })).status).toBe(400);
    expect((await post({ ...fields, prompt: "가".repeat(400_000) })).status).toBe(400);
    cookieJar.clear();
    const unauthenticated = await post(fields);
    expect(unauthenticated.status).toBe(401);
    expect(runnerCalls).toEqual([]);
    expect(redisWrites()).toEqual([]);
  });

  it("GET 으로는 시작되지 않는다 — 경로에 GET 이 없다", () => {
    expect((analysisRoute as Record<string, unknown>).GET).toBeUndefined();
    expect(typeof analysisRoute.POST).toBe("function");
  });
});

describe("미리보기는 한 번만 쓴다(명세 ⑫ §21 4)", () => {
  function usedPreviewEntries(): [string, string][] {
    return [...SHARED_FAKE_REDIS_STATE.strings].filter(([key]) => key.includes(":used-preview:")).map(([key, entry]) => [key, entry.value]);
  }

  it("앞 분석이 끝난 뒤 같은 폼을 다시 보내면 409 — 실행 자리는 한 번 · 표시는 키 하나(서명의 해시) · 값 \"1\"", async () => {
    const fields = await previewFields();
    expect((await post(fields)).status).toBe(303);
    const again = await post(fields);
    expect(again.status).toBe(409);
    expect(textOf(await again.text())).toContain(INCIDENT_ANALYSIS_TEXT.previewUsed);
    expect(runnerCalls).toHaveLength(1);
    const entries = usedPreviewEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toMatch(/^incident-analysis:v1:used-preview:[0-9a-f]{64}$/);
    expect(entries[0][1]).toBe("1");
    for (const part of [fields.preview, fields.preview.split(".").at(-1)!, LOG_MARK, FRONT]) expect(entries[0][0]).not.toContain(part);
  });

  it("앞 분석이 도는 중에 같은 폼을 다시 보내도 409 · 실행 자리는 한 번", async () => {
    const fields = await previewFields();
    let release: () => void = () => undefined;
    pendingReleases.push(() => release());   // 단언이 먼저 실패해도 afterEach 가 뒤에서 도는 분석을 풀어 준다
    runnerResponder = () => new Promise((resolve) => { release = () => resolve(jsonBody(runnerSuccessBody())); });
    expect((await analysisRoute.POST(postRequest(fields))).status).toBe(303);
    await vi.waitFor(() => expect(runnerCalls).toHaveLength(1));
    expect((await analysisRoute.POST(postRequest(fields))).status).toBe(409);
    release();
    await existingIncidentAnalysisService()?.whenIdle();
    expect(runnerCalls).toHaveLength(1);
  });

  it("Redis 에 닿지 못하면(표시를 남기지 못함) 503 — 시작하지 않는다", async () => {
    const fields = await previewFields();
    SHARED_FAKE_REDIS_STATE.down = true;
    const response = await post(fields);
    expect(response.status).toBe(503);
    expect(runnerCalls).toEqual([]);
  });
});

describe("서명에 \"언제부터\"를 묶는다(명세 ⑫ §21 3)", () => {
  const downAt = (since: string) => () => jsonBody(monitorsBody([{ name: "front", status: "DOWN", down_since: since, reason: "status 502" }]));

  it("미리본 뒤 같은 식별자가 다른 since 로 다시 열렸으면 409 — 부르지 않고 쓰지 않는다", async () => {
    const fields = await previewFields();
    overrides[`${FAKE_ALERT_URL}/monitors`] = downAt(iso(NOW - 2 * MINUTE));
    const response = await post(fields);
    expect(response.status).toBe(409);
    expect(textOf(await response.text())).toContain(INCIDENT_ANALYSIS_TEXT.reopened);
    expect(runnerCalls).toEqual([]);
    expect(redisWrites()).toEqual([]);
  });

  it("since 가 같으면 그대로 303", async () => {
    const fields = await previewFields();
    overrides[`${FAKE_ALERT_URL}/monitors`] = downAt(iso(DOWN_AT));
    expect((await post(fields)).status).toBe(303);
    expect(runnerCalls).toHaveLength(1);
  });

  it("since 가 없는 문제(DOWN 시각 모름) — 없음끼리는 303 · 그 뒤 since 가 생겼으면 409", async () => {
    overrides[`${FAKE_ALERT_URL}/monitors`] = downAt("");
    const fields = await previewFields();
    expect(fields.preview).toMatch(/^ap2\.\d+\.-\./);
    overrides[`${FAKE_ALERT_URL}/monitors`] = downAt(iso(NOW - MINUTE));
    expect((await post(fields)).status).toBe(409);
    overrides[`${FAKE_ALERT_URL}/monitors`] = downAt("");
    expect((await post(fields)).status).toBe(303);
    expect(runnerCalls).toHaveLength(1);
  });
});

describe("브라우저가 폼의 줄바꿈을 CRLF 로 바꿔 보낸다(명세 ⑫ §21 6)", () => {
  it("CRLF 로 바꾼 글 → 303 · 실행 자리가 받은 글은 미리본 글 그대로(CR 없음)", async () => {
    const fields = await previewFields();
    expect(fields.prompt).toContain("\n");
    expect(fields.prompt).not.toContain("\r");
    expect((await post({ ...fields, prompt: fields.prompt.replaceAll("\n", "\r\n") })).status).toBe(303);
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0].body.prompt).toBe(fields.prompt);
    expect(String(runnerCalls[0].body.prompt)).not.toContain("\r");
    expect(storedAttempts()[0].prompt).toBe(fields.prompt);
  });

  it.each([["홀로 선 CR", "\r"], ["CR CR LF", "\r\r\n"]])("%s 로 바꾼 글은 409 — 부르지 않는다", async (_label, lineEnd) => {
    const fields = await previewFields();
    expect((await post({ ...fields, prompt: fields.prompt.replaceAll("\n", lineEnd) })).status).toBe(409);
    expect(runnerCalls).toEqual([]);
  });
});

describe("가리기 전에 글자를 정리한다(명세 ⑫ §21 1) — 미리보기 · 보낸 글 · 저장된 글", () => {
  const ESC = "\u001b";
  const DIRTY_SECRET = "Zq81PageColorSecret5";
  const DIRTY = `${ESC}[36mpassword${ESC}[0m=${ESC}[35m${DIRTY_SECRET}${ESC}[0m \u202e뒤집힘\u2066 \u0085다음\u2028줄 ${ESC}]0;title\u0007 끝\r끝2 token\u000b: Zq81VtSecret6`;

  it("미리보기의 글 · 실행 자리가 받은 글 · 저장된 \"보낸 글\"에 비밀값도 제어 · 방향 · ESC 글자도 없다(셋이 같은 바이트)", async () => {
    overrides[`${FAKE_OBSERVE_URL}/logs`] = (url) => {
      const parameters = url.searchParams;
      const rows = parameters.get("service") === "front" && parameters.get("level") === "error"
        ? [logRow({ id: `${DOWN_AT + MINUTE}-0`, at: iso(DOWN_AT + MINUTE), level: "error", service: "front", message: DIRTY })] : [];
      return jsonBody(logsBody(rows, parameters.get("from")!, parameters.get("to")!));
    };
    const html = await renderPage({ incident: FRONT, preview: "1" });
    const fields = formFields(html);
    const forbidden = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
    for (const text of [fields.prompt, unescapeHtml(/<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)![1])]) {
      expect(text).not.toContain(DIRTY_SECRET);
      expect(text).not.toContain("Zq81VtSecret6");
      expect(text).not.toMatch(forbidden);
      expect(text).not.toContain("\r");
    }
    expect(fields.prompt).toContain("\uFFFD뒤집힘\uFFFD");
    expect((await post(fields)).status).toBe(303);
    expect(runnerCalls[0].body.prompt).toBe(fields.prompt);
    expect(storedAttempts()[0].prompt).toBe(fields.prompt);
  });
});

describe("nginx 가 분석 요청의 본문을 받는다(명세 ⑫ §21 2)", () => {
  const config = readFileSync(fileURLToPath(new URL("../../../deploy/nginx/nginx.conf", import.meta.url)), "utf8");
  const block = () => /location = \/api\/incidents\/analysis \{([^}]*)\}/.exec(config)?.[1];

  it("location = /api/incidents/analysis — client_max_body_size 1m · proxy_pass 같은 뒤쪽", () => {
    expect(block(), "분석 요청의 location 이 없다").toBeDefined();
    expect(block()).toMatch(/client_max_body_size\s+1m;/);
    expect(block()).toMatch(/proxy_pass\s+http:\/\/\$deploy_upstream;/);
  });

  it("그 location 안에서 proxy_set_header · add_header 를 다시 쓰지 않는다(위 단계의 것을 물려받게)", () => {
    expect(block() ?? "").not.toMatch(/proxy_set_header|add_header/);
  });

  it("1m 은 앱의 본문 상한(INCIDENT_ANALYSIS_BODY_MAX_BYTES)과 같은 수", () => {
    expect(INCIDENT_ANALYSIS_BODY_MAX_BYTES).toBe(1024 * 1024);
  });

  it("다른 경로는 그대로 — server 의 16k · 로그인의 8k · location / 는 상한을 다시 쓰지 않는다", () => {
    expect(config).toMatch(/listen 18000;[\s\S]*?client_max_body_size 16k;/);
    expect(/location = \/api\/auth\/login \{([^}]*)\}/.exec(config)![1]).toMatch(/client_max_body_size\s+8k;/);
    expect(/location \/ \{([^}]*)\}/.exec(config)![1]).not.toMatch(/client_max_body_size/);
    expect(config.match(/client_max_body_size/g)).toHaveLength(3);
  });
});

describe("배포 실패 — 12-2 의 전체 출력을 실어 온다", () => {
  it("요청 ID 로 출력을 읽어 `## 배포 실패의 전체 출력` 구역에 · 출력의 비밀값도 가린다", async () => {
    const fields = await previewFields(DEPLOY);
    const outputCall = upstreamFetch.mock.calls.find(([input]) => new URL(String(input)).pathname === "/deploys/req-failed-1/output");
    expect(outputCall, "출력 조회가 없다").toBeDefined();
    expect(headersOf(outputCall![1]).get("x-deploy-secret")).toBe(FAKE_DEPLOY_SECRET);
    expect(fields.prompt).toContain("## 배포 실패의 전체 출력");
    expect(fields.prompt).toContain("| --- FAIL: TestPool");
    expect(fields.prompt).toContain("| password=[가림:secret_field]");
    expect(fields.prompt).not.toContain(OUTPUT_SECRET);
  });

  it.each([
    [404, "output_not_recorded", "배포 마스터가 출력을 남기지 않았습니다"], [410, "output_expired", "보관 기간이 지나 지워졌습니다"],
    [409, "not_finished", "배포가 아직 끝나지 않았습니다"], [503, "busy", "배포 마스터의 일시 장애"],
  ] as const)("%i %s — 분석은 출력 없이 가고 묶음에 한 줄", async (status, code, text) => {
    overrides[`${FAKE_DEPLOY_MASTER_URL}/deploys/req-failed-1/output`] = () => jsonBody({ success: false, error: { code, detail: leakyErrorBody() } }, status);
    const fields = await previewFields(DEPLOY);
    expect(fields.prompt).toContain(`## 배포 실패의 전체 출력\n전체 출력을 얻지 못함 — ${text}`);
    expectNothingLeaked(fields.prompt);
  });

  it("배포 실패가 아닌 문제는 출력을 읽지 않는다", async () => {
    await previewFields(FRONT);
    expect(calledPaths().some((path) => path.endsWith("/output"))).toBe(false);
  });
});

describe("실행 자리의 실패 · 답의 꼴 — 저마다 다른 고정 글(실행 자리의 글을 내지 않는다)", () => {
  it.each([
    ["502 invalid_answer", () => jsonBody(runnerFailureBody("invalid_answer", { detail: leakyErrorBody() }), 502), "invalid_answer"],
    ["502 bad_output", () => jsonBody(runnerFailureBody("bad_output", { detail: leakyErrorBody() }), 502), "bad_output"],
    ["502 claude_failed", () => jsonBody(runnerFailureBody("claude_failed", { detail: leakyErrorBody() }), 502), "claude_failed"],
    ["504 timeout", () => jsonBody(runnerFailureBody("timeout", { detail: leakyErrorBody() }), 504), "timeout"],
    ["429 busy", () => jsonBody(runnerFailureBody("busy", { detail: leakyErrorBody() }), 429), "busy"],
    ["429 limit_reached", () => jsonBody(runnerFailureBody("limit_reached", { scope: "analysis", window: "day", limit: 30, detail: leakyErrorBody() }), 429), "limit_reached"],
    ["429 disabled", () => jsonBody(runnerFailureBody("disabled", { detail: leakyErrorBody() }), 429), "disabled"],
    ["503 token_missing", () => jsonBody(runnerFailureBody("token_missing", { detail: leakyErrorBody() }), 503), "token_missing"],
    ["503 claude_unavailable", () => jsonBody(runnerFailureBody("claude_unavailable", { detail: leakyErrorBody() }), 503), "claude_unavailable"],
    ["200 목록 밖의 조치", () => jsonBody(runnerSuccessBody(validRunnerAnswer({ recommended_action: "restart" }))), "answer_invalid"],
    ["200 모르는 칸", () => jsonBody(runnerSuccessBody(validRunnerAnswer({ extra: "x" }))), "answer_invalid"],
    ["닿지 못함", () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); }, "unreachable"],
  ] as const)("%s → 화면에 그 까닭의 글 · 답을 저장하지 않는다", async (_label, respond, reason) => {
    runnerResponder = respond as () => Response;
    const response = await post(await previewFields());
    expect(response.status).toBe(303);
    const [stored] = storedAttempts();
    expect(stored).toMatchObject({ state: "failed", failureReason: reason, answer: null });
    const html = await renderPage({ incident: FRONT });
    expect(textOf(html)).toContain(ANALYSIS_FAILURE_TEXTS[reason]);
    expectNothingLeaked(html);
  });
});

describe("저장소 — 닿지 못하면 시작하지 않는다", () => {
  it("Redis 에 닿지 못함 → 503 · 실행 자리를 부르지 않는다 · 화면은 저장소 없음(요청 링크 없음)", async () => {
    const fields = await previewFields();
    SHARED_FAKE_REDIS_STATE.down = true;
    const response = await post(fields);
    expect(response.status).toBe(503);
    expect(textOf(await response.text())).toContain(INCIDENT_ANALYSIS_TEXT.storeUnavailable);
    expect(runnerCalls).toEqual([]);
    const html = await renderPage({ incident: FRONT });
    expect(textOf(html)).toContain(INCIDENT_ANALYSIS_TEXT.storeUnavailable);
    expect(html).not.toContain("preview=1");
  });

  it("저장소 · 실행 자리 설정이 없으면 503 · 부르지 않는다", async () => {
    const fields = await previewFields();
    vi.stubEnv("LOG_REDIS_URL", "");
    resetIncidentAnalysisService();
    const withoutStore = await post(fields);
    expect(withoutStore.status).toBe(503);
    expect(textOf(await withoutStore.text())).toContain(INCIDENT_ANALYSIS_TEXT.notConfigured);
    vi.stubEnv("LOG_REDIS_URL", FAKE_LOG_REDIS_URL);
    vi.stubEnv("CLAUDE_RUNNER_SECRET", "");
    resetIncidentAnalysisService();
    expect((await post(fields)).status).toBe(503);
    expect(runnerCalls).toEqual([]);
  });

  it("부른 뒤 Redis 가 죽음 → 결과를 저장하지 못했다는 로그 · 5분 뒤 화면은 끊김(다시 요청할 수 있다)", async () => {
    const fields = await previewFields();
    runnerResponder = () => {
      SHARED_FAKE_REDIS_STATE.down = true;
      return jsonBody(runnerSuccessBody());
    };
    expect((await post(fields)).status).toBe(303);
    expect(consoleLines.some((line) => line.includes("incident-analysis:result_not_stored incident=monitor:front"))).toBe(true);
    SHARED_FAKE_REDIS_STATE.down = false;
    vi.setSystemTime(NOW + ANALYSIS_RUNNING_LIMIT_MILLISECONDS);
    const html = await renderPage({ incident: FRONT });
    expect(textOf(html)).toContain(INCIDENT_ANALYSIS_TEXT.interrupted);
    expect(html).toContain("preview=1");
  });
});

describe("새지 않는다", () => {
  it("한 바퀴(미리보기 → 보내기 → 다시 열기) — 응답 · 화면 · 로그 · Redis 에 주소 · 비밀값이 없고, 로그에 보낸 글 · 답이 없다", async () => {
    const previewHtml = await renderPage({ incident: FRONT, preview: "1" });
    const response = await post(formFields(previewHtml));
    const resultHtml = await renderPage({ incident: FRONT });
    for (const value of [previewHtml, resultHtml, response.headers.get("location") ?? ""]) expectNothingLeaked(value);
    const logged = consoleLines.join("\n");
    expectNothingLeaked(logged);
    for (const mark of [LOG_MARK, ANSWER_MARK, "<<<자료"]) expect(logged).not.toContain(mark);
    const stored = everythingStored(SHARED_FAKE_REDIS_STATE);
    expectNothingLeaked(stored);
    expect(stored).toContain(LOG_MARK);   // 보낸 글 그대로는 저장한다(가린 글)
  });

  it("브라우저 번들 검사 — 호출 비밀값의 이름 · 머리 · 테스트 값을 찾는다", () => {
    const script = readFileSync(fileURLToPath(new URL("../../../scripts/check-client-bundle.sh", import.meta.url)), "utf8");
    const patterns = /FORBIDDEN_PATTERNS='([\s\S]*?)'/.exec(script)![1].split("\n");
    for (const pattern of ["CLAUDE_RUNNER_SECRET", "X-Claude-Runner-Secret", "fake-claude-call-secret-marker"]) expect(patterns).toContain(pattern);
    expect(/VALUE_NAMES='([^']*)'/.exec(script)![1].split(" ")).toContain("CLAUDE_RUNNER_SECRET");
  });
});

describe("멈출 때 · 끊김", () => {
  it("SIGTERM 의 본체가 도는 분석의 수를 한 줄로 · 기록은 running 으로 남아 5분 뒤 끊김", async () => {
    runnerResponder = () => new Promise(() => undefined);
    const response = await analysisRoute.POST(postRequest(await previewFields()));
    expect(response.status).toBe(303);
    await vi.waitFor(() => expect(runnerCalls).toHaveLength(1));
    logQueueOnShutdown();
    expect(consoleLines.some((line) => line.includes("incident-analysis:shutdown running=1"))).toBe(true);
    expect(storedAttempts()[0].state).toBe("running");
    vi.setSystemTime(NOW + ANALYSIS_RUNNING_LIMIT_MILLISECONDS);
    expect(textOf(await renderPage({ incident: FRONT }))).toContain(INCIDENT_ANALYSIS_TEXT.interrupted);
    resetIncidentAnalysisService();
  });
});

describe("멈출 때 — 등록과 처리기의 차례(명세 ⑫ §21 5)", () => {
  it("instrumentation 이 SIGTERM 처리기를 하나만 물리고(두 번 불려도), 그 처리기는 두 줄(login · incident-analysis)을 한 번씩 남긴 뒤에야 끝낸다", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("ADMIN_PASSWORD_HASH", FAKE_PASSWORD_HASH);
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    const capture = (event: string | symbol, handler: (...args: unknown[]) => void) => {
      handlers.set(String(event), [...(handlers.get(String(event)) ?? []), handler]);
      return process;
    };
    vi.spyOn(process, "on").mockImplementation(capture as typeof process.on);
    vi.spyOn(process, "once").mockImplementation(capture as typeof process.once);
    vi.spyOn(process, "addListener").mockImplementation(capture as typeof process.addListener);
    const order: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { order.push(`exit ${code ?? 0}`); }) as typeof process.exit);
    for (const method of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { const line = parts.map(String).join(" "); consoleLines.push(line); order.push(line); });
    }
    await register();
    await register();   // 두 번 불려도(개발 모드의 다시 읽기 등) 처리기는 하나 — 줄이 두 번 나오지 않게
    expect(exit, "시작 검사가 끝내려 했다 — 설정을 확인").not.toHaveBeenCalled();
    const sigterm = handlers.get("SIGTERM") ?? [];
    expect(sigterm).toHaveLength(1);

    runnerResponder = () => new Promise(() => undefined);
    expect((await analysisRoute.POST(postRequest(await previewFields()))).status).toBe(303);
    await vi.waitFor(() => expect(runnerCalls).toHaveLength(1));
    order.length = 0;
    vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "1");
    sigterm[0]("SIGTERM");
    const loginLines = order.filter((line) => line.includes("login:shutdown"));
    const analysisLines = order.filter((line) => line.includes("incident-analysis:shutdown running=1"));
    expect(loginLines).toHaveLength(1);
    expect(analysisLines).toHaveLength(1);
    expect(order.filter((line) => line.startsWith("exit "))).toEqual(["exit 0"]);
    expect(order.indexOf("exit 0")).toBeGreaterThan(order.indexOf(analysisLines[0]));
    expect(order.indexOf("exit 0")).toBeGreaterThan(order.indexOf(loginLines[0]));
    resetIncidentAnalysisService();
  });

  it("NEXT_MANUAL_SIG_HANDLE 이 없으면 처리기는 끝내지 않는다(Next 의 처리기가 연결을 정리한 뒤 끝낸다) — 줄은 그대로", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    logQueueOnShutdown();
    expect(exit).not.toHaveBeenCalled();
    expect(consoleLines.filter((line) => line.includes("login:shutdown"))).toHaveLength(1);
  });
});

describe("문제 화면에서 분석으로", () => {
  it("열린 문제의 근거 묶음에 분석 화면으로 가는 링크", async () => {
    const element = await IncidentsPage({ searchParams: Promise.resolve({ incident: FRONT }) });
    const rendererModuleName = "react-dom/server";
    const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
    const html = renderer.renderToStaticMarkup(element);
    expect(html).toContain('href="/incidents/analysis?incident=monitor%3Afront"');
    expect(runnerCalls).toEqual([]);
  });
});
