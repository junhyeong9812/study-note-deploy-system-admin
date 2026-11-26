/** 문제 화면의 조치(되돌리기 · 다시 배포 — 명세 ⑫ §24) — 실제 렌더 + 가짜 서버(알림 · 관측 · master) + 가짜 Redis(분석의 권함).
 * 계약(문제 하나의 근거 화면):
 * - 구역 `<section aria-labelledby="incident-actions">`(제목 INCIDENT_ACTION_TEXT.title). 서비스가 하나로 정해질 때만 조치 — 정할 수 없으면 그 까닭 한 줄.
 * - 조치는 ⑥ 의 첫 걸음으로 가는 링크(GET — 스크립트 없이 동작 · 이 화면은 읽기 전용이라 폼 · 단추를 두지 않는다):
 *   `/deploys/redeploy?service=<서비스>&incident=<ID>&action=redeploy|rollback` — commit 을 싣지 않는다. 글은 `<조치 이름> — <짧은 SHA 7자>`(판은 보이되 싣지 않는다).
 *   판은 목록의 배포 이력(12-1 이 이미 읽은 것)에서 incidentActionTargets 로 — 정할 수 없으면 그 조치는 링크 대신 까닭 한 줄.
 * - Claude 가 권함: 가장 최근 분석(12-4 — 같은 발생의 것 · 끝난 것)의 recommended_action 이 정확히 rollback · redeploy 면 그 조치 줄에 INCIDENT_ACTION_TEXT.recommended.
 *   표시가 있어도 없어도 링크는 같다 · 분석이 없음 · 실패 · 진행 중 · 옛 발생 · "none" 이면 표시 없음.
 * - 이 문제에서 접수한 조치: 배포 이력에서 요청한 사람이 정확히 `admin:<계정>:incident:<이 ID>` 인 줄만(배포 이력의 그 배포로 가는 링크) · 새 저장 없음. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import IncidentsPage from "@/app/incidents/page";
import { SESSION_COOKIE_NAME, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { FAKE_CLAUDE_RUNNER_URL } from "@/features/claude-usage/lib/claude-runner-test-fakes";
import {
  FAKE_CLAUDE_RUNNER_CALL_SECRET, FAKE_LOG_REDIS_URL, SHARED_FAKE_REDIS_STATE, resetFakeRedisState,
} from "@/features/incident-analysis/lib/analysis-test-fakes";
import { incidentAnalysisKeys, type StoredAnalysisAttempt } from "@/features/incident-analysis/lib/incident-analysis-service";
import { resetIncidentAnalysisService } from "@/features/incident-analysis/server/incident-analysis";
import { INCIDENT_ACTION_TEXT } from "@/features/incidents/lib/incident-actions";
import {
  MINUTE, NOW, alertRecordsBody, deploymentRow, deploymentsBody, emptySeriesBody, iso, latestBody, latestServerRow, logsBody, monitorsBody, seenContainersBody,
} from "@/features/incidents/lib/incidents-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, jsonBody, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const INCIDENT = "monitor:backend";
const DOWN_SINCE = iso(NOW - 20 * MINUTE);
const SHA = (seed: string) => seed.repeat(40).slice(0, 40);
const CURRENT = SHA("c");
const PREVIOUS = SHA("b");

let monitorsResponse: () => Response;
let deploymentRows: Record<string, unknown>[];
let deploysResponse: () => Response;

async function renderIncident(incidentId = INCIDENT): Promise<string> {
  const element = await IncidentsPage({ searchParams: Promise.resolve({ incident: incidentId }) });
  const rendererModuleName = "react-dom/server";
  return ((await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string }).renderToStaticMarkup(element);
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

function actionsSection(html: string): string {
  const match = /<section[^>]*aria-labelledby="incident-actions"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  expect(match, "조치 구역이 없다").not.toBeNull();
  return match![1];
}

/** 조치 구역의 링크(주소 → 글). */
function actionLinks(section: string): { href: string; text: string; item: string }[] {
  const items = [...section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) => match[1]);
  return items.flatMap((item) => [...item.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((match) => ({ href: match[1].replace(/&amp;/g, "&"), text: textOf(match[2]), item: textOf(item) })))
    .filter((link) => link.href.startsWith("/deploys/redeploy"));
}

