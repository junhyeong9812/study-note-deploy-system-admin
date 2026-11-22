/** 로그 조회 화면의 연관 로그(명세 §11.2) — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 관측 · master · 알림 서버)를 거친다.
 * 선택 없음 · 줄 링크 주소(조건 · 커서 유지) · 분할과 네 구역 · 요청 ID 없는 로그 · 연관 줄의 선택 링크 · 시간 차 · 더 있음 · 구역별 실패 ·
 * 못 찾음 · 잘못된 selected · 배포 링크 주소 · 메시지 글자 그대로 · 세션 없음을 본다. 비밀값 · 다른 서버 주소 · 원문은 HTML 에 없다. */
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

import LogsPage from "@/app/logs/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  HOUR, MINUTE, SELECTED_LOG_ID, SELECTED_MILLISECONDS, alertCalls, alertHandlerFor, alertIncident, createFakeObserveLogs, createTraceFetch,
  fakeLogLine, logIdOf, masterCalls, masterDeployment, masterHandlerFor, observeCalls, type FakeLogLine,
} from "@/features/log-trace/lib/log-trace-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, expectNoForbiddenText,
  jsonBody, leakyErrorBody, leakyNetworkError, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const T = SELECTED_MILLISECONDS;
const LIST_RANGE = { from: new Date(T - HOUR).toISOString(), to: new Date(T + HOUR).toISOString() };

const SELECTED_LINE = fakeLogLine();   // backend error "boom", 요청 ID req-trace-1
const FIRST_LINE = fakeLogLine({ milliseconds: T - 2_000, sequence: 0, level: "info", service: "front", message: "GET /api/notes 요청 받음" });
const SECOND_LINE = fakeLogLine({ milliseconds: T - 1_500, sequence: 1, level: "debug", service: "backend", message: "노트 조회 시작" });
const AFTER_LINE = fakeLogLine({ milliseconds: T + 120, sequence: 0, level: "warning", service: "front", message: "응답 500 전달" });
const NO_REQUEST_LINE = fakeLogLine({ milliseconds: T + 100, sequence: 0, requestId: "", service: "observe", level: "info", message: "수집 한 바퀴" });
const OTHER_REQUEST_LINE = fakeLogLine({ milliseconds: T - 1_000, sequence: 0, requestId: "req-other", level: "error", message: "다른 요청" });
const DEFAULT_LINES: FakeLogLine[] = [FIRST_LINE, SECOND_LINE, SELECTED_LINE, AFTER_LINE, NO_REQUEST_LINE, OTHER_REQUEST_LINE];

let observeHandler: RoutedFetchHandler = createFakeObserveLogs(DEFAULT_LINES).handler;
let masterHandler: RoutedFetchHandler = masterHandlerFor([masterDeployment()]);
let alertHandler: RoutedFetchHandler = alertHandlerFor([alertIncident()]);

const networkFetch = createTraceFetch({
  observe: (url, init) => observeHandler(url, init),
  master: (url, init) => masterHandler(url, init),
  alert: (url, init) => alertHandler(url, init),
});

function useLines(lines: FakeLogLine[]) {
  observeHandler = createFakeObserveLogs(lines).handler;
}

/** 관측 서버 처리기를 감싸 특정 호출만 바꾼다. */
function wrapObserve(lines: FakeLogLine[], override: (url: URL) => Response | null) {
  const fallback = createFakeObserveLogs(lines).handler;
  observeHandler = (url, init) => override(url) ?? fallback(url, init);
}

