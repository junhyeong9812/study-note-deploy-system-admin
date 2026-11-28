/** 문제 화면 — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 알림 · 관측 · 배포 마스터 — 실제 응답 꼴)를 거친다.
 * 명세 ⑫ §2 (가): 읽기 전용(폼 · 단추 · 스크립트 없음) · 칸만 "확인하지 못함" · 로그인 뒤에만 · 비밀값 · 서버 주소가 화면에 없다 ·
 * 보낸 묶음과 사람이 보는 묶음이 같다(화면과 직렬화한 글이 같은 내용). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => false }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookieValue !== undefined && name === "admin_session" ? { name, value: state.cookieValue } : undefined),
    has: () => state.cookieValue !== undefined,
    getAll: () => [],
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import IncidentsPage from "@/app/incidents/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { ADMIN_SCREENS } from "@/features/admin-shell/ui/admin-screens";
import { incidentsScreenResponse } from "@/features/incidents/server/incidents-screen";
import type { IncidentsScreenData } from "@/features/incidents/lib/incidents-screen";
import type { IncidentEvidence } from "@/features/incidents/lib/incident-evidence";
import { deployIncidentId, errorLogsIncidentId, monitorIncidentId, resourceIncidentId } from "@/features/incidents/lib/incident-id";
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import {
  MINUTE, NOW, SECOND, alertRecordRow, alertRecordsBody, deploymentRow, deploymentsBody, emptySeriesBody, firingRow, iso, latestBody,
  latestServerRow, logRow, logsBody, monitorsBody, seenContainersBody,
} from "@/features/incidents/lib/incidents-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  createRoutedFetch, expectNoForbiddenText, jsonBody, textResponse,
} from "@/shared/lib/upstream-test-fakes";

type Handler = (url: URL) => Response | Promise<Response>;

const DOWN_AT = NOW - 20 * MINUTE;
const FAILED_SHA = "b".repeat(40);

/** 칸마다 다른 표식 — 화면과 글 양쪽에 같은 것이 있는지 본다. */
const MARK = {
  alert: "표식-알림-A1",
  frontLog: "표식-로그-F1",
  scriptLog: "<script>alert('x')</script> 표식-로그-F2",
  deployLog: "표식-배포로그-D1",
  llmLog: "표식-오류-L1",
  commit: "표식-커밋-C1",
} as const;

let overrides: Record<string, Handler> = {};