function storeAnalysis(attempt: Partial<StoredAnalysisAttempt>, incidentId = INCIDENT) {
  const keys = incidentAnalysisKeys(incidentId);
  const requestId = attempt.requestId ?? `adm-analysis-${SHARED_FAKE_REDIS_STATE.strings.size + 1}`;
  const value: StoredAnalysisAttempt = {
    version: 1, requestId, incidentId, incidentSince: DOWN_SINCE, account: `admin:${FAKE_ADMIN_ID}`, startedAt: iso(NOW - 5 * MINUTE),
    prompt: "보낸 글", promptBytes: 10, state: "succeeded", finishedAt: iso(NOW - 4 * MINUTE), durationMilliseconds: 40_000,
    answer: { cause: "원인", evidence: ["근거"], confidence: "high", remedy: "대처", recommendedAction: "rollback" }, failureReason: null, ...attempt,
  };
  SHARED_FAKE_REDIS_STATE.strings.set(keys.attempt(requestId), { value: JSON.stringify(value), expiresAt: null });
  const list = SHARED_FAKE_REDIS_STATE.lists.get(keys.history) ?? { items: [], expiresAt: null };
  list.items.unshift(requestId);
  SHARED_FAKE_REDIS_STATE.lists.set(keys.history, list);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries({
    SESSION_SECRET: FAKE_SIGNING_KEY, ADMIN_ORIGIN: FAKE_ORIGIN, ADMIN_USER: FAKE_ADMIN_ID, ALERT_URL: FAKE_ALERT_URL, ALERT_SECRET: FAKE_ALERT_SECRET,
    OBSERVE_URL: FAKE_OBSERVE_URL, OBSERVE_SECRET: FAKE_OBSERVE_SECRET, BACKEND_URL: FAKE_BACKEND_URL, DEPLOY_MASTER_URL: FAKE_DEPLOY_MASTER_URL,
    DEPLOY_SECRET: FAKE_DEPLOY_SECRET, CLAUDE_RUNNER_URL: FAKE_CLAUDE_RUNNER_URL, CLAUDE_RUNNER_SECRET: FAKE_CLAUDE_RUNNER_CALL_SECRET, LOG_REDIS_URL: FAKE_LOG_REDIS_URL,
  })) vi.stubEnv(name, value);
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, NOW - 60_000));
  resetFakeRedisState(SHARED_FAKE_REDIS_STATE);
  resetIncidentAnalysisService();
  monitorsResponse = () => jsonBody(monitorsBody([{ name: "backend", status: "DOWN", down_since: DOWN_SINCE, reason: "status 502" }]));
  deploymentRows = [
    deploymentRow({ request_id: "req-now", service: "backend", commit_sha: CURRENT, accepted_at: iso(NOW - 3 * 60 * MINUTE) }),
    deploymentRow({ request_id: "req-front", service: "front", commit_sha: SHA("f"), accepted_at: iso(NOW - 4 * 60 * MINUTE) }),
    deploymentRow({ request_id: "req-before", service: "backend", commit_sha: PREVIOUS, accepted_at: iso(NOW - 5 * 60 * MINUTE) }),
  ];
  deploysResponse = () => jsonBody(deploymentsBody(deploymentRows));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.origin === new URL(FAKE_ALERT_URL).origin) return url.pathname === "/monitors" ? monitorsResponse() : jsonBody(alertRecordsBody([]));
    if (url.origin === new URL(FAKE_DEPLOY_MASTER_URL).origin) {
      if (url.pathname === "/deploys") return deploysResponse();
      return jsonBody({ success: true, data: { commits: [], truncated: false, range_complete: true, relation: "ancestor" } });
    }
    if (url.pathname === "/metrics/latest") return jsonBody(latestBody([latestServerRow("s158", [["backend-app-blue", "backend-app"]])], []));
    if (url.pathname === "/metrics/containers") return jsonBody(seenContainersBody(url.searchParams.get("server")!, Date.parse(url.searchParams.get("at")!), ["backend-app"]));
    if (url.pathname === "/metrics/series") return jsonBody(emptySeriesBody(url.searchParams));
    if (url.pathname === "/logs") return jsonBody(logsBody([], url.searchParams.get("from") ?? iso(NOW - 10 * MINUTE), url.searchParams.get("to") ?? iso(NOW)));
    throw new Error(`unexpected ${url.href}`);
  }));
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("조치 — ⑥ 의 확인 화면으로 가는 링크", () => {
  it("다시 배포 · 되돌리기 — 주소에 서비스 · ID · 조치만(commit 없음) · 글에 판의 짧은 SHA", async () => {
    const section = actionsSection(await renderIncident());
    expect(textOf(section)).toContain(INCIDENT_ACTION_TEXT.title);
    expect(actionLinks(section).map(({ href, text }) => [href, text])).toEqual([
      ["/deploys/redeploy?service=backend&incident=monitor%3Abackend&action=redeploy", `다시 배포 — ${CURRENT.slice(0, 7)}`],
      ["/deploys/redeploy?service=backend&incident=monitor%3Abackend&action=rollback", `되돌리기 — ${PREVIOUS.slice(0, 7)}`],
    ]);
    for (const { href } of actionLinks(section)) expect(href).not.toContain("commit");
  });

  it("화면은 읽기 전용 그대로 — 폼 · 단추 · 입력 칸이 없다", async () => {
    const html = await renderIncident();
    for (const tag of ["<form", "<button", "<input"]) expect(/<main[\s\S]*<\/main>/.exec(html)![0]).not.toContain(tag);
  });

  it("서비스를 하나로 정할 수 없으면(대응 표에 없는 감시 대상) 링크 대신 까닭 한 줄", async () => {
    monitorsResponse = () => jsonBody(monitorsBody([{ name: "deploy-master", status: "DOWN", down_since: DOWN_SINCE, reason: "x" }]));
    const section = actionsSection(await renderIncident("monitor:deploy-master"));
    expect(actionLinks(section)).toEqual([]);
    expect(textOf(section)).toContain(INCIDENT_ACTION_TEXT.serviceReasons.unmapped);
  });

  it("되돌릴 판이 없으면(성공한 배포가 하나뿐) 되돌리기만 까닭 · 바로 앞이 같은 판이어도", async () => {
    deploymentRows = [deploymentRows[0]];
    let section = actionsSection(await renderIncident());
    expect(actionLinks(section).map(({ href }) => href.split("action=")[1])).toEqual(["redeploy"]);
    expect(textOf(section)).toContain(INCIDENT_ACTION_TEXT.targetReasons.single_succeeded);
    deploymentRows = [deploymentRow({ request_id: "a", service: "backend", commit_sha: CURRENT }), deploymentRow({ request_id: "b", service: "backend", commit_sha: CURRENT })];
    section = actionsSection(await renderIncident());
    expect(textOf(section)).toContain(INCIDENT_ACTION_TEXT.targetReasons.same_as_current);
  });

  it("배포 이력을 읽지 못하면 두 조치 모두 까닭", async () => {
    deploysResponse = () => textResponse("", 503);
    const section = actionsSection(await renderIncident());
    expect(actionLinks(section)).toEqual([]);
    expect(textOf(section)).toContain(INCIDENT_ACTION_TEXT.targetReasons.history_unavailable);
  });
});