async function render(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const element = await LogsPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function decodeAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** 여는 태그 안의 글자(aria-label 등)로 링크의 href 를 찾는다. */
function hrefOf(html: string, attributePattern: string): string {
  const match = new RegExp(`<a[^>]*href="([^"]*)"[^>]*${attributePattern}`).exec(html);
  expect(match, `${attributePattern} 링크가 없다`).not.toBeNull();
  return decodeAttribute(match![1]);
}

function paramsOf(href: string, path = "/logs"): Record<string, string> {
  const url = new URL(href, FAKE_ORIGIN);
  expect(url.pathname).toBe(path);
  return Object.fromEntries(url.searchParams);
}

/** 오른쪽 상세(연관 로그 구역)의 HTML 만 */
function panelOf(html: string): string {
  const start = html.indexOf('aria-labelledby="log-trace-title"');
  expect(start, "연관 로그 상세가 없다").toBeGreaterThan(-1);
  return html.slice(start);
}

/** 목록(왼쪽)의 HTML 만 */
function listOf(html: string): string {
  const start = html.indexOf('aria-label="조회 결과"');
  const end = html.indexOf('aria-labelledby="log-trace-title"');
  return html.slice(start, end === -1 ? undefined : end);
}

const rowLabel = (service: string, level: string) => `aria-label="[^"]* ${service} ${level} 연관 로그 열기"`;
const traceLabel = (service: string, level: string) => `aria-label="[^"]* ${service} ${level} 이 로그 고르기"`;

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
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  useLines(DEFAULT_LINES);
  masterHandler = masterHandlerFor([masterDeployment()]);
  alertHandler = alertHandlerFor([alertIncident()]);
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("선택 없음", () => {
  it("상세 없음 · 표는 칸 다섯 · 배포 · 알림 서버를 부르지 않는다 · 관측 서버는 목록 1회", async () => {
    const html = await render(LIST_RANGE);
    expect(html).not.toContain("log-trace-title");
    expect(html).not.toContain("연관 로그 닫기");
    expect(html).toContain('<th scope="col">요청 ID</th>');
    expect(html).not.toContain('aria-current="true" aria-label');
    expect(observeCalls(networkFetch)).toHaveLength(1);
    expect(masterCalls(networkFetch)).toHaveLength(0);
    expect(alertCalls(networkFetch)).toHaveLength(0);
  });
});

describe("줄 링크 — 지금 조건 · 커서는 그대로, selected 만 붙는다", () => {
  it("조건 · 건수 · 커서 유지 + selected", async () => {
    const conditions = { ...LIST_RANGE, service: "backend", limit: "50", before: `${T + 5_000}-0` };
    const html = await render(conditions);
    expect(paramsOf(hrefOf(html, rowLabel("backend", "error")))).toEqual({ ...conditions, selected: SELECTED_LOG_ID });
  });

  it("시각을 비운 조회(최근 1시간)는 응답의 범위로 고정한다 — 누른 뒤 목록이 밀리지 않는다", async () => {
    const responseRange = { from: "2026-11-22T09:00:00.123Z", to: "2026-11-22T11:00:00.123Z" };
    wrapObserve(DEFAULT_LINES, (url) => (url.searchParams.has("from") ? null
      : jsonBody({ success: true, data: { logs: [{ id: SELECTED_LOG_ID, at: new Date(T).toISOString(), level: "error", service: "backend", request_id: "req-trace-1", message: "boom" }], next_before: "", ...responseRange } })));
    const html = await render({ level: "error" });
    expect(paramsOf(hrefOf(html, rowLabel("backend", "error")))).toEqual({ level: "error", ...responseRange, selected: SELECTED_LOG_ID });
  });

  it("줄 안의 서비스 · 요청 ID 링크는 그대로 남는다(덮개 위)", async () => {
    const html = await render(LIST_RANGE);
    expect(html).toContain('aria-label="backend 의 로그만 보기"');
    expect(html).toContain('aria-label="요청 ID req-trace-1 의 로그만 보기"');
  });
});

describe("선택 — 분할과 네 구역", () => {
  it("상세 구역 제목 넷 · 목록은 칸을 줄이고 고른 줄 aria-current · 닫기는 selected 만 뺀다", async () => {
    const html = await render({ ...LIST_RANGE, limit: "50", selected: SELECTED_LOG_ID });
    const panel = panelOf(html);
    for (const [id, title] of [["log-trace-selected", "고른 로그"], ["log-trace-request-summary", "이 요청 요약"], ["log-trace-related", "연관 로그"], ["log-trace-server-state", "그때 서버 상태"]]) {
      expect(panel).toMatch(new RegExp(`<h3 id="${id}"[^>]*>${title}`));
    }
    const list = listOf(html);
    expect(list).not.toContain('<th scope="col">요청 ID</th>');
    expect(list).toMatch(new RegExp(`<a[^>]*aria-current="true"[^>]*${rowLabel("backend", "error")}`));
    expect(list.match(/aria-current="true"/g)).toHaveLength(1);
    expect(paramsOf(hrefOf(html, 'aria-label="연관 로그 닫기"'))).toEqual({ ...LIST_RANGE, limit: "50" });
    expect(paramsOf(hrefOf(html, ">← 목록으로"))).toEqual({ ...LIST_RANGE, limit: "50" });
  });

  it("고른 로그 — KST 밀리초 · 서비스 · 수준 배지 · 요청 ID 전체(그 요청 ID 로 조회, 상세는 열린 채) · 메시지 전체", async () => {
    const panel = panelOf(await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID }));
    expect(panel).toContain("2026-11-22 19:00:00.123");
    expect(panel).toMatch(/<span class="[^"]*level[^"]*"><span aria-hidden="true"[^>]*>✕<\/span>error<\/span>/);
    expect(paramsOf(hrefOf(panel, 'aria-label="요청 ID req-trace-1 로 목록 조회"'))).toEqual({
      request_id: "req-trace-1", from: new Date(T - HOUR).toISOString(), to: new Date(T + HOUR).toISOString(), selected: SELECTED_LOG_ID,
    });
    expect(panel).toMatch(/<pre class="[^"]*">boom<\/pre>/);
  });

  it("이 요청 요약 — 서비스 순서 · 처음~마지막 · 걸린 시간 · 줄 수 · 가장 높은 수준 · 첫 줄 메시지", async () => {
    const panel = panelOf(await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID }));
    expect(panel).toContain("front → backend");
    expect(panel).toContain("2026-11-22 18:59:58.123");
    expect(panel).toContain("2026-11-22 19:00:00.243");
    expect(panel).toContain("<dd>2.1초</dd>");
    expect(panel).toContain("<dd>4줄</dd>");
    expect(panel).toContain("이 요청의 첫 로그");
    expect(panel).toContain("GET /api/notes 요청 받음");
  });

  it("연관 로그 — 시간순 · 다른 요청 · 요청 ID 없는 줄은 빠진다 · 고른 줄만 aria-current · 시간 차", async () => {
    const panel = panelOf(await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID }));
    const related = panel.slice(panel.indexOf('id="log-trace-related"'), panel.indexOf('id="log-trace-server-state"'));
    const positions = ["18:59:58.123", "18:59:58.623", "19:00:00.123", "19:00:00.243"].map((time) => related.indexOf(`>${time}</time>`));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(related).not.toContain("다른 요청");
    expect(related).not.toContain("수집 한 바퀴");
    expect(related.match(/aria-current="true"/g)).toHaveLength(1);
    expect(related).toMatch(new RegExp(`<a[^>]*aria-current="true"[^>]*${traceLabel("backend", "error")}`));
    for (const gap of ["—", "+500ms", "+1.5초", "+120ms"]) expect(related).toContain(`>${gap}</span>`);
    expect(related).toContain("4줄");
  });

  it("연관 줄을 누르면 목록 조건은 그대로 · selected 만 그 줄로", async () => {
    const html = await render({ ...LIST_RANGE, service: "backend", selected: SELECTED_LOG_ID });
    expect(paramsOf(hrefOf(panelOf(html), traceLabel("front", "info")))).toEqual({ ...LIST_RANGE, service: "backend", selected: logIdOf(FIRST_LINE) });
  });

  it("그때 서버 상태 — 줄 수 표 · 배포(배포 상세 링크) · 알림 기록 · 칸마다 조회 범위", async () => {
    const panel = panelOf(await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID }));
    const state = panel.slice(panel.indexOf('id="log-trace-server-state"'));
    expect(state).toMatch(/<th scope="row">backend<\/th><td>0건<\/td><td>2건<\/td>/);
    expect(state).toMatch(/<th scope="row">front<\/th><td>1건<\/td><td>0건<\/td>/);
    expect(paramsOf(hrefOf(state, 'aria-label="[^"]* backend 배포 상세 보기"'), "/deploys")).toEqual({ selected: "deploy-1", selectedService: "backend" });
    expect(state).toContain("front DOWN");
    expect(state).toContain("감시 DOWN");
    expect(state).toContain("2026-11-22 18:55:00");   // 5분 창 시작
    expect(state).toContain("2026-11-22 18:30:00");   // 30분 창 시작
    expect(state.match(/조회 범위\(KST\)/g)).toHaveLength(3);
  });

  it("빈 상태 문구 — 줄 수 · 배포 · 알림이 없으면 각자의 안내", async () => {
    useLines([fakeLogLine({ level: "info" })]);
    masterHandler = masterHandlerFor([]);
    alertHandler = alertHandlerFor([]);
    const panel = panelOf(await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID }));
    expect(panel).toContain("이 시간대에 warning · error 없음");
    expect(panel).toContain("이 시간대에 배포 없음");
    expect(panel).toContain("이 시간대에 알림 없음");
  });

  it("배포 이력 200건이 창 앞쪽에 닿지 못하면 '더 오래된 기록은 확인하지 못함'", async () => {
    masterHandler = masterHandlerFor(Array.from({ length: 200 }, (_, index) => masterDeployment({
      request_id: `deploy-${index}`, accepted_at: new Date(T + 20 * MINUTE - index * 1000).toISOString(), finished_at: new Date(T + 20 * MINUTE - index * 1000 + 500).toISOString(),
    })));
    expect(panelOf(await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID }))).toContain("더 오래된 기록은 확인하지 못함");
  });
});

