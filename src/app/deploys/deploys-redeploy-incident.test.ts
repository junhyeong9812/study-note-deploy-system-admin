/** 문제의 조치(되돌리기 · 다시 배포)가 ⑥ 의 확인 화면으로 넘어간다(명세 ⑫ §24 · ⑥ version-redeploy). 새 접수 길은 없다 — ⑥ 의 길 그대로에
 * "확인 값에 문제의 ID 를 묶는 것"과 "누가에 문제의 ID 를 싣는 것"만 넓어진다. 실제 화면 · route · 로그인 흐름 + 가짜 서버(알림 · 관측 · master).
 * 계약:
 * - 첫 걸음 GET /deploys/redeploy?service=<서비스>&incident=<ID>&action=redeploy|rollback(commit 을 받지 않는다 — 실어 보내면 입력 거절):
 *   세션(⑥ 그대로) → 입력 → 그 순간 열린 문제에 그 ID 가 있는가(목록 · 근거 — 없으면 closed · 확인하지 못하면 unchecked 의 글, 폼 없음)
 *   → 그 문제의 서비스(incidentActionService)가 요청의 서비스와 같은가(아니면 serviceMismatch · 정할 수 없으면 그 까닭) →
 *   판은 서버가 그 순간의 그 서비스 이력(⑥ 과 같은 출처 — master /deploys?service=&limit=200)에서 다시 정한다(incidentActionTargets — 정할 수 없으면 그 까닭) →
 *   ⑥ 의 확인 화면 그대로 + "문제 <ID> 의 조치" 한 줄 + 문제 화면으로 돌아가는 링크 · 폼에 숨은 칸 incident · 확인 값은 그 ID 를 묶는다.
 * - incident 가 없으면 확인 화면은 지금과 바이트까지 같다(확인 값 · 요청 ID · 커밋을 자리표로 바꾼 뒤).
 * - 접수 POST: 칸 incident(있으면 하나) — 확인 값과 ID 가 맞지 않으면(다른 ID · 뺌 · 더함) 400 · 비밀번호를 보지 않는다(⑥ 의 확인 값 단계) ·
 *   requested_by = admin:<계정>:incident:<ID>(문제에서 온 것) / admin:<계정>(그 밖 — 그대로) · 접수됨 303 은 ⑥ 의 주소 + &incident=<ID> ·
 *   실패 화면에는 문제 화면으로 돌아가는 링크 · 비밀번호 · 잠금 · 속도 제한은 ⑥ 그대로(incident 를 붙여도 걸음이 줄지 않는다).
 * - 배포 이력 화면은 주소의 incident 가 ID 의 꼴이면 "문제 <ID> 화면으로" 링크를 단다(꼴이 아니면 없다).
 * - 로그에 비밀번호 · 확인 값이 없다. */
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
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import { hash } from "@node-rs/argon2";
import DeploysPage from "@/app/deploys/page";
import RedeployPreviewPage from "@/app/deploys/redeploy/page";
import { POST } from "@/app/api/deploys/redeploy/route";
import { SESSION_COOKIE_NAME, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { verifyRedeployConfirmation } from "@/features/deploy-redeploy/lib/redeploy-confirmation";
import { REDEPLOY_INCIDENT_TEXT } from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import { branchFrom, installCommitGraph, type GraphCommit } from "@/features/deploy-redeploy/lib/redeploy-test-fakes";
import { MASTER_DEPLOYS_PATH, createFakeMaster, deploymentJson, minutesAfterStart, type FakeMaster } from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import { INCIDENT_ACTION_TEXT } from "@/features/incidents/lib/incident-actions";
import { MINUTE, NOW, alertRecordsBody, emptySeriesBody, iso, latestBody, latestServerRow, logsBody, monitorsBody, seenContainersBody } from "@/features/incidents/lib/incidents-test-fakes";
import type { RoutedFetchHandler } from "@/shared/lib/upstream-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, jsonBody, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const INCIDENT = "monitor:backend";
const ACCEPT_PATH = "/deploy";
const WRONG_PASSWORD = "fake-wrong-password-marker-pw8";
/** incident 없이 연 확인 화면의 <main> — 이 조각 전의 코드로 그린 것(확인 값 · 요청 ID · 커밋을 자리표로). 지금과 바이트까지 같아야 한다. */
const GOLDEN_MAIN_WITHOUT_INCIDENT = "<main class=\"_main_607b3e\"><div class=\"_heading_789557\"><h1 class=\"_title_789557\">재배포 확인</h1><p class=\"_count_789557\">backend</p><p class=\"_count_789557\"><a href=\"/deploys/versions?service=backend\">버전 목록으로</a></p></div><p class=\"_count_789557\"><strong>지금 버전</strong> <code class=\"_code_2122bc\" title=\"{{SHA4}}\">{{SHORT4}}</code> 배포 스크립트 · 마지막 배포 <time dateTime=\"2026-11-20T00:43:00Z\" title=\"UTC 2026-11-20T00:43:00Z\">2026-11-20 09:43:00</time></p><p class=\"_count_789557\"><strong>고른 버전</strong> <code class=\"_code_2122bc\" title=\"{{SHA3}}\">{{SHORT3}}</code> 목록 정렬 · 마지막 배포 <time dateTime=\"2026-11-20T00:33:00Z\" title=\"UTC 2026-11-20T00:33:00Z\">2026-11-20 09:33:00</time></p><p class=\"_count_789557\"><strong>되돌립니다</strong> — 고른 버전은 지금 버전보다 앞선 커밋입니다. 아래 커밋들이 서버에서 빠집니다.</p><div class=\"_problem_789557\" role=\"note\"><p class=\"_problemDetail_789557\">데이터 꼴(표의 구조)을 바꾼 커밋이 사이에 있으면 되돌린 뒤 앱이 깨질 수 있습니다. 목록을 보고 판단하세요.</p></div><p class=\"_count_789557\"><strong>사라지는 커밋 1개</strong><span class=\"_countNote_789557\">(최신순 — 지금 버전 쪽이 위)</span></p><div class=\"_scroller_2122bc\" tabindex=\"0\" role=\"region\" aria-label=\"사라지는 커밋 표\"><table class=\"_table_2122bc _tableCompact_2122bc\"><thead><tr><th scope=\"col\">커밋</th><th scope=\"col\">커밋 제목</th></tr></thead><tbody><tr><td><code class=\"_code_2122bc\" title=\"{{SHA4}}\">{{SHORT4}}</code></td><td>배포 스크립트</td></tr></tbody></table></div><p class=\"_count_789557\">접수하면 배포 서버가 이 커밋을 다시 빌드해 올립니다. 비밀번호를 다시 확인합니다(이 확인 화면은 5분 동안만 쓸 수 있습니다).</p><form class=\"_form_eccda7\" action=\"/api/deploys/redeploy\" method=\"post\"><input type=\"hidden\" name=\"service\" value=\"backend\"/><input type=\"hidden\" name=\"commit\" value=\"{{SHA3}}\"/><input type=\"hidden\" name=\"confirmation\" value=\"{{CONFIRMATION}}\"/><div class=\"_field_eccda7\"><label class=\"_label_eccda7\" for=\"redeploy-password\">비밀번호</label><input class=\"_input_eccda7\" id=\"redeploy-password\" type=\"password\" autoComplete=\"current-password\" required=\"\" name=\"password\"/></div><button class=\"_button_eccda7\" type=\"submit\">backend 를 {{SHORT3}} 로 배포</button></form></main>";

let passwordHash = "";
/** 접수의 속도 제한(계정당 1분에 5번)이 테스트 사이에 이어지지 않게 — 테스트마다 시계를 1분 남짓 민다(문제의 시각들은 NOW 기준이라 그대로 열려 있다). */
let testClock = NOW;
let main: GraphCommit[];
let master: FakeMaster;
let monitorsResponse: () => Response;
const observeAttempts: Record<string, unknown>[] = [];
const consoleLines: string[] = [];

type Renderer = { renderToStaticMarkup: (node: unknown) => string };

async function render(page: (props: { searchParams: Promise<Record<string, string | string[]>> }) => Promise<unknown>, searchParams: Record<string, string | string[]>): Promise<string> {
  const element = await page({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  return ((await import(/* @vite-ignore */ rendererModuleName)) as Renderer).renderToStaticMarkup(element);
}

function mainOf(html: string): string {
  const match = /<main[\s>][\s\S]*<\/main>/.exec(html);
  expect(match, "본문 <main> 이 있다").not.toBeNull();
  return match![0];
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

function formsOf(html: string): string[] {
  return [...mainOf(html).matchAll(/<form[\s>][\s\S]*?<\/form>/gi)].map((match) => match[0]);
}

function hiddenFields(form: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of form.matchAll(/<input[^>]*>/gi)) {
    const tag = match[0];
    if (!/type="hidden"/.test(tag)) continue;
    const name = /name="([^"]*)"/.exec(tag)![1];
    fields[name] = /value="([^"]*)"/.exec(tag)![1].replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  }
  return fields;
}

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1].replace(/&amp;/g, "&"));
}