describe("Claude 가 권함 — 표시일 뿐", () => {
  const recommendedOn = async () => {
    const links = actionLinks(actionsSection(await renderIncident()));
    return { links, marked: links.filter((link) => link.item.includes(INCIDENT_ACTION_TEXT.recommended)).map((link) => link.href.split("action=")[1]) };
  };

  it("가장 최근 분석이 rollback 이면 되돌리기 줄에 표시 · redeploy 면 다시 배포 줄에", async () => {
    storeAnalysis({});
    expect((await recommendedOn()).marked).toEqual(["rollback"]);
    resetFakeRedisState(SHARED_FAKE_REDIS_STATE);
    resetIncidentAnalysisService();
    storeAnalysis({ answer: { cause: "원인", evidence: ["근거"], confidence: "low", remedy: "대처", recommendedAction: "redeploy" } });
    expect((await recommendedOn()).marked).toEqual(["redeploy"]);
  });

  it("표시가 있어도 없어도 링크는 같다 · 권함의 글자가 주소에 실리지 않는다", async () => {
    const without = (await recommendedOn()).links.map(({ href }) => href);
    storeAnalysis({});
    const withMark = (await recommendedOn()).links.map(({ href }) => href);
    expect(withMark).toEqual(without);
    for (const href of withMark) expect(href).not.toMatch(/Claude|recommend|%EA%B6%8C/i);
  });

  it.each([
    ["분석 없음", () => undefined],
    ["\"none\"", () => storeAnalysis({ answer: { cause: "원인", evidence: ["근거"], confidence: "low", remedy: "대처", recommendedAction: "none" } })],
    ["실패한 분석", () => storeAnalysis({ state: "failed", answer: null, failureReason: "busy" })],
    ["진행 중", () => storeAnalysis({ state: "running", answer: null, finishedAt: null, durationMilliseconds: null })],
    ["옛 발생의 분석(since 가 다름)", () => storeAnalysis({ incidentSince: iso(NOW - 3 * 24 * 60 * MINUTE) })],
    ["최근 것이 실패 — 그 앞의 rollback 은 보지 않는다", () => { storeAnalysis({}); storeAnalysis({ state: "failed", answer: null, failureReason: "timeout" }); }],
  ])("%s → 표시 없음", async (_label, arrange) => {
    arrange();
    expect((await recommendedOn()).marked).toEqual([]);
  });

  it("저장소에 닿지 못하면 표시 없음 — 조치 링크는 그대로", async () => {
    storeAnalysis({});
    SHARED_FAKE_REDIS_STATE.down = true;
    const { links, marked } = await recommendedOn();
    expect(marked).toEqual([]);
    expect(links).toHaveLength(2);
  });
});