describe("요청 ID 가 없는 로그", () => {
  it("요약 없음 · 제목 '같은 서비스의 앞뒤 30초' · 안내 · 그 서비스의 줄 · 서버 상태는 그대로", async () => {
    const panel = panelOf(await render({ ...LIST_RANGE, selected: logIdOf(NO_REQUEST_LINE) }));
    expect(panel).not.toContain("이 요청 요약");
    expect(panel).toMatch(/<h3 id="log-trace-related"[^>]*>같은 서비스의 앞뒤 30초/);
    expect(panel).toContain("요청 ID 가 없는 로그입니다");
    expect(panel).toContain("수집 한 바퀴");
    expect(panel).not.toContain("GET /api/notes");
    expect(panel).toContain("<dt>요청 ID</dt><dd><span");
    expect(panel).toContain("front DOWN");
  });
});

describe("더 있음 — 500줄 상한", () => {
  const manyLines = [SELECTED_LINE, ...Array.from({ length: 500 }, (_, index) =>
    fakeLogLine({ milliseconds: T - (index + 1) * 1000, sequence: 0, level: "info", message: `줄 ${index + 1}` }))];

  it("501줄 → '더 있음 — 최신 500줄만' · 요약 '500줄 이상'", async () => {
    useLines(manyLines);
    const panel = panelOf(await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID }));
    expect(panel).toContain("더 있음 — 최신 500줄만 보입니다");
    expect(panel).toContain("<dd>500줄 이상</dd>");
    expect(panel).not.toContain("고른 로그가 이 목록에 없습니다");
  });

  it("고른 줄이 보이는 500줄 밖이면 그 사실도 안내", async () => {
    useLines(manyLines);
    const panel = panelOf(await render({ ...LIST_RANGE, selected: logIdOf(manyLines[500]) }));
    expect(panel).toContain("고른 로그가 이 목록에 없습니다");
    expect(panel).not.toContain('aria-current="true"');
  });
});

