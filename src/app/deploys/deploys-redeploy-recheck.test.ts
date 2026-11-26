/** 문제의 조치의 접수 — 접수 직전의 다시 정하기는 필요한 것만 읽고 8초 안에 끝난다(명세 ⑫ §26). 실제 화면 · route · 로그인 흐름 + 가짜 서버.
 * 계약(정함):
 * - 다시 정하기가 읽는 것(종류마다 가장 적은 것 — 그 문제가 열려 있는가를 가르는 목록의 출처 하나 + 그 서비스의 이력 하나):
 *   감시 대상 DOWN = 알림 /monitors · 배포 실패 = master /deploys(service 없이 — 목록과 같은 200건) · 오류 로그 = 관측 /logs(목록과 같은 오류 검색) ·
 *   자원 임계값 = 관측 /metrics/latest(그 서버의 서비스도 여기서 — 근거의 로그 칸은 이 값의 컨테이너로 서비스를 정한다) — 그리고 master /deploys?service=<서비스>&limit=200.
 *   그 밖(알림 기록 /incidents · 로그 근거 · 커밋 · 자원 계열 · 다른 종류의 출처)은 읽지 않는다.
 * - 첫 걸음(확인 화면)이 같은 입력에서 정한 서비스 · 판과 다시 정하기가 정한 것이 같다(종류마다 — 그대로 303).
 * - 다시 정하기 전체의 기한 INCIDENT_RECHECK_TIMEOUT_MILLISECONDS(8초 · 절대 — 읽기 하나하나의 기한과 따로) — 넘으면 409 · 제목 REDEPLOY_INCIDENT_TEXT.changed ·
 *   까닭 REDEPLOY_INCIDENT_TEXT.recheckTimeout · 로그 `redeploy:incident_changed reason=recheck_timeout …` · 비밀번호 확인 0 · 접수 0 ·
 *   늦게 끝난 읽기는 버린다(접수로 이어지지 않는다). 기한은 setTimeout 계열 타이머로 건다(테스트가 시계를 민다).
 * - 접수 경로의 가장 긴 합(상수 — 다시 정하기 + 비밀번호(관측 판정 · 잠금 알림 대기) + 이력 재확인 + 접수)이 nginx 의 proxy_read_timeout(30초) 미만.
 * - 버전 모드는 그대로(다시 정하지 않는다 — 호출 수). */
import { readFileSync } from "node:fs";
import path from "node:path";
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
import RedeployPreviewPage from "@/app/deploys/redeploy/page";
import { POST } from "@/app/api/deploys/redeploy/route";
import { OBSERVE_TIMEOUT_MILLISECONDS } from "@/features/auth/lib/observe-client";
import { ALERT_WAIT_MILLISECONDS } from "@/features/auth/lib/login-flow";
import { SESSION_COOKIE_NAME, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS } from "@/features/deploy-redeploy/lib/redeploy-accept-client";
import { INCIDENT_RECHECK_TIMEOUT_MILLISECONDS, REDEPLOY_INCIDENT_TEXT } from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import { branchFrom, installCommitGraph, type GraphCommit } from "@/features/deploy-redeploy/lib/redeploy-test-fakes";
import { MASTER_DEPLOYS_PATH, createFakeMaster, deploymentJson, minutesAfterStart, type FakeMaster } from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import { deployIncidentId, errorLogsIncidentId, monitorIncidentId, resourceIncidentId } from "@/features/incidents/lib/incident-id";
import {
  MINUTE, NOW, alertRecordsBody, emptySeriesBody, firingRow, iso, latestBody, latestServerRow, logRow, logsBody, monitorsBody, seenContainersBody,
} from "@/features/incidents/lib/incidents-test-fakes";
import type { RoutedFetchHandler } from "@/shared/lib/upstream-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, jsonBody,
} from "@/shared/lib/upstream-test-fakes";
import { UPSTREAM_TIMEOUT_MILLISECONDS } from "@/shared/lib/upstream-result";