const masterAccepts = () => master.fetch.mock.calls.filter(([input]) => new URL(input).pathname === ACCEPT_PATH);
const acceptBodies = () => masterAccepts().map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

function acceptRequest(fields: Record<string, string | string[]>): Request {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) for (const each of Array.isArray(value) ? value : [value]) search.append(name, each);
  return new Request(new URL("/api/deploys/redeploy", FAKE_ORIGIN), {
    method: "POST", body: search.toString(),
    headers: { origin: FAKE_ORIGIN, "content-type": "application/x-www-form-urlencoded", "x-real-ip": "198.51.100.77", "user-agent": "FakeBrowser/1.0" },
  });
}

/** 문제의 조치로 연 확인 화면의 폼 칸(+ 비밀번호). */
async function incidentFormFields(action: "redeploy" | "rollback" = "rollback"): Promise<Record<string, string>> {
  const forms = formsOf(await render(RedeployPreviewPage, { service: "backend", incident: INCIDENT, action }));
  expect(forms, "확인 화면의 접수 폼").toHaveLength(1);
  return { ...hiddenFields(forms[0]), password: FAKE_PASSWORD };
}

function locationPath(response: Response): string {
  const location = response.headers.get("location") ?? "";
  return location.startsWith(FAKE_ORIGIN) ? location.slice(FAKE_ORIGIN.length) : location;
}