describe("이 문제에서 접수한 조치 — 배포 이력에서 걸러 보인다", () => {
  function actionsListText(html: string): string {
    return textOf(actionsSection(html));
  }

  it("요청한 사람이 정확히 admin:<계정>:incident:<이 ID> 인 배포만 — 접두가 같은 ID · 다른 문제 · 사람의 접수는 섞이지 않는다", async () => {
    deploymentRows = [
      ...deploymentRows,
      deploymentRow({ request_id: "req-mine-1", service: "backend", commit_sha: PREVIOUS, requested_by: `admin:${FAKE_ADMIN_ID}:incident:${INCIDENT}` }),
      deploymentRow({ request_id: "req-prefix", service: "backend", commit_sha: PREVIOUS, requested_by: `admin:${FAKE_ADMIN_ID}:incident:${INCIDENT}-deps` }),
      deploymentRow({ request_id: "req-other", service: "backend", commit_sha: PREVIOUS, requested_by: `admin:${FAKE_ADMIN_ID}:incident:errors:backend` }),
      deploymentRow({ request_id: "req-human", service: "backend", commit_sha: PREVIOUS, requested_by: `admin:${FAKE_ADMIN_ID}` }),
    ];
    const html = await renderIncident();
    const section = actionsSection(html);
    expect(textOf(section)).toContain(INCIDENT_ACTION_TEXT.actionsTitle);
    const hrefs = [...section.matchAll(/href="([^"]*)"/g)].map((match) => match[1].replace(/&amp;/g, "&")).filter((href) => href.startsWith("/deploys?"));
    expect(hrefs).toEqual(["/deploys?service=backend&selected=req-mine-1&selectedService=backend"]);
    expect(actionsListText(html)).not.toContain("req-prefix");
    expect(actionsListText(html)).not.toContain("req-other");
    expect(actionsListText(html)).not.toContain("req-human");
  });

  it("없으면 그 말 · 이력을 읽지 못하면 그 말", async () => {
    expect(actionsListText(await renderIncident())).toContain(INCIDENT_ACTION_TEXT.noActions);
    deploysResponse = () => textResponse("", 503);
    expect(actionsListText(await renderIncident())).toContain(INCIDENT_ACTION_TEXT.actionsUnavailable);
  });
});