const ACCEPT_PATH = "/deploy";
/** 가짜 타이머를 켜기 전의 진짜 setTimeout — 비밀번호 해시 확인(네이티브 스레드)이 끝나기를 실제 시간으로 기다릴 때만 쓴다. */
const realSetTimeout = globalThis.setTimeout;
const realPause = (milliseconds: number) => new Promise<void>((resolve) => { realSetTimeout(resolve, milliseconds); });
const FAILED_REQUEST_ID = "req-backend-failed-1";

let passwordHash = "";
/** 접수의 속도 제한(계정당 1분에 5번)이 테스트 사이에 이어지지 않게 테스트마다 시계를 민다. */
let testClock = NOW;
let main: GraphCommit[];
let master: FakeMaster;
/** 출처마다의 답 — 테스트가 바꿔 끼운다(늦게 답하게 하는 것 포함). */
let monitorsResponse: () => Response | Promise<Response>;
let latestResponse: () => Response | Promise<Response>;
let errorLogRows: Record<string, unknown>[];
/** 나간 호출(출처:경로[?service=]) — POST 하나 동안만 센다. */
let calls: string[] = [];
const observeAttempts: Record<string, unknown>[] = [];
const consoleLines: string[] = [];

type Renderer = { renderToStaticMarkup: (node: unknown) => string };

async function renderPreview(searchParams: Record<string, string>): Promise<string> {
  const element = await RedeployPreviewPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  return ((await import(/* @vite-ignore */ rendererModuleName)) as Renderer).renderToStaticMarkup(element);
}