describe("구역별 실패 — 그 구역에만 '<출처>: <가린 이유>', 나머지는 그대로", () => {
  it("관측 서버의 수준별 조회만 실패 → 줄 수 칸만", async () => {
    wrapObserve(DEFAULT_LINES, (url) => (url.searchParams.has("level") ? textResponse(leakyErrorBody(), 503) : null));
    const html = await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID });
    const panel = panelOf(html);
    expect(panel.match(/관측 서버: /g)).toHaveLength(1);
    expect(panel).toContain("관측 서버: 서버 일시 장애 · HTTP 503");
    expect(panel).toContain("front → backend");
    expect(panel).toContain("front DOWN");
    expectNoForbiddenText(html);
  });

  it("관측 서버 전체 실패 → 고른 로그 · 요약 · 연관 · 줄 수는 실패, 배포 · 알림은 값 · 목록은 실패 안내", async () => {
    observeHandler = () => textResponse(leakyErrorBody(), 503);
    const html = await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID });
    const panel = panelOf(html);
    expect(panel.match(/관측 서버: 서버 일시 장애 · HTTP 503/g)).toHaveLength(4);
    expect(paramsOf(hrefOf(panel, 'aria-label="[^"]* backend 배포 상세 보기"'), "/deploys")).toMatchObject({ selected: "deploy-1" });
    expect(panel).toContain("front DOWN");
    expect(html).toContain("로그를 불러오지 못했습니다");
    expectNoForbiddenText(html);
  });

  it("배포 서버 실패 → 배포 칸만", async () => {
    masterHandler = () => textResponse(leakyErrorBody(), 500);
    const html = await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID });
    const panel = panelOf(html);
    expect(panel).toContain("배포 서버: 예상하지 못한 응답 · HTTP 500");
    expect(panel).not.toContain("관측 서버:");
    expect(panel).not.toContain("알림 서버:");
    expect(panel).toContain("front DOWN");
    expect(panel).toContain("front → backend");
    expectNoForbiddenText(html);
  });

  it("알림 서버 연결 실패 → 알림 칸만", async () => {
    alertHandler = () => Promise.reject(leakyNetworkError());
    const html = await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID });
    const panel = panelOf(html);
    expect(panel).toContain("알림 서버: 닿지 않음");
    expect(panel).not.toContain("배포 서버:");
    expect(panel).toMatch(/backend 배포 상세 보기/);
    expectNoForbiddenText(html);
  });
});