beforeAll(async () => {
  passwordHash = await hash(FAKE_PASSWORD, { algorithm: 2 });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  testClock += 61_000;
  vi.setSystemTime(testClock);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("study-note-admin.login-service")];
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries({
    ADMIN_USER: FAKE_ADMIN_ID, ADMIN_PASSWORD_HASH: passwordHash, SESSION_SECRET: FAKE_SIGNING_KEY, ADMIN_ORIGIN: FAKE_ORIGIN,
    OBSERVE_URL: FAKE_OBSERVE_URL, OBSERVE_SECRET: FAKE_OBSERVE_SECRET, ALERT_URL: FAKE_ALERT_URL, ALERT_SECRET: FAKE_ALERT_SECRET,
    DEPLOY_MASTER_URL: FAKE_DEPLOY_MASTER_URL, DEPLOY_SECRET: FAKE_DEPLOY_SECRET, BACKEND_URL: FAKE_BACKEND_URL, LOG_REDIS_URL: "",
  })) vi.stubEnv(name, value);
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, testClock - 60_000));
  observeAttempts.length = 0;
  consoleLines.length = 0;
  monitorsResponse = () => jsonBody(monitorsBody([{ name: "backend", status: "DOWN", down_since: iso(NOW - 20 * MINUTE), reason: "status 502" }]));
  main = branchFrom(null, ["첫 커밋", "로그인 고침", "표에 칸 더함", "목록 정렬", "배포 스크립트"]);
  master = createFakeMaster([
    deploymentJson("backend", main[4].sha, "succeeded", minutesAfterStart(40)),
    deploymentJson("backend", main[3].sha, "succeeded", minutesAfterStart(30)),
    deploymentJson("backend", main[1].sha, "succeeded", minutesAfterStart(20)),
    deploymentJson("backend", main[0].sha, "succeeded", minutesAfterStart(10)),
  ]);
  installCommitGraph(master, main);
  (master.override as Record<string, RoutedFetchHandler>)[ACCEPT_PATH] = (_url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return jsonBody({ success: true, data: { request_id: body.request_id, service: body.service, state: "accepted" } }, 202);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.origin === new URL(FAKE_ALERT_URL).origin) {
      if (url.pathname === "/monitors") return monitorsResponse();
      if (url.pathname === "/incidents") return jsonBody(alertRecordsBody([]));
      return jsonBody({ success: true, data: { sent: true } }, 202);
    }
    if (url.origin === new URL(FAKE_OBSERVE_URL).origin) {
      if (url.pathname === "/auth/attempts") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        observeAttempts.push(body);
        return jsonBody({ success: true, data: { allowed: body.credential_ok === true, outcome: body.credential_ok ? "success" : "failure", locked_until: null, lock_started: false, failures: 0 } });
      }
      if (url.pathname === "/metrics/latest") return jsonBody(latestBody([latestServerRow("s158", [["backend-app-blue", "backend-app"]])], []));
      if (url.pathname === "/metrics/containers") return jsonBody(seenContainersBody(url.searchParams.get("server")!, Date.parse(url.searchParams.get("at")!), ["backend-app"]));
      if (url.pathname === "/metrics/series") return jsonBody(emptySeriesBody(url.searchParams));
      if (url.pathname === "/logs") return jsonBody(logsBody([], url.searchParams.get("from") ?? iso(NOW - 10 * MINUTE), url.searchParams.get("to") ?? iso(NOW)));
      return jsonBody({ success: true, data: {} });
    }
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

