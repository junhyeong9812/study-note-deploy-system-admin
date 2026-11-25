/** 연관 로그의 "그때 서버 자원" 칸 — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수(loadLogTraceWithResources)와 전역 fetch(가짜 관측 · master · 알림 서버)를 거쳐
 * 명세 §17 끝 줄 "수치만 — 그 로그 시각의 값과 앞뒤 5분의 최댓값(서버의 CPU · 메모리 · 디스크, 그 서비스 컨테이너의 CPU · 메모리). '서버 자원' 화면으로 가는 링크" ·
 * §10.4 · §11.5 "그때 그 서비스가 있던 서버" · §2.6 "값이 없으면 '기록 없음'"을 본다. 비밀값 · 다른 서버 주소 · 원문 표식은 HTML 에 없다. */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import LogsPage from "@/app/logs/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  HOUR, MINUTE, SELECTED_LOG_ID, SELECTED_MILLISECONDS, alertHandlerFor, alertIncident, createFakeObserveLogs, createTraceFetch, fakeLogLine,
  masterDeployment, masterHandlerFor,
} from "@/features/log-trace/lib/log-trace-test-fakes";
import { createFakeTraceObserve, type FakeTraceObserve } from "@/features/log-trace/lib/trace-resources-test-fakes";
import { observeLatestBody, observeLatestServer, observePoint, seriesKey } from "@/features/resources/lib/resource-metrics-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, expectNoForbiddenText,
  leakyErrorBody, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const T = SELECTED_MILLISECONDS;   // 고른 로그 — backend error
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;
const LIST_RANGE = { from: new Date(T - HOUR).toISOString(), to: new Date(T + HOUR).toISOString() };
const LOG_LINES = [fakeLogLine()];

let traceObserve: FakeTraceObserve;
const logsObserve = createFakeObserveLogs(LOG_LINES).handler;
const observeHandler: RoutedFetchHandler = (url, init) => (url.pathname.startsWith("/metrics/") ? traceObserve.handler(url, init) : logsObserve(url, init));

const networkFetch = createTraceFetch({
  observe: (url, init) => observeHandler(url, init),
  master: masterHandlerFor([masterDeployment()]),
  alert: alertHandlerFor([alertIncident()]),
});

/** 서버 158 에 backend-app 이 있고(값이 다 있음), 164 에도 backend 컨테이너가 조금 일찍 보였다. 9 에는 backend 가 없다. */
function defaultTraceObserve(): FakeTraceObserve {
  const fake = createFakeTraceObserve(() => observeLatestBody([observeLatestServer("158"), observeLatestServer("164"), observeLatestServer("9")], []));
  fake.containers.set("158", { seen: { "backend-app": T + 20_000, "front-app": T } });
  fake.containers.set("164", { seen: { "backend-app": T - 4 * MINUTE } });
  fake.containers.set("9", { seen: { "front-app": T } });
  fake.metrics.series.set(seriesKey("158", "host", null), { points: [
    observePoint("host", T - 40_000, { cpu_pct: [20, 30], mem_used: [7.0e9, 7.1e9], mem_total: [1e10, 1e10], disk_used: [5.5e11, 5.5e11], disk_total: [1e12, 1e12] }),
    observePoint("host", T - 10_000, { cpu_pct: [34.1, 87.0], mem_used: [7.24e9, 7.31e9], mem_total: [1e10, 1e10], disk_used: [5.5e11, 5.5e11], disk_total: [1e12, 1e12] }),
    observePoint("host", T + 20_000, { cpu_pct: [25, 40], mem_used: [7.1e9, 7.2e9], mem_total: [1e10, 1e10], disk_used: [5.5e11, 5.5e11], disk_total: [1e12, 1e12] }),
  ] });
  fake.metrics.series.set(seriesKey("158", "container", "backend-app"), { points: [
    observePoint("container", T - 10_000, { cpu_pct: [210, 380], mem_used: [1.2 * GIB, 1.3 * GIB] }),
  ] });
  return fake;
}

/** 지금(진입 함수 · 링크의 기간)을 고정하고 그린다 — Date 만, 타이머는 그대로. 세션도 그 시각으로. */
async function render(nowMilliseconds = T + 30 * MINUTE, searchParams: Record<string, string> = { ...LIST_RANGE, selected: SELECTED_LOG_ID }): Promise<string> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(nowMilliseconds);
    state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, nowMilliseconds - 60_000);
    const element = await LogsPage({ searchParams: Promise.resolve(searchParams) });
    const rendererModuleName = "react-dom/server";
    const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
    return renderer.renderToStaticMarkup(element);
  } finally {
    vi.useRealTimers();
  }
}