describe("못 찾음 · 잘못된 selected", () => {
  it("관측 서버에 없는 id → 상세 자리에 '찾을 수 없습니다' + 닫기, 목록은 그대로", async () => {
    const html = await render({ ...LIST_RANGE, selected: `${T}-9` });
    const panel = panelOf(html);
    expect(panel).toContain("이 로그를 찾을 수 없습니다(보관 기간이 지났거나 주소가 잘못됨)");
    expect(paramsOf(hrefOf(panel, ">닫기<"))).toEqual(LIST_RANGE);
    expect(panel).not.toContain("그때 서버 상태");
    expect(listOf(html)).toContain(">boom<");
  });

  it.each([["abc"], ["<script>"], [`${T}-`]])("형식이 틀린 selected %j → 입력 오류 안내 · 목록은 그대로 · 배포 · 알림 서버를 부르지 않는다", async (selected) => {
    const html = await render({ ...LIST_RANGE, selected });
    const panel = panelOf(html);
    expect(panel).toContain("선택한 로그의 주소가 맞지 않습니다");
    expect(listOf(html)).toContain(">boom<");
    expect(html).not.toContain("<script>");
    expect(observeCalls(networkFetch)).toHaveLength(1);
    expect(masterCalls(networkFetch)).toHaveLength(0);
    expect(alertCalls(networkFetch)).toHaveLength(0);
  });

  it("selected 가 여러 번 → 입력 오류 안내", async () => {
    const html = await render({ ...LIST_RANGE, selected: [SELECTED_LOG_ID, SELECTED_LOG_ID] });
    expect(panelOf(html)).toContain("선택한 로그의 주소가 맞지 않습니다");
  });
});

describe("메시지는 글자 그대로 · 세션", () => {
  it("<script> 가 든 메시지는 고른 로그 · 연관 로그 · 요약에서 이스케이프된 글자", async () => {
    const script = `<script>alert("x")</script>\n<img src=x onerror=1>`;
    useLines([fakeLogLine({ message: script })]);
    const html = await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/\son[a-z]+="/i);
    expect(panelOf(html).match(/&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("세션이 없으면 로그인으로 — 어느 서버도 부르지 않는다", async () => {
    state.cookieValue = undefined;
    await expect(render({ ...LIST_RANGE, selected: SELECTED_LOG_ID })).rejects.toThrow(/^redirect:.*\/login$/);
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("정상 응답에도 비밀값 · 다른 서버 주소 · 원문 · 배포 detail 은 HTML 에 없다", async () => {
    const html = await render({ ...LIST_RANGE, selected: SELECTED_LOG_ID });
    expectNoForbiddenText(html);
    expect(html).not.toContain("build output");
    expect(html).not.toContain("connection refused");
  });
});