const ROUTES: Record<string, Handler> = {
  [`${FAKE_ALERT_URL}/monitors`]: () => jsonBody(monitorsBody([
    { name: "front", status: "DOWN", down_since: iso(DOWN_AT), reason: "status 502 <b>굵게</b>" },
    { name: "deploy-master", status: "DOWN", down_since: iso(NOW - 5 * MINUTE), reason: "꺼짐" },
    { name: "backend", status: "UP", down_since: "", reason: "" },
  ])),
  [`${FAKE_ALERT_URL}/incidents`]: () => jsonBody(alertRecordsBody([
    alertRecordRow({ at: iso(DOWN_AT), kind: "monitor_down", key: "front", title: `응답 없음: front ${MARK.alert}` }),
    alertRecordRow({ at: iso(NOW - 30 * MINUTE), kind: "event", key: `deploy-failed:backend:${FAILED_SHA}`, title: `배포 실패 backend ${MARK.alert}` }),
    alertRecordRow({ at: iso(NOW - 30 * MINUTE), kind: "event", key: "resource:s158:disk_warning", title: `디스크 ${MARK.alert}` }),
  ])),
  [`${FAKE_OBSERVE_URL}/metrics/latest`]: () => jsonBody(latestBody(
    [latestServerRow("s158", [["front-app-green", "front-app"], ["backend-app-blue", "backend-app"], ["llm-wrapper-blue", "llm-wrapper"]])],
    [firingRow({ server: "s158", rule: "disk_warning", since: iso(NOW - 30 * MINUTE), last_value: 86.2 })],
  )),
  [`${FAKE_OBSERVE_URL}/metrics/containers`]: (url) => jsonBody(seenContainersBody(url.searchParams.get("server")!, Date.parse(url.searchParams.get("at")!), ["front-app", "backend-app", "llm-wrapper"])),
  [`${FAKE_OBSERVE_URL}/metrics/series`]: (url) => jsonBody(emptySeriesBody(url.searchParams)),
  [`${FAKE_OBSERVE_URL}/logs`]: (url) => {
    const parameters = url.searchParams;
    const from = parameters.get("from")!;
    const to = parameters.get("to")!;
    let rows: Record<string, unknown>[] = [];
    if (parameters.get("request_id") === "req-failed-1") {
      rows = [logRow({ id: `${NOW - 31 * MINUTE}-0`, at: iso(NOW - 31 * MINUTE), level: "error", service: "backend", request_id: "req-failed-1", message: MARK.deployLog })];
    } else if (parameters.get("service") === "front") {
      rows = parameters.get("level") === "error"
        ? [logRow({ id: `${DOWN_AT + MINUTE}-0`, at: iso(DOWN_AT + MINUTE), level: "error", service: "front", message: MARK.scriptLog })]
        : [logRow({ id: `${DOWN_AT - MINUTE}-0`, at: iso(DOWN_AT - MINUTE), level: "warning", service: "front", message: MARK.frontLog })];
    } else if (parameters.get("level") === "error") {
      rows = [logRow({ id: `${NOW - MINUTE}-0`, at: iso(NOW - MINUTE), level: "error", service: "llm", message: MARK.llmLog })];
    }
    return jsonBody(logsBody(rows, from, to));
  },
  [`${FAKE_DEPLOY_MASTER_URL}/deploys`]: () => jsonBody(deploymentsBody([
    deploymentRow({ request_id: "req-failed-1", service: "backend", state: "failed", failed_stage: "ci_test", commit_sha: FAILED_SHA, accepted_at: iso(NOW - 40 * MINUTE), finished_at: iso(NOW - 30 * MINUTE) }),
    deploymentRow({ request_id: "req-ok-1", service: "backend", state: "succeeded", commit_sha: "c".repeat(40), accepted_at: iso(NOW - 3 * 60 * MINUTE) }),
  ])),
  [`${FAKE_DEPLOY_MASTER_URL}/deploys/git/commits`]: () => jsonBody({ success: true, data: {
    commits: [{ sha: FAILED_SHA, author_name: "jun", authored_at: iso(NOW - 2 * 60 * MINUTE), subject: MARK.commit, body: "", body_truncated: false }],
    truncated: false, range_complete: true, relation: "ancestor",
  } }),
};

const upstreamFetch = createRoutedFetch((url) => {
  const key = `${url.origin}${url.pathname}`;
  const route = overrides[key] ?? ROUTES[key];
  if (!route) throw new Error(`unexpected ${url.pathname}`);
  return route(url);
});