function textOf(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, "");
}

/** 그때 서버 자원 칸 */
function resourcesBlock(html: string): string {
  const start = html.indexOf('aria-labelledby="log-trace-resources-title"');
  expect(start, "그때 서버 자원 칸이 없다").toBeGreaterThan(0);
  const open = html.lastIndexOf("<div", start);
  const tags = /<div\b|<\/div>/g;
  tags.lastIndex = open;
  let depth = 0;
  for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
    depth += match[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(open, match.index + match[0].length);
  }
  throw new Error("칸이 닫히지 않는다");
}

/** 표의 줄 — [갈래(rowSpan 이면 첫 줄만), 지표, 그 로그 시각, 앞뒤 5분 최댓값] */
function tableRows(block: string): string[][] {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(block)![1];
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => textOf(cell[1])));
}

function linkHref(block: string): string {
  const match = /<a[^>]*href="([^"]*)"[^>]*>서버 자원 화면에서 보기 →<\/a>/.exec(block);
  expect(match, "서버 자원 링크가 없다").not.toBeNull();
  return match![1].replace(/&amp;/g, "&");
}

beforeEach(() => {
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
  traceObserve = defaultTraceObserve();
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

describe("찾음 — 서버와 그 서비스 컨테이너의 그때 값 · 앞뒤 5분 최댓값", () => {
  it("'그때 서버 상태' 구역 안, 서버 158 (backend-app) · 수치 표", async () => {
    const html = await render();
    const block = resourcesBlock(html);
    const section = html.slice(html.indexOf('id="log-trace-server-state"'));
    expect(section).toContain('aria-labelledby="log-trace-resources-title"');
    expect(textOf(block)).toContain("그때 서버 자원 — backend · 앞뒤 5분");
    expect(textOf(block)).toContain("서버 158 (backend-app)");
    expect(tableRows(block)).toEqual([
      ["서버", "CPU", "34.1%", "87.0%"], ["메모리", "72.4%", "73.1%"], ["디스크", "55.0%", "55.0%"],
      ["컨테이너", "CPU", "210.0%", "380.0%"], ["메모리", "1.2 GiB", "1.3 GiB"],
    ]);
    expect(textOf(block)).toContain("코어 하나 = 100%");
    expect(textOf(block)).not.toContain("5분 평균 값");
  });

  it("같은 서비스가 다른 서버에도 보였으면 한 줄", async () => {
    expect(textOf(resourcesBlock(await render()))).toContain("같은 서비스가 서버 164 에도 보였습니다.");
  });

  it("링크 — 그 서버(#resource-server-<서버>)와 그 컨테이너를 고른 주소, 기간은 로그 시각이 드는 가장 짧은 것", async () => {
    expect(linkHref(resourcesBlock(await render(T + 30 * MINUTE)))).toBe("/resources?range=1h&server=158&container=backend-app#resource-server-158");
    expect(linkHref(resourcesBlock(await render(T + 3 * HOUR)))).toBe("/resources?range=24h&server=158&container=backend-app#resource-server-158");
    expect(linkHref(resourcesBlock(await render(T + 3 * DAY)))).toBe("/resources?range=7d&server=158&container=backend-app#resource-server-158");
    expect(linkHref(resourcesBlock(await render(T + 10 * DAY)))).toBe("/resources?range=30d&server=158&container=backend-app#resource-server-158");
  });

  it("5분 평균에서 읽은 값이면(고른 로그가 7일보다 오래됨) '5분 평균 값'", async () => {
    traceObserve.metrics.series.set(seriesKey("158", "host", null), { source: "rollup", stepMilliseconds: 5 * MINUTE, points: [
      observePoint("host", T - 2 * MINUTE, { cpu_pct: [30, 60], mem_used: [7e9, 7e9], mem_total: [1e10, 1e10], disk_used: [5e11, 5e11], disk_total: [1e12, 1e12] }),
    ] });
    const block = resourcesBlock(await render(T + 10 * DAY));
    expect(textOf(block)).toContain("5분 평균 값(고른 로그가 7일보다 오래됨)");
    expect(tableRows(block)[0]).toEqual(["서버", "CPU", "30.0%", "60.0%"]);
  });
});

describe("값이 없을 때 — 0 으로 보이지 않는다", () => {
  it("그 서비스 컨테이너가 그 서버에 없으면 서버 값만 · '그 서비스 컨테이너 기록 없음', 링크는 서버만", async () => {
    traceObserve.containers.set("158", { seen: { "backend-worker": T } });
    traceObserve.containers.set("164", { seen: {} });
    const block = resourcesBlock(await render());
    expect(textOf(block)).toContain("서버 158");
    expect(textOf(block)).not.toContain("(backend-app)");
    expect(tableRows(block).slice(3)).toEqual([["컨테이너", "그 서비스 컨테이너 기록 없음"]]);
    expect(linkHref(block)).toBe("/resources?range=1h#resource-server-158");
  });

  it("그 기간에 점이 없는 계열은 '기록 없음' · 로그 시각에 점이 없으면 그때 값 '없음'", async () => {
    traceObserve.metrics.series.set(seriesKey("158", "host", null), { points: [] });
    traceObserve.metrics.series.set(seriesKey("158", "container", "backend-app"), { points: [observePoint("container", T + 2 * MINUTE, { cpu_pct: [50, 70], mem_used: [GIB, GIB] })] });
    const block = resourcesBlock(await render());
    expect(tableRows(block)).toEqual([["서버", "기록 없음"], ["컨테이너", "CPU", "없음", "70.0%"], ["메모리", "없음", "1.0 GiB"]]);
  });

  it("계열 조회가 실패하면 그 갈래만 '확인하지 못함 — <고정 글>'", async () => {
    traceObserve.metrics.series.set(seriesKey("158", "container", "backend-app"), { response: () => textResponse(leakyErrorBody(), 504) });
    const block = resourcesBlock(await render());
    expect(tableRows(block)[0]).toEqual(["서버", "CPU", "34.1%", "87.0%"]);
    expect(tableRows(block)[3]).toEqual(["컨테이너", "확인하지 못함 — 서버 조회 시간 초과 · HTTP 504"]);
  });
});

describe("못 찾음 — 둘을 가른다", () => {
  it("다 물었는데 없음 → '기록 없음'(표 · 링크 없음)", async () => {
    for (const server of ["158", "164", "9"]) traceObserve.containers.set(server, { seen: { "front-app": T } });
    const block = resourcesBlock(await render());
    expect(textOf(block)).toContain("기록 없음 — 그 시각에 backend 컨테이너를 본 서버가 없습니다");
    expect(block).not.toContain("<table");
    expect(block).not.toContain("서버 자원 화면에서 보기");
  });

  it("일부 조회가 실패 → '어느 서버였는지 확인하지 못함' + 실패한 서버 이름", async () => {
    traceObserve.containers.set("158", { seen: { "front-app": T } });
    traceObserve.containers.set("164", { response: () => textResponse(leakyErrorBody(), 503) });
    const block = resourcesBlock(await render());
    expect(textOf(block)).toContain("어느 서버였는지 확인하지 못함 — 서버 164 에 묻지 못했습니다.");
    expect(block).not.toContain("<table");
  });

  it("찾았지만 다른 서버의 조회가 실패했으면 그 서버 이름을 적는다", async () => {
    traceObserve.containers.set("9", { response: () => textResponse(leakyErrorBody(), 503) });
    expect(textOf(resourcesBlock(await render()))).toContain("서버 9 는 확인하지 못함.");
  });

  it("조회가 통째로 실패(latest 503) → 이 칸만 '확인하지 못함', 나머지 구역은 그대로", async () => {
    traceObserve = createFakeTraceObserve(() => textResponse(leakyErrorBody(), 503));
    const html = await render();
    expect(textOf(resourcesBlock(html))).toContain("확인하지 못함 — 서버 일시 장애 · HTTP 503");
    expect(textOf(html)).toContain("앞뒤 30분의 배포");
    expect(textOf(html)).toContain("앞뒤 5분 서비스별 warning · error");
    expectNoForbiddenText(html);
  });
});

describe("칸이 없을 때 · HTML 에 없는 것", () => {
  it("고른 로그가 없으면(목록만) 그때 서버 자원 칸이 없다 · 자원 조회도 없다", async () => {
    const html = await render(T + 30 * MINUTE, { ...LIST_RANGE });
    expect(html).not.toContain("log-trace-resources-title");
    expect(traceObserve.metrics.calls).toHaveLength(0);
  });

  it("고른 로그를 찾을 수 없으면 칸이 없다", async () => {
    const html = await render(T + 30 * MINUTE, { ...LIST_RANGE, selected: `${T + 999}-0` });
    expect(html).not.toContain("log-trace-resources-title");
  });

  it("스크립트 · 비밀값 · 주소 · 원문 표식 · 계약 밖 칸(id · project)이 없다", async () => {
    const html = await render();
    expect(html).not.toMatch(/<script/i);
    expectNoForbiddenText(html);
    expect(html).not.toContain("0123456789ab");
  });
});