describe("첫 걸음 — 문제의 조치로 연 확인 화면", () => {
  it("되돌리기 — 판은 서버가 그 순간의 이력에서(지금 판의 바로 앞 성공 배포) · 숨은 칸 incident · 확인 값이 ID 를 묶는다 · 문제의 한 줄과 링크", async () => {
    const html = await render(RedeployPreviewPage, { service: "backend", incident: INCIDENT, action: "rollback" });
    const forms = formsOf(html);
    expect(forms).toHaveLength(1);
    const fields = hiddenFields(forms[0]);
    expect(Object.keys(fields).sort()).toEqual(["commit", "confirmation", "incident", "service"]);
    expect(fields).toMatchObject({ service: "backend", commit: main[3].sha, incident: INCIDENT });
    const withIncident = verifyRedeployConfirmation(fields.confirmation, FAKE_SIGNING_KEY, { service: "backend", commitSha: main[3].sha, account: FAKE_ADMIN_ID, incidentId: INCIDENT }, Date.now());
    expect(withIncident.ok).toBe(true);
    expect(verifyRedeployConfirmation(fields.confirmation, FAKE_SIGNING_KEY, { service: "backend", commitSha: main[3].sha, account: FAKE_ADMIN_ID }, Date.now()).ok).toBe(false);
    const text = textOf(mainOf(html));
    expect(text).toContain(`${REDEPLOY_INCIDENT_TEXT.headingPrefix}${INCIDENT}${REDEPLOY_INCIDENT_TEXT.headingSuffix}`);
    expect(REDEPLOY_INCIDENT_TEXT.headingPrefix + INCIDENT + REDEPLOY_INCIDENT_TEXT.headingSuffix).toBe("문제 monitor:backend 의 조치");
    expect(hrefsOf(mainOf(html))).toContain("/incidents?incident=monitor%3Abackend");
  });

  it("다시 배포 — 지금 판(가장 최근 성공 배포)", async () => {
    expect((await incidentFormFields("redeploy")).commit).toBe(main[4].sha);
  });

  it("판은 그 순간의 이력에서 — 화면을 연 뒤 이력이 바뀌었으면 바뀐 이력으로 정한다", async () => {
    master.deployments.unshift(deploymentJson("backend", main[2].sha, "succeeded", minutesAfterStart(50)));
    const fields = await incidentFormFields("rollback");
    expect(fields.commit).toBe(main[4].sha);
    expect(master.requestedUrls().some((url) => url.pathname === MASTER_DEPLOYS_PATH && url.searchParams.get("service") === "backend")).toBe(true);
  });

  it("판을 실어 보내면 받지 않는다 — 폼 없음 · git 조회 없음", async () => {
    const html = await render(RedeployPreviewPage, { service: "backend", incident: INCIDENT, action: "rollback", commit: main[0].sha });
    expect(formsOf(html)).toEqual([]);
    expect(master.gitRequests()).toEqual([]);
  });

  it.each([
    ["닫힌 문제(감시 대상이 UP)", () => jsonBody(monitorsBody([{ name: "backend", status: "UP", down_since: "", reason: "" }])), INCIDENT, REDEPLOY_INCIDENT_TEXT.closed],
    ["목록에 없는 ID", null, "monitor:llm", REDEPLOY_INCIDENT_TEXT.closed],
    ["열려 있는지 확인하지 못함(감시 대상 출처 503)", () => textResponse("", 503), INCIDENT, REDEPLOY_INCIDENT_TEXT.unchecked],
  ] as const)("%s → 확인 화면 대신 까닭 · 폼 없음 · git 조회 없음", async (_label, monitors, incidentId, reason) => {
    if (monitors !== null) monitorsResponse = monitors;
    const html = await render(RedeployPreviewPage, { service: "backend", incident: incidentId, action: "rollback" });
    expect(textOf(mainOf(html))).toContain(reason);
    expect(formsOf(html)).toEqual([]);
    expect(master.gitRequests()).toEqual([]);
  });

  it("그 문제의 서비스와 요청의 서비스가 다르면 거절", async () => {
    const html = await render(RedeployPreviewPage, { service: "front", incident: INCIDENT, action: "rollback" });
    expect(textOf(mainOf(html))).toContain(REDEPLOY_INCIDENT_TEXT.serviceMismatch);
    expect(formsOf(html)).toEqual([]);
  });

  it("서비스를 하나로 정할 수 없는 문제(대응 표에 없는 감시 대상) → 그 까닭", async () => {
    monitorsResponse = () => jsonBody(monitorsBody([{ name: "deploy-master", status: "DOWN", down_since: iso(NOW - MINUTE), reason: "x" }]));
    const html = await render(RedeployPreviewPage, { service: "backend", incident: "monitor:deploy-master", action: "redeploy" });
    expect(textOf(mainOf(html))).toContain(INCIDENT_ACTION_TEXT.serviceReasons.unmapped);
    expect(formsOf(html)).toEqual([]);
  });

  it("되돌릴 판이 없으면(성공한 배포가 하나뿐) 그 까닭 · 다시 배포는 된다", async () => {
    master.deployments = [deploymentJson("backend", main[4].sha, "succeeded", minutesAfterStart(40))];
    const rollback = await render(RedeployPreviewPage, { service: "backend", incident: INCIDENT, action: "rollback" });
    expect(textOf(mainOf(rollback))).toContain(INCIDENT_ACTION_TEXT.targetReasons.single_succeeded);
    expect(formsOf(rollback)).toEqual([]);
    expect(formsOf(await render(RedeployPreviewPage, { service: "backend", incident: INCIDENT, action: "redeploy" }))).toHaveLength(1);
  });

  it("incident 가 없으면 확인 화면은 지금과 바이트까지 같다", async () => {
    let html = mainOf(await render(RedeployPreviewPage, { service: "backend", commit: main[3].sha }));
    const confirmation = /name="confirmation" value="([^"]*)"/.exec(html)![1];
    html = html.replaceAll(confirmation, "{{CONFIRMATION}}").replaceAll(confirmation.split(".")[1], "{{REQUEST_ID}}");
    main.forEach((commit, index) => { html = html.replaceAll(commit.sha, `{{SHA${index}}}`).replaceAll(commit.sha.slice(0, 7), `{{SHORT${index}}}`); });
    expect(html).toBe(GOLDEN_MAIN_WITHOUT_INCIDENT);
  });

  it("세션이 없으면 로그인으로 — 다른 서버를 부르지 않는다(⑥ 그대로)", async () => {
    cookieJar.clear();
    await expect(render(RedeployPreviewPage, { service: "backend", incident: INCIDENT, action: "rollback" })).rejects.toThrow(/^redirect:.*\/login/);
    expect(master.fetch).not.toHaveBeenCalled();
  });
});