async function render(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const element = await IncidentsPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

async function apiData(incident: string): Promise<IncidentsScreenData> {
  const response = await incidentsScreenResponse(new Request(new URL(`/api/incidents?incident=${encodeURIComponent(incident)}`, FAKE_ORIGIN)));
  expect(response.status).toBe(200);
  return (await response.json()).data as IncidentsScreenData;
}

function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function textOf(fragment: string): string {
  return unescapeHtml(fragment.replace(/<[^>]+>/g, ""));
}

function mainOf(html: string): string {
  const match = /<main[^>]*>([\s\S]*)<\/main>/.exec(html);
  expect(match, "main 이 없다").not.toBeNull();
  return match![1];
}

function sectionOf(html: string, key: string): string {
  const match = new RegExp(`<section[^>]*aria-labelledby="evidence-${key}"[^>]*>([\\s\\S]*?)</section>`).exec(html);
  expect(match, `${key} 구역이 없다`).not.toBeNull();
  return match![1];
}

function hrefsOf(fragment: string): string[] {
  return [...fragment.matchAll(/href="([^"]*)"/g)].map((match) => unescapeHtml(match[1]));
}

/** 목록의 줄 — 그 문제로 가는 링크가 든 <tr> 의 칸 글. */
function listRow(html: string, id: string): string[] {
  const href = `/incidents?incident=${encodeURIComponent(id)}`.replace(/&/g, "&amp;");
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => match[1]).filter((row) => row.includes(`href="${href}"`));
  expect(rows, `${id} 줄이 없다`).toHaveLength(1);
  return [...rows[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => textOf(cell[1]));
}

function listedIds(html: string): string[] {
  const list = /<section[^>]*aria-labelledby="incident-list"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  expect(list, "목록 구역이 없다").not.toBeNull();
  return hrefsOf(list![1]).filter((href) => href.startsWith("/incidents?incident=")).map((href) => new URL(href, FAKE_ORIGIN).searchParams.get("incident")!);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("ALERT_URL", FAKE_ALERT_URL);
  vi.stubEnv("ALERT_SECRET", FAKE_ALERT_SECRET);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("BACKEND_URL", FAKE_BACKEND_URL);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, NOW - 60_000);
  overrides = {};
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("목록 — 종류 · 대상 · 언제부터 · 심한 정도가 글로", () => {
  it("열린 문제가 정렬된 차례로, 줄마다 그 문제로 가는 링크", async () => {
    const html = await render();
    expect(listedIds(html)).toEqual([
      monitorIncidentId("front"), monitorIncidentId("deploy-master"), deployIncidentId("backend", "req-failed-1"),
      resourceIncidentId("s158", "disk_warning", null), errorLogsIncidentId("llm"),
    ]);
  });

  it("칸 — 종류 · 대상 · 언제부터(KST, 모르면 '최근 10분') · 심한 정도(색이 아니라 글자)", async () => {
    const html = await render();
    const headers = [...mainOf(html).matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((match) => match[1]);
    expect(headers).toEqual(["종류", "대상", "언제부터", "심한 정도"]);
    expect(listRow(html, monitorIncidentId("front"))).toEqual(["감시 대상 DOWN", "front", formatKoreanTime(iso(DOWN_AT)), "위험"]);
    expect(listRow(html, deployIncidentId("backend", "req-failed-1"))).toEqual(["배포 실패", "backend", formatKoreanTime(iso(NOW - 30 * MINUTE)), "경고"]);
    expect(listRow(html, resourceIncidentId("s158", "disk_warning", null))).toEqual(["자원 임계값", "서버 s158 디스크 경고", formatKoreanTime(iso(NOW - 30 * MINUTE)), "경고"]);
    expect(listRow(html, errorLogsIncidentId("llm"))).toEqual(["오류 로그", "llm — 오류 1건", "최근 10분", "경고"]);
  });

  it("'급증'이라는 낱말이 화면에 없다", async () => {
    expect(await render()).not.toContain("급증");
  });

  it("한 출처가 실패하면 목록 위에 그 줄 · 다른 출처의 문제는 보인다", async () => {
    overrides[`${FAKE_ALERT_URL}/monitors`] = () => textResponse("", 503);
    const html = await render();
    expect(textOf(mainOf(html))).toContain("알림 서버(감시 대상): 확인하지 못함 — 서버 일시 장애");
    expect(listedIds(html)).toEqual([deployIncidentId("backend", "req-failed-1"), resourceIncidentId("s158", "disk_warning", null), errorLogsIncidentId("llm")]);
    expect(textOf(mainOf(html))).not.toContain("열린 문제가 없습니다");
  });

  it("문제가 없으면 '열린 문제가 없습니다', 실패가 있으면 '확인된 범위에서는 열린 문제가 없습니다'", async () => {
    overrides[`${FAKE_ALERT_URL}/monitors`] = () => jsonBody(monitorsBody([]));
    overrides[`${FAKE_OBSERVE_URL}/metrics/latest`] = () => jsonBody(latestBody([latestServerRow("s158")], []));
    overrides[`${FAKE_DEPLOY_MASTER_URL}/deploys`] = () => jsonBody(deploymentsBody([deploymentRow()]));
    overrides[`${FAKE_OBSERVE_URL}/logs`] = (url) => jsonBody(logsBody([], url.searchParams.get("from")!, url.searchParams.get("to")!));
    expect(textOf(mainOf(await render()))).toContain("열린 문제가 없습니다");
    overrides[`${FAKE_DEPLOY_MASTER_URL}/deploys`] = () => textResponse("", 503);
    const main = textOf(mainOf(await render()));
    expect(main).toContain("확인된 범위에서는 열린 문제가 없습니다");
    expect(main.replace("확인된 범위에서는 열린 문제가 없습니다", "")).not.toContain("열린 문제가 없습니다");
  });
});

describe("문제 하나 — 칸마다 제목이 있는 구역", () => {
  it("구역 다섯이 이 차례로(제목 글자)", async () => {
    const html = await render({ incident: monitorIncidentId("front") });
    const titles = ["facts", "alertHistory", "logs", "deployments", "resources"].map((key) => {
      const match = new RegExp(`<h2[^>]*id="evidence-${key}"[^>]*>([^<]*)</h2>`).exec(html);
      expect(match, key).not.toBeNull();
      return [match!.index, match![1]] as const;
    });
    expect(titles.map(([, title]) => title)).toEqual(["무엇이 · 언제부터", "관련 알림", "로그", "배포", "자원"]);
    expect(titles.map(([index]) => index)).toEqual([...titles.map(([index]) => index)].sort((left, right) => left - right));
  });

  it("링크 — 로그 줄은 로그 화면의 그 줄, 배포는 배포 이력의 그 배포, 자원은 서버 자원 화면의 그 서버(그 밖의 화면으로는 가지 않는다)", async () => {
    const down = await render({ incident: monitorIncidentId("front") });
    const logHrefs = hrefsOf(sectionOf(down, "logs"));
    expect(logHrefs.length).toBe(2);
    for (const href of logHrefs) {
      expect(href.startsWith("/logs?")).toBe(true);
      expect(new URL(href, FAKE_ORIGIN).searchParams.get("selected")).toMatch(/^\d+-0$/);
    }
    const failed = await render({ incident: deployIncidentId("backend", "req-failed-1") });
    expect(hrefsOf(sectionOf(failed, "deployments"))).toContain("/deploys?selected=req-failed-1&selectedService=backend");
    const threshold = await render({ incident: resourceIncidentId("s158", "disk_warning", null) });
    expect(hrefsOf(sectionOf(threshold, "resources"))).toContain("/resources?range=1h#resource-server-s158");
    for (const html of [down, failed, threshold]) {
      for (const href of hrefsOf(mainOf(html))) expect(href, href).toMatch(/^\/(incidents|logs|deploys|resources)([?#]|$)/);
    }
  });

  it("로그 · 사유의 글은 글자로(태그가 해석되지 않는다)", async () => {
    const html = await render({ incident: monitorIncidentId("front") });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt; 표식-로그-F2");
    expect(html).toContain("&lt;b&gt;굵게&lt;/b&gt;");
  });

  it("대응 표에 없는 대상 — 로그 · 자원 칸은 '확인할 수 없음 — 대응 표에 없음', 알림 · 배포는 보인다", async () => {
    const html = await render({ incident: monitorIncidentId("deploy-master") });
    expect(textOf(sectionOf(html, "logs"))).toContain("확인할 수 없음 — 대응 표에 없음");
    expect(textOf(sectionOf(html, "resources"))).toContain("확인할 수 없음 — 대응 표에 없음");
    expect(textOf(sectionOf(html, "facts"))).toContain("대응 표에 없음");
    expect(textOf(sectionOf(html, "deployments"))).not.toContain("확인");
  });

  it("한 칸의 조회가 실패하면 그 칸만 '확인하지 못함 — <사유>', 다른 칸은 값", async () => {
    overrides[`${FAKE_ALERT_URL}/incidents`] = () => textResponse("", 503);
    const html = await render({ incident: monitorIncidentId("front") });
    expect(textOf(sectionOf(html, "alertHistory"))).toContain("확인하지 못함 — 서버 일시 장애");
    expect(textOf(sectionOf(html, "logs"))).toContain(MARK.frontLog);
    expect(textOf(sectionOf(html, "logs"))).not.toContain("확인하지 못함");
  });
});

describe("읽기 전용 · 비밀값 없음", () => {
  it.each([
    ["목록", {}], ["감시 대상 DOWN", { incident: monitorIncidentId("front") }], ["배포 실패", { incident: deployIncidentId("backend", "req-failed-1") }],
    ["자원 임계값", { incident: resourceIncidentId("s158", "disk_warning", null) }], ["오류 로그", { incident: errorLogsIncidentId("llm") }],
  ])("%s — 본문에 폼 · 단추 · 입력 칸이 없고, 페이지에 스크립트가 없다 · 비밀값 · 서버 주소가 없다", async (_label, searchParams) => {
    const html = await render(searchParams);
    const main = mainOf(html);
    for (const tag of ["<form", "<button", "<input", "<textarea", "<select"]) expect(main).not.toContain(tag);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expectNoForbiddenText(html);
    for (const [, init] of upstreamFetch.mock.calls) expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
  });
});

describe("화면과 직렬화한 글은 같은 내용이다(보낸 묶음 = 사람이 보는 묶음)", () => {
  /** 묶음에서 화면 · 글 양쪽에 있어야 하는 글자 — 칸마다의 값과 알림 글. */
  function contentTokens(evidence: IncidentEvidence): string[] {
    const tokens: string[] = [...evidence.reductions];
    for (const fact of evidence.facts) tokens.push(fact.value);
    const cells = [evidence.alertHistory, evidence.logs, evidence.deployments, evidence.resources];
    for (const cell of cells) {
      if (cell.state === "failed") tokens.push(`확인하지 못함 — ${cell.failure.message}`);
      if (cell.state === "unmapped") tokens.push("확인할 수 없음 — 대응 표에 없음");
    }
    if (evidence.alertHistory.state === "value") for (const record of evidence.alertHistory.value.records) tokens.push(record.title, record.key);
    if (evidence.logs.state === "value") {
      for (const line of evidence.logs.value.lines) tokens.push(line.message);
      if (evidence.logs.value.noticeText !== null) tokens.push(evidence.logs.value.noticeText);
    }
    if (evidence.deployments.state === "value") {
      const view = evidence.deployments.value;
      if (view.kind === "window") for (const deployment of view.deployments) tokens.push(deployment.requestId, deployment.commitSha);
      else for (const commit of view.commits) tokens.push(commit.sha, commit.subject);
    }
    if (evidence.resources.state === "value") {
      const view = evidence.resources.value;
      if (view.kind === "server") tokens.push(view.cpuText, view.memoryText, view.diskText);
      else if (view.trace.host !== null && view.trace.host.ok) for (const reading of view.trace.host.value.values) tokens.push(reading.atLogText, reading.maximumText);
    }
    return tokens.filter((token) => token.length > 0);
  }

  it.each([
    ["감시 대상 DOWN", monitorIncidentId("front"), [MARK.alert, MARK.frontLog, MARK.scriptLog]],
    ["대응 표에 없는 감시 대상", monitorIncidentId("deploy-master"), []],
    ["배포 실패", deployIncidentId("backend", "req-failed-1"), [MARK.alert, MARK.deployLog, MARK.commit]],
    ["자원 임계값", resourceIncidentId("s158", "disk_warning", null), [MARK.alert]],
    ["오류 로그", errorLogsIncidentId("llm"), [MARK.llmLog]],
  ])("%s — 묶음의 값은 화면에도 글에도 있다", async (_label, id, marks) => {
    const data = await apiData(id);
    if (data.selected?.kind !== "evidence") throw new Error(`evidence 아님: ${JSON.stringify(data.selected)}`);
    const { evidence, text } = data.selected;
    const screenText = textOf(mainOf(await render({ incident: id })));
    const tokens = contentTokens(evidence);
    expect(tokens.length).toBeGreaterThan(3);
    for (const token of tokens) {
      expect(screenText.includes(token), `화면에 없다: ${token}`).toBe(true);
      expect(text.includes(token), `글에 없다: ${token}`).toBe(true);
    }
    for (const mark of marks) {
      expect(screenText, mark).toContain(mark);
      expect(text, mark).toContain(mark);
    }
  });

  it("크기 상한으로 줄였으면 화면도 줄인 묶음 — 뺀 줄은 화면에도 글에도 없고, 줄인 것이 양쪽에 있다", async () => {
    const stack = (index: number) => `java.lang.IllegalStateException: 실패 #${index}\n${Array.from({ length: 60 }, (_, frame) => `\tat xyz.Service.call$${frame}(Service.kt:${frame})`).join("\n")}`;
    overrides[`${FAKE_OBSERVE_URL}/logs`] = (url) => {
      const parameters = url.searchParams;
      if (parameters.get("service") !== "front") return ROUTES[`${FAKE_OBSERVE_URL}/logs`](url);
      const level = parameters.get("level")!;
      const rows = Array.from({ length: 500 }, (_, index) => {
        const at = DOWN_AT + 10 * MINUTE - index * SECOND - (level === "error" ? 0 : 500);
        return logRow({ id: `${at}-0`, at: iso(at), level, service: "front", message: `${level}-${index} ${stack(index)}` });
      });
      return jsonBody(logsBody(rows, parameters.get("from")!, parameters.get("to")!, `${DOWN_AT - 10 * MINUTE}-0`));
    };
    const data = await apiData(monitorIncidentId("front"));
    if (data.selected?.kind !== "evidence") throw new Error("evidence");
    const { evidence, text } = data.selected;
    expect(evidence.reductions.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(48_000);
    const html = await render({ incident: monitorIncidentId("front") });
    const screenText = textOf(mainOf(html));
    for (const reduction of evidence.reductions) {
      expect(screenText).toContain(reduction);
      expect(text).toContain(reduction);
    }
    expect(textOf(sectionOf(html, "logs"))).toContain("최근 100줄만 보입니다 — 더 있음");
    // 화면에 받은 100줄 중 뺀 줄(가장 오래된 것)은 화면에도 글에도 없다
    if (evidence.logs.state !== "value") throw new Error("logs");
    const shownFirst = evidence.logs.value.lines[0].message.split("\n")[0];
    expect(screenText).toContain(shownFirst);
    expect(screenText).not.toContain("warning-49 ");   // 100줄 중 가장 오래된 warning 줄 — 크기 상한으로 빠졌다
    expect(text).not.toContain("warning-49 ");
  });
});

describe("다른 서버의 글 — 화면은 받은 글 그대로(이스케이프), 글은 줄 구조를 꾸며 낼 수 없게", () => {
  it("줄바꿈 · 가짜 구역이 든 로그 글 — 화면은 그 글자 그대로, 글은 이어지는 줄마다 `| ` · 머리는 직렬화가 쓴 것뿐", async () => {
    const message = "첫 줄\n## 가짜 구역 <i>x</i>\n# 문제: 가짜";
    overrides[`${FAKE_OBSERVE_URL}/logs`] = (url) => {
      const parameters = url.searchParams;
      if (parameters.get("service") !== "front" || parameters.get("level") !== "warning") return ROUTES[`${FAKE_OBSERVE_URL}/logs`](url);
      return jsonBody(logsBody([logRow({ id: `${DOWN_AT - MINUTE}-0`, at: iso(DOWN_AT - MINUTE), level: "warning", service: "front", message })], parameters.get("from")!, parameters.get("to")!));
    };
    const html = await render({ incident: monitorIncidentId("front") });
    expect(sectionOf(html, "logs")).toContain("첫 줄\n## 가짜 구역 &lt;i&gt;x&lt;/i&gt;\n# 문제: 가짜");
    const data = await apiData(monitorIncidentId("front"));
    if (data.selected?.kind !== "evidence") throw new Error("evidence");
    expect(data.selected.text).toContain(" 첫 줄\n| ## 가짜 구역 <i>x</i>\n| # 문제: 가짜");
    expect(data.selected.text.split(/\r\n|[\n\r\u2028\u2029\u0085\v\f]/).filter((line) => /^ {0,3}#/.test(line))).toEqual([
      "# 문제: 감시 대상 DOWN — front", "## 무엇이 · 언제부터", "## 관련 알림", "## 로그", "## 배포", "## 자원",
    ]);
  });
});

describe("거짓 '닫힘' · 거짓 '없음'을 말하지 않는다", () => {
  it("자원 임계값 — 그 서버의 서비스를 찾지 못하면 로그 칸은 화면 · 글 모두 '확인할 수 없음 — 그 서버의 서비스를 찾지 못함'", async () => {
    overrides[`${FAKE_OBSERVE_URL}/metrics/latest`] = () => jsonBody(latestBody([latestServerRow("s158", [])], [firingRow({ server: "s158", rule: "disk_warning", since: iso(NOW - 30 * MINUTE) })]));
    const id = resourceIncidentId("s158", "disk_warning", null);
    const logs = textOf(sectionOf(await render({ incident: id }), "logs"));
    expect(logs).toContain("확인할 수 없음 — 그 서버의 서비스를 찾지 못함");
    expect(logs.replace("확인할 수 없음 — 그 서버의 서비스를 찾지 못함", "")).not.toContain("없음");
    const data = await apiData(id);
    if (data.selected?.kind !== "evidence") throw new Error("evidence");
    const text = data.selected.text;
    const start = text.indexOf("\n## 로그\n") + "\n## 로그\n".length;
    expect(text.slice(start, text.indexOf("\n## 배포\n")).trim()).toBe("확인할 수 없음 — 그 서버의 서비스를 찾지 못함");
  });

  it("오류 로그가 500건을 채웠을 때 목록에 없는 서비스의 오류 로그 — '확인하지 못했습니다', 닫혔다고 말하지 않는다", async () => {
    overrides[`${FAKE_OBSERVE_URL}/logs`] = (url) => {
      const parameters = url.searchParams;
      const listing = parameters.get("level") === "error" && parameters.get("service") === null && parameters.get("request_id") === null;
      if (!listing) return ROUTES[`${FAKE_OBSERVE_URL}/logs`](url);
      const rows = Array.from({ length: 500 }, (_, index) => logRow({ id: `${NOW - MINUTE}-${index}`, at: iso(NOW - MINUTE), level: "error", service: "llm", message: `llm ${index}` }));
      return jsonBody(logsBody(rows, parameters.get("from")!, parameters.get("to")!, `${NOW - 10 * MINUTE}-0`));
    };
    const main = textOf(mainOf(await render({ incident: errorLogsIncidentId("backend") })));
    expect(main).toContain("이 문제가 지금 열려 있는지 확인하지 못했습니다");
    expect(main).not.toContain("이 문제는 지금 열려 있지 않습니다");
  });
});

describe("목록이 확인한 범위를 드러낸다", () => {
  function listText(html: string): string {
    const list = /<section[^>]*aria-labelledby="incident-list"[^>]*>([\s\S]*?)<\/section>/.exec(html);
    expect(list, "목록 구역이 없다").not.toBeNull();
    return textOf(list![1]);
  }

  it("배포 이력 200건에 보이지 않은 서비스 · 상태를 모르는 감시 대상 — 목록 위에 그 줄, 문제가 없으면 '확인된 범위에서는'", async () => {
    overrides[`${FAKE_ALERT_URL}/monitors`] = () => jsonBody(monitorsBody([
      { name: "front", status: "UNKNOWN", down_since: "", reason: "연결 실패" }, { name: "backend", status: "UP", down_since: "", reason: "" },
    ]));
    overrides[`${FAKE_OBSERVE_URL}/metrics/latest`] = () => jsonBody(latestBody([latestServerRow("s158")], []));
    overrides[`${FAKE_OBSERVE_URL}/logs`] = (url) => jsonBody(logsBody([], url.searchParams.get("from")!, url.searchParams.get("to")!));
    overrides[`${FAKE_DEPLOY_MASTER_URL}/deploys`] = () => jsonBody(deploymentsBody(Array.from({ length: 200 }, (_, index) => deploymentRow({ request_id: `req-${index}`, service: "front" }))));
    const text = listText(await render());
    expect(text).toContain("감시 대상 1개는 아직 상태를 모름");
    expect(text).toContain("배포: 최근 200건 안에서만 확인 — backend, llm, alert, observe, admin 은 확인하지 못함");
    expect(text).toContain("확인된 범위에서는 열린 문제가 없습니다");
    expect(text.replace("확인된 범위에서는 열린 문제가 없습니다", "")).not.toContain("열린 문제가 없습니다");
  });
});

describe("고른 문제가 지금 열려 있지 않을 때 · 입력이 틀렸을 때", () => {
  it("닫힌 문제 — '이 문제는 지금 열려 있지 않습니다'와 목록으로 가는 링크", async () => {
    const html = await render({ incident: monitorIncidentId("backend") });
    expect(textOf(mainOf(html))).toContain("이 문제는 지금 열려 있지 않습니다");
    expect(mainOf(html)).toMatch(/<a[^>]*href="\/incidents"[^>]*>문제 목록으로<\/a>/);
  });

  it("그 출처를 확인하지 못했으면 '확인하지 못했습니다' — 닫혔다고 말하지 않는다", async () => {
    overrides[`${FAKE_ALERT_URL}/monitors`] = () => textResponse("", 503);
    const main = textOf(mainOf(await render({ incident: monitorIncidentId("front") })));
    expect(main).toContain("이 문제가 지금 열려 있는지 확인하지 못했습니다");
    expect(main).not.toContain("이 문제는 지금 열려 있지 않습니다");
  });

  it("형식이 틀린 식별자 — '조건 형식이 맞지 않음', 다른 서버를 부르지 않는다", async () => {
    const html = await render({ incident: "monitor:<script>" });
    expect(textOf(mainOf(html))).toContain("조건 형식이 맞지 않음");
    expect(mainOf(html)).toMatch(/<a[^>]*href="\/incidents"[^>]*>문제 목록으로<\/a>/);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("내비게이션 · 세션", () => {
  it("'문제'가 '상태 한눈에' 다음 자리에 있고, 이 화면에서 현재 화면", async () => {
    const keys = ADMIN_SCREENS.map((screen) => screen.key as string);
    expect(keys.indexOf("incidents")).toBe(keys.indexOf("status") + 1);
    expect(ADMIN_SCREENS.find((screen) => (screen.key as string) === "incidents")).toMatchObject({ title: "문제", path: "/incidents" });
    const html = await render();
    expect(html).toMatch(/href="\/incidents" aria-current="page"[^>]*>문제</);
    expect(html.indexOf('href="/status"')).toBeLessThan(html.indexOf('href="/incidents"'));
  });

  it("세션이 없으면 로그인으로 — 다른 서버를 부르지 않는다", async () => {
    state.cookieValue = undefined;
    await expect(render({ incident: monitorIncidentId("front") })).rejects.toThrow(/^redirect:.*\/login$/);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