function hiddenFields(html: string): Record<string, string> {
  const form = /<form[\s>][\s\S]*?<\/form>/i.exec(html);
  expect(form, "확인 화면의 접수 폼").not.toBeNull();
  const fields: Record<string, string> = {};
  for (const match of form![0].matchAll(/<input[^>]*>/gi)) {
    if (!/type="hidden"/.test(match[0])) continue;
    fields[/name="([^"]*)"/.exec(match[0])![1]] = /value="([^"]*)"/.exec(match[0])![1].replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  }
  return fields;
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

function acceptRequest(fields: Record<string, string>): Request {
  return new Request(new URL("/api/deploys/redeploy", FAKE_ORIGIN), {
    method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { origin: FAKE_ORIGIN, "content-type": "application/x-www-form-urlencoded", "x-real-ip": "198.51.100.77", "user-agent": "FakeBrowser/1.0" },
  });
}

const masterAccepts = () => master.fetch.mock.calls.filter(([input]) => new URL(input).pathname === ACCEPT_PATH);

/** 호출 목록을 세어 정렬한 [이름, 수] — 종류별 수의 비교에 쓴다. */
function counted(list: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const name of list) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort(([left], [right]) => left.localeCompare(right));
}

function callName(url: URL): string {
  const origin = url.origin === new URL(FAKE_ALERT_URL).origin ? "alert" : url.origin === new URL(FAKE_OBSERVE_URL).origin ? "observe" : "master";
  const service = url.searchParams.get("service");
  return `${origin}:${url.pathname}${url.pathname === MASTER_DEPLOYS_PATH && service !== null ? `?service=${service}` : ""}`;
}

/** 문제의 종류마다 — 그 문제를 열어 두는 출처의 답과 그 ID. 다른 출처는 조용하다(감시 대상 UP · 발화 없음 · 오류 없음 · 마지막 배포 성공). */
const KINDS = {
  monitor_down: {
    incidentId: () => monitorIncidentId("backend"),
    arrange: () => { monitorsResponse = () => jsonBody(monitorsBody([{ name: "backend", status: "DOWN", down_since: iso(NOW - 20 * MINUTE), reason: "status 502" }])); },
    recheckReads: ["alert:/monitors"],
  },
  deploy_failed: {
    incidentId: () => deployIncidentId("backend", FAILED_REQUEST_ID),
    arrange: () => { master.deployments.unshift(deploymentJson("backend", main[2].sha, "failed", minutesAfterStart(50), { request_id: FAILED_REQUEST_ID })); },
    recheckReads: [`master:${MASTER_DEPLOYS_PATH}`],
  },
  error_logs: {
    incidentId: () => errorLogsIncidentId("backend"),
    arrange: () => { errorLogRows = [logRow({ service: "backend", message: "boom" }), logRow({ id: `${NOW - MINUTE}-1`, service: "backend", message: "boom 2" })]; },
    recheckReads: ["observe:/logs"],
  },
  resource_threshold: {
    incidentId: () => resourceIncidentId("s158", "disk_warning", null),
    arrange: () => { latestResponse = () => jsonBody(latestBody([latestServerRow("s158", [["backend-app-blue", "backend-app"]])], [firingRow({ server: "s158", rule: "disk_warning" })])); },
    recheckReads: ["observe:/metrics/latest"],
  },
} as const;
type KindName = keyof typeof KINDS;

/** 그 종류의 문제에서 되돌리기로 연 확인 화면의 폼 칸(+ 비밀번호). */
async function incidentFields(kind: KindName): Promise<Record<string, string>> {
  const html = await renderPreview({ service: "backend", incident: KINDS[kind].incidentId(), action: "rollback" });
  return { ...hiddenFields(html), password: FAKE_PASSWORD };
}

beforeAll(async () => {
  passwordHash = await hash(FAKE_PASSWORD, { algorithm: 2 });
});

beforeEach(() => {
  testClock += 61_000;
  vi.useFakeTimers({ toFake: ["Date"] });
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
  calls = [];
  monitorsResponse = () => jsonBody(monitorsBody([{ name: "backend", status: "UP", down_since: "", reason: "" }]));
  latestResponse = () => jsonBody(latestBody([latestServerRow("s158", [["backend-app-blue", "backend-app"]])], []));
  errorLogRows = [];
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
    calls.push(callName(url));
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
      if (url.pathname === "/metrics/latest") return latestResponse();
      if (url.pathname === "/metrics/containers") return jsonBody(seenContainersBody(url.searchParams.get("server")!, Date.parse(url.searchParams.get("at")!), ["backend-app"]));
      if (url.pathname === "/metrics/series") return jsonBody(emptySeriesBody(url.searchParams));
      if (url.pathname === "/logs") {
        const level = url.searchParams.get("level");
        const rows = level === "error" || level === null ? errorLogRows : [];
        return jsonBody(logsBody(rows, url.searchParams.get("from") ?? iso(NOW - 10 * MINUTE), url.searchParams.get("to") ?? iso(NOW)));
      }
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

describe("다시 정하기는 필요한 것만 읽는다 — 종류별 호출 수", () => {
  it.each(Object.keys(KINDS) as KindName[])("%s — 그 문제를 가르는 출처 하나 + 그 서비스의 이력만 · 첫 걸음과 같은 판으로 303", async (kind) => {
    KINDS[kind].arrange();
    const fields = await incidentFields(kind);
    expect(fields.commit, "첫 걸음이 정한 판(되돌리기 — 지금 판의 바로 앞 성공 배포)").toBe(main[3].sha);
    calls = [];
    const response = await POST(acceptRequest(fields));
    expect(response.status, "다시 정한 서비스 · 판이 첫 걸음과 같다").toBe(303);
    expect(masterAccepts()).toHaveLength(1);
    expect(JSON.parse(String(masterAccepts()[0][1]?.body))).toMatchObject({ service: "backend", commit_sha: main[3].sha });
    // 다시 정하기(출처 하나 + 그 서비스의 이력) + 비밀번호(관측 판정 하나) + 이력 재확인(그 서비스의 이력) + 접수 하나
    expect(counted(calls)).toEqual(counted([
      ...KINDS[kind].recheckReads, `master:${MASTER_DEPLOYS_PATH}?service=backend`,
      "observe:/auth/attempts", `master:${MASTER_DEPLOYS_PATH}?service=backend`, `master:${ACCEPT_PATH}`,
    ]));
  });

  it("버전 모드는 다시 정하지 않는다 — 비밀번호 · 이력 재확인 · 접수뿐", async () => {
    const fields = { ...hiddenFields(await renderPreview({ service: "backend", commit: main[3].sha })), password: FAKE_PASSWORD };
    calls = [];
    expect((await POST(acceptRequest(fields))).status).toBe(303);
    expect(counted(calls)).toEqual(counted(["observe:/auth/attempts", `master:${MASTER_DEPLOYS_PATH}?service=backend`, `master:${ACCEPT_PATH}`]));
  });
});

describe("다시 정하기 전체의 기한 8초(절대)", () => {
  const INCIDENT = monitorIncidentId("backend");
  const timeoutLine = (commitSha: string) =>
    `redeploy:incident_changed reason=recheck_timeout service=backend commit=${commitSha.slice(0, 7)} account=${FAKE_ADMIN_ID} incident=${INCIDENT}`;
  /** ms 뒤에 답하는 응답(가짜 타이머가 민다). */
  const after = (milliseconds: number, response: () => Response) => () => new Promise<Response>((resolve) => { setTimeout(() => resolve(response()), milliseconds); });
  const downMonitors = () => jsonBody(monitorsBody([{ name: "backend", status: "DOWN", down_since: iso(NOW - 20 * MINUTE), reason: "status 502" }]));

  async function openedFields(): Promise<Record<string, string>> {
    KINDS.monitor_down.arrange();
    const fields = await incidentFields("monitor_down");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(testClock + 1_000);
    return fields;
  }

  /** POST 를 보내고 그 응답이 정해졌는가를 지켜본다. */
  function watch(response: Promise<Response>) {
    const state: { settled: Response | null } = { settled: null };
    void response.then((value) => { state.settled = value; });
    return state;
  }

  it("넘으면 409 recheck_timeout · 까닭 한 줄 · 비밀번호 확인 0 · 접수 0 · 늦게 끝난 읽기는 접수로 이어지지 않는다", async () => {
    const fields = await openedFields();
    let release: (response: Response) => void = () => undefined;
    monitorsResponse = () => new Promise<Response>((resolve) => { release = resolve; });
    const state = watch(POST(acceptRequest(fields)));
    await vi.advanceTimersByTimeAsync(INCIDENT_RECHECK_TIMEOUT_MILLISECONDS - 1);
    expect(state.settled, "8초 전에는 답하지 않는다").toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled, "8초에 답한다").not.toBeNull();
    const response = state.settled!;
    expect(response.status).toBe(409);
    const text = textOf(await response.text());
    expect(text).toContain(REDEPLOY_INCIDENT_TEXT.changed);
    expect(text).toContain("상태를 제때 확인하지 못했습니다");
    expect(REDEPLOY_INCIDENT_TEXT.recheckTimeout).toBe("상태를 제때 확인하지 못했습니다");
    expect(consoleLines.some((line) => line.endsWith(timeoutLine(fields.commit)))).toBe(true);
    // 늦게 끝난 읽기 — 열린 문제 그대로 답해도 이어지지 않는다
    release(downMonitors());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(observeAttempts, "비밀번호 확인 0").toEqual([]);
    expect(masterAccepts(), "접수 0").toEqual([]);
  });

  it("기한은 다시 정하기 전체에 하나 — 읽기 하나하나는 5초 안이어도 합이 8초를 넘으면 409", async () => {
    const fields = await openedFields();
    monitorsResponse = after(4_500, downMonitors);
    (master.override as Record<string, RoutedFetchHandler>)[MASTER_DEPLOYS_PATH] = (url) => new Promise<Response>((resolve) => {
      setTimeout(() => {
        const service = url.searchParams.get("service");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        resolve(jsonBody({ success: true, data: { deployments: master.deployments.filter((row) => service === null || row.service === service).slice(0, limit) } }));
      }, 4_500);
    });
    const state = watch(POST(acceptRequest(fields)));
    await vi.advanceTimersByTimeAsync(INCIDENT_RECHECK_TIMEOUT_MILLISECONDS);
    expect(state.settled?.status).toBe(409);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(observeAttempts).toEqual([]);
    expect(masterAccepts()).toEqual([]);
    expect(consoleLines.some((line) => line.endsWith(timeoutLine(fields.commit)))).toBe(true);
  });

  it("8초 안이면 지금 그대로 — 7.9초에 답해도 303", async () => {
    const fields = await openedFields();
    monitorsResponse = after(INCIDENT_RECHECK_TIMEOUT_MILLISECONDS - 100, downMonitors);
    const state = watch(POST(acceptRequest(fields)));
    await vi.advanceTimersByTimeAsync(INCIDENT_RECHECK_TIMEOUT_MILLISECONDS - 100);
    // 다시 정하기가 끝난 뒤의 걸음(비밀번호 해시 확인은 실제 시간이 든다) — 가짜 시계는 1ms 씩만 밀고 실제로 기다린다
    for (let round = 0; round < 200 && state.settled === null; round += 1) {
      await vi.advanceTimersByTimeAsync(1);
      await realPause(20);
    }
    expect(state.settled?.status).toBe(303);
    expect(masterAccepts()).toHaveLength(1);
  });
});

describe("접수 경로의 가장 긴 합이 nginx 의 30초 아래", () => {
  /** nginx 가 앱의 답을 기다리는 길이(초) — deploy/nginx/nginx.conf 의 proxy_read_timeout(여럿이면 가장 짧은 것). */
  function nginxReadTimeoutMilliseconds(): number {
    const conf = readFileSync(path.join(process.cwd(), "deploy/nginx/nginx.conf"), "utf8");
    const values = [...conf.matchAll(/^\s*proxy_read_timeout\s+(\d+)s;/gm)].map((match) => Number(match[1]) * 1000);
    expect(values.length).toBeGreaterThan(0);
    return Math.min(...values);
  }

  it("상수의 값 — 다시 정하기 8초", () => {
    expect(INCIDENT_RECHECK_TIMEOUT_MILLISECONDS).toBe(8_000);
    expect(nginxReadTimeoutMilliseconds()).toBe(30_000);
  });

  it("문제 모드: 다시 정하기 + 관측 판정 + 이력 재확인 + 접수 < 30초 · 잠금 길(다시 정하기 + 관측 판정 + 잠금 알림 대기) < 30초", () => {
    // 접수 앞의 걸음(출처 · 세션 · 속도 제한 · 본문 · 확인 값)은 다른 서버를 부르지 않는다 — 본문은 nginx 가 모아 넘긴다
    const toAccept = INCIDENT_RECHECK_TIMEOUT_MILLISECONDS + OBSERVE_TIMEOUT_MILLISECONDS + UPSTREAM_TIMEOUT_MILLISECONDS + REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS;
    const toLock = INCIDENT_RECHECK_TIMEOUT_MILLISECONDS + OBSERVE_TIMEOUT_MILLISECONDS + ALERT_WAIT_MILLISECONDS;
    expect(toAccept).toBeLessThan(nginxReadTimeoutMilliseconds());
    expect(toLock).toBeLessThan(nginxReadTimeoutMilliseconds());
  });

  it("버전 모드: 관측 판정 + 이력 재확인 + 접수 < 30초", () => {
    expect(OBSERVE_TIMEOUT_MILLISECONDS + UPSTREAM_TIMEOUT_MILLISECONDS + REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS).toBeLessThan(nginxReadTimeoutMilliseconds());
  });
});