describe("접수 — ⑥ 그대로 + 누가에 문제의 ID", () => {
  it("문제에서 온 접수 → requested_by admin:<계정>:incident:<ID> · 303 은 ⑥ 의 주소 + &incident=<ID>", async () => {
    const fields = await incidentFormFields("rollback");
    const response = await POST(acceptRequest(fields));
    expect(response.status).toBe(303);
    expect(acceptBodies()).toHaveLength(1);
    expect(acceptBodies()[0]).toMatchObject({ service: "backend", commit_sha: main[3].sha, requested_by: `admin:${FAKE_ADMIN_ID}:incident:${INCIDENT}` });
    const requestId = String(acceptBodies()[0].request_id);
    expect(locationPath(response)).toBe(`/deploys?service=backend&selected=${encodeURIComponent(requestId)}&selectedService=backend&incident=monitor%3Abackend`);
    expect(observeAttempts).toHaveLength(1);
  });

  it("문제에서 오지 않은 접수 → requested_by admin:<계정> 그대로 · 주소에 incident 없음", async () => {
    const forms = formsOf(await render(RedeployPreviewPage, { service: "backend", commit: main[3].sha }));
    const response = await POST(acceptRequest({ ...hiddenFields(forms[0]), password: FAKE_PASSWORD }));
    expect(response.status).toBe(303);
    expect(acceptBodies()[0].requested_by).toBe(`admin:${FAKE_ADMIN_ID}`);
    expect(locationPath(response)).not.toContain("incident");
  });

  it.each([
    ["다른 ID 로 바꿈", (fields: Record<string, string>) => ({ ...fields, incident: "monitor:front" })],
    ["ID 를 뺌", (fields: Record<string, string>) => { const { incident, ...rest } = fields; void incident; return rest; }],
    ["접두만 같은 ID", (fields: Record<string, string>) => ({ ...fields, incident: `${INCIDENT}-deps` })],
  ])("%s → 400 · 비밀번호를 보지 않고 접수하지 않는다", async (_label, change) => {
    const response = await POST(acceptRequest(change(await incidentFormFields("rollback"))));
    expect(response.status).toBe(400);
    expect(observeAttempts).toEqual([]);
    expect(masterAccepts()).toEqual([]);
  });

  it("ID 없는 확인 화면의 값에 ID 를 더함 → 400", async () => {
    const forms = formsOf(await render(RedeployPreviewPage, { service: "backend", commit: main[3].sha }));
    const response = await POST(acceptRequest({ ...hiddenFields(forms[0]), password: FAKE_PASSWORD, incident: INCIDENT }));
    expect(response.status).toBe(400);
    expect(masterAccepts()).toEqual([]);
  });

  it("incident 칸이 둘 · 꼴이 아님 → 400(꼴의 거절)", async () => {
    const fields = await incidentFormFields("rollback");
    expect((await POST(acceptRequest({ ...fields, incident: [INCIDENT, INCIDENT] }))).status).toBe(400);
    expect((await POST(acceptRequest({ ...fields, incident: "monitor:<b>" }))).status).toBe(400);
    expect(masterAccepts()).toEqual([]);
  });

  it("걸음이 줄지 않는다 — 비밀번호가 없으면 400 · 틀리면 401(접수 없음) · 실패 화면에 문제 화면으로 돌아가는 링크", async () => {
    const fields = await incidentFormFields("rollback");
    const { password, ...withoutPassword } = fields;
    void password;
    expect((await POST(acceptRequest(withoutPassword))).status).toBe(400);
    const wrong = await POST(acceptRequest({ ...fields, password: WRONG_PASSWORD }));
    expect(wrong.status).toBe(401);
    expect(hrefsOf(await wrong.text())).toContain("/incidents?incident=monitor%3Abackend");
    expect(masterAccepts()).toEqual([]);
  });

  it("로그에 비밀번호 · 확인 값이 없다", async () => {
    const fields = await incidentFormFields("rollback");
    await POST(acceptRequest({ ...fields, password: WRONG_PASSWORD }));
    await POST(acceptRequest(fields));
    const logged = consoleLines.join("\n");
    for (const secret of [FAKE_PASSWORD, WRONG_PASSWORD, fields.confirmation, fields.confirmation.split(".")[3]]) expect(logged).not.toContain(secret);
  });
});

describe("배포 이력 화면 — 문제에서 온 접수의 결과", () => {
  it("주소의 incident 가 ID 의 꼴이면 \"문제 <ID> 화면으로\" 링크", async () => {
    const html = await render(DeploysPage, { service: "backend", incident: INCIDENT });
    const link = [...mainOf(html).matchAll(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].find((match) => match[1] === "/incidents?incident=monitor%3Abackend");
    expect(link, "문제 화면으로 가는 링크").toBeDefined();
    expect(link![2]).toBe(`문제 ${INCIDENT} 화면으로`);
  });

  it("꼴이 아니면 링크가 없다(화면은 그대로)", async () => {
    const html = await render(DeploysPage, { service: "backend", incident: "monitor:<script>" });
    expect(html).not.toContain("/incidents?incident=");
    expect(html).not.toContain("<script");
  });
});
