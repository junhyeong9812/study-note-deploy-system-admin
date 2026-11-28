/** 요청 추적 화면 — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 관측 서버 — `GET /logs` 의 실제 규칙 흉내)를 거친다.
 * 입력 폼(스크립트 없는 GET) · 틀린 입력 안내(부르지 않는다) · 서비스별 시간 줄의 글(시작 · 걸린 시간 · 줄 수 · 오류 · 경고 — 막대 · 색만으로 뜻을 전하지 않는다) ·
 * 거친 차례 · 가장 긴 틈 · 그 요청의 로그 전체(시간순 · 이스케이프) · 로그 화면과 오가는 링크 · 한계 안내(잘림 · 없음 · 끊긴 구간 · 시각) · 실패 · 내비게이션을 본다.
 * 비밀값 · 관측 서버 주소 · 원문 · 스크립트는 HTML 에 없다. */
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

import TracePage from "@/app/trace/page";
import LogsPage from "@/app/logs/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  HOUR, SELECTED_LOG_ID, SELECTED_MILLISECONDS, SELECTED_REQUEST_ID, alertHandlerFor, createFakeObserveLogs, createTraceFetch, fakeLogLine,
  javaInstantText, logIdOf, masterHandlerFor, observeCalls, type FakeLogLine,
} from "@/features/log-trace/lib/log-trace-test-fakes";
import { TRACE_REQUEST_ID, TRACE_START_MILLISECONDS, chatScenarioLines } from "@/features/request-trace/lib/request-trace-test-fakes";
import { callsToPath, createFakeObserveTraffic, observeLogsAndTraffic } from "@/features/request-trace/lib/traffic-span-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, expectNoForbiddenText,
  leakyErrorBody, leakyNetworkError, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const T = TRACE_START_MILLISECONDS;
const SCRIPT_MESSAGE = `<img src=x onerror=alert(1)><script>alert("x")</script> & 끝`;

let observeHandler: RoutedFetchHandler = createFakeObserveLogs(chatScenarioLines()).handler;
const networkFetch = createTraceFetch({
  observe: (url, init) => observeHandler(url, init),
  master: masterHandlerFor([]),
  alert: alertHandlerFor([]),
});

/** 관측 서버 하나 — 로그(`/logs`)와 통신(`/traffic/*` — T7, 비어 있음. 구간을 겹친 화면은 trace-spans-page.test). */
function useLines(lines: FakeLogLine[]) {
  observeHandler = observeLogsAndTraffic(createFakeObserveLogs(lines).handler, createFakeObserveTraffic().handler);
}

async function renderElement(element: unknown): Promise<string> {
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

async function render(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  return renderElement(await TracePage({ searchParams: Promise.resolve(searchParams) }));
}

function decodeAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** 태그를 지운 글자(엔티티는 풀어서). */
function textOf(fragment: string): string {
  return decodeAttribute(fragment.replace(/<[^>]+>/g, ""));
}

/** aria-label 이 label 인 요소의 여는 태그부터 같은 이름의 닫는 태그까지(안에 같은 이름의 태그가 없을 때). */
function elementByLabel(html: string, tag: string, label: string): string {
  const labelAt = html.indexOf(`aria-label="${label}"`);
  expect(labelAt, `aria-label="${label}" 가 없다`).toBeGreaterThan(-1);
  const start = html.lastIndexOf(`<${tag}`, labelAt);
  const end = html.indexOf(`</${tag}>`, labelAt);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(labelAt);
  return html.slice(start, end + tag.length + 3);
}

/** 서비스별 시간 줄 표의 그 서비스 줄 — `<th scope="row">서비스</th>` 가 든 <tr>. */
function laneRow(html: string, service: string): string {
  const table = elementByLabel(html, "table", "서비스별 시간 줄");
  const rows = table.match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? [];
  const row = rows.find((candidate) => new RegExp(`<th[^>]*scope="row"[^>]*>(?:<[^>]+>)*${service}(?:<[^>]+>)*</th>`).test(candidate));
  expect(row, `${service} 줄이 없다`).toBeDefined();
  return row!;
}

/** 요약(첫 <dl>)의 글자. */
function summaryText(html: string): string {
  const summary = /<dl[\s>][\s\S]*?<\/dl>/.exec(html);
  expect(summary, "요약(<dl>)이 없다").not.toBeNull();
  return textOf(summary![0]);
}

function cellTexts(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => textOf(match[1]).trim());
}

/** 여는 태그 안의 글자(aria-label 등)로 링크의 href 를 찾는다. */
function hrefOf(html: string, attributePattern: string): string {
  const match = new RegExp(`<a[^>]*href="([^"]*)"[^>]*${attributePattern}`).exec(html);
  expect(match, `${attributePattern} 링크가 없다`).not.toBeNull();
  return decodeAttribute(match![1]);
}

function paramsOf(href: string, path: string): Record<string, string> {
  const url = new URL(href, FAKE_ORIGIN);
  expect(url.pathname).toBe(path);
  return Object.fromEntries(url.searchParams);
}

/** 요청 추적 폼 — GET · /trace · 이름 있는 글 칸 request_id · "추적" 단추. */
function expectTraceForm(html: string, value: string) {
  const form = /<form[^>]*action="\/trace"[^>]*>[\s\S]*?<\/form>/.exec(html);
  expect(form, "action=/trace 폼이 없다").not.toBeNull();
  const formHtml = form![0];
  expect(formHtml).toMatch(/<form[^>]*method="get"/);
  expect(formHtml).toMatch(/<form[^>]*action="\/trace"/);
  const input = /<input[^>]*name="request_id"[^>]*>/.exec(formHtml);
  expect(input, "request_id 칸이 없다").not.toBeNull();
  expect(input![0]).toMatch(/type="(text|search)"/);
  const id = /id="([^"]+)"/.exec(input![0])?.[1];
  expect(id, "칸에 id 가 없다(이름표가 이어지지 않는다)").toBeDefined();
  expect(formHtml).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>[^<]*요청 ID`));
  const valueMatch = /value="([^"]*)"/.exec(input![0]);
  expect(decodeAttribute(valueMatch?.[1] ?? "")).toBe(value);
  expect(formHtml).toMatch(/<button[^>]*type="submit"[^>]*>추적<\/button>/);
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
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  useLines(chatScenarioLines());
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("입력 폼", () => {
  it("요청 ID 없이 열면 폼만 — 관측 서버를 부르지 않는다 · 안내 · 실패 글 없음", async () => {
    const html = await render();
    expectTraceForm(html, "");
    expect(networkFetch).not.toHaveBeenCalled();
    expect(html).not.toContain("조회 조건이 맞지 않습니다");
    expect(html).not.toContain("확인하지 못함");
    expect(html).not.toContain("서비스별 시간 줄");
  });

  it("요청 ID 를 넣고 열면 폼에 그 글자가 남는다(주소를 복사해 다시 열 수 있다)", async () => {
    const html = await render({ request_id: TRACE_REQUEST_ID });
    expectTraceForm(html, TRACE_REQUEST_ID);
  });

  it.each([
    ["빈 값", { request_id: "" }, ""],
    ["콜론", { request_id: "req:1" }, "req:1"],
    ["81자", { request_id: "r".repeat(81) }, "r".repeat(81)],
    ["태그", { request_id: "<b>x</b>" }, "<b>x</b>"],
    ["한글", { request_id: "요청" }, "요청"],
  ])("틀린 입력(%s) → 알아들을 글 · 폼에 넣은 글자 그대로 · 관측 서버를 부르지 않는다", async (_label, input, typed) => {
    const html = await render(input);
    expect(textOf(html)).toContain("조회 조건이 맞지 않습니다");
    expect(textOf(html)).toContain("영문 · 숫자 · _ . - 로 80자 이하입니다.");
    expectTraceForm(html, typed);
    expect(html).not.toContain("<b>x</b>");
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("같은 이름이 두 번(배열) → 알아들을 글 · 부르지 않는다", async () => {
    const html = await render({ request_id: [TRACE_REQUEST_ID, "req-0123456789ac"] });
    expect(textOf(html)).toContain("조회 조건이 맞지 않습니다");
    expect(networkFetch).not.toHaveBeenCalled();
  });
});

describe("서비스별 시간 줄 — 글로 읽힌다", () => {
  it("서비스마다 시작(+ms) · 걸린 시간 · 줄 수 · 오류 · 경고가 글자로(처음 나타난 차례)", async () => {
    const html = await render({ request_id: TRACE_REQUEST_ID });
    const table = elementByLabel(html, "table", "서비스별 시간 줄");
    expect(textOf(table)).toMatch(/서비스[\s\S]*시작[\s\S]*걸린 시간[\s\S]*줄 수[\s\S]*오류[\s\S]*경고/);
    expect(cellTexts(laneRow(html, "front")).slice(0, 5)).toEqual(["+0ms", "3.6초", "2줄", "0건", "1건"]);
    expect(cellTexts(laneRow(html, "backend")).slice(0, 5)).toEqual(["+120ms", "3.4초", "4줄", "1건", "2건"]);
    expect(cellTexts(laneRow(html, "llm")).slice(0, 5)).toEqual(["+2.7초", "0ms", "2줄", "0건", "0건"]);
    expect(table.indexOf(">front<")).toBeLessThan(table.indexOf(">backend<"));
    expect(table.indexOf(">backend<")).toBeLessThan(table.indexOf(">llm<"));
  });

  it("첫 줄부터 마지막 줄까지 · 줄 수 · 거친 차례(다시 나타난 서비스가 드러난다) — '전체 걸린 시간'이라 하지 않는다(요청이 끝났는지 이 화면은 모른다)", async () => {
    const html = await render({ request_id: TRACE_REQUEST_ID });
    const text = textOf(html);
    expect(summaryText(html)).toMatch(/첫 줄부터 마지막 줄까지\s*3\.6초/);
    expect(text).toMatch(/줄 수\s*8줄/);
    expect(text).toContain("front → backend → llm → backend → front");
    expect(text).not.toContain("전체 걸린 시간");
    expect(text).not.toContain("줄이 하나뿐이라 알 수 없음");
  });

  it("두 줄이 같은 밀리초면 첫 줄부터 마지막 줄까지 0ms(줄이 둘이면 잰 값 그대로)", async () => {
    useLines([0, 1].map((sequence) => fakeLogLine({ milliseconds: T, sequence, service: "front", level: "info", requestId: TRACE_REQUEST_ID, message: `순번 ${sequence}` })));
    const html = await render({ request_id: TRACE_REQUEST_ID });
    expect(summaryText(html)).toMatch(/첫 줄부터 마지막 줄까지\s*0ms/);
    expect(textOf(html)).not.toContain("줄이 하나뿐이라 알 수 없음");
    expect(textOf(html)).not.toContain("전체 걸린 시간");
  });

  it("가장 긴 틈이 글로 — 긴 것부터", async () => {
    const text = textOf(await render({ request_id: TRACE_REQUEST_ID }));
    expect(text).toContain("가장 긴 틈");
    const first = text.indexOf("backend 의 줄 뒤 2.4초 동안 로그 없음 → llm");
    const second = text.indexOf("llm 의 줄 뒤 800ms 동안 로그 없음 → backend");
    const third = text.indexOf("front 의 줄 뒤 120ms 동안 로그 없음 → backend");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("막대는 꾸밈 — 읽는 프로그램에 숨기고(aria-hidden), 막대 없이도 글이 다 있다", async () => {
    const html = await render({ request_id: TRACE_REQUEST_ID });
    const row = laneRow(html, "backend");
    const barCells = [...row.matchAll(/<td[^>]*>[\s\S]*?<\/td>/g)].map((match) => match[0]).slice(5);
    expect(barCells.length).toBeGreaterThan(0);
    for (const cell of barCells) {
      expect(cell).toContain('aria-hidden="true"');
      expect(textOf(cell).trim()).toBe("");
    }
  });
});

describe("서비스 이름의 짝짓기(T7 — 에이전트의 로그 이름 ci-agent-<서버> 는 ci-agent 한 줄)", () => {
  it("줄 머리는 ci-agent · 줄 수 곁에 원래 이름들 · 두 서버의 줄이 합쳐진 수 · llm 과 llm-wrapper 는 따로 · 로그 표는 원래 이름", async () => {
    useLines([
      fakeLogLine({ milliseconds: T, sequence: 0, service: "ci-master", level: "info", requestId: TRACE_REQUEST_ID, message: "배포 접수" }),
      fakeLogLine({ milliseconds: T + 100, sequence: 0, service: "ci-agent-9", level: "error", requestId: TRACE_REQUEST_ID, message: "빌드 실패" }),
      fakeLogLine({ milliseconds: T + 300, sequence: 0, service: "ci-agent-158", level: "info", requestId: TRACE_REQUEST_ID, message: "받음" }),
      fakeLogLine({ milliseconds: T + 400, sequence: 0, service: "llm", level: "info", requestId: TRACE_REQUEST_ID, message: "옛 이름" }),
      fakeLogLine({ milliseconds: T + 500, sequence: 0, service: "llm-wrapper", level: "info", requestId: TRACE_REQUEST_ID, message: "새 이름" }),
    ]);
    const html = await render({ request_id: TRACE_REQUEST_ID });
    expect(cellTexts(laneRow(html, "ci-agent")).slice(0, 5)).toEqual(["+100ms", "200ms", "2줄(ci-agent-158, ci-agent-9)", "1건", "0건"]);
    expect(cellTexts(laneRow(html, "ci-master")).slice(0, 5)).toEqual(["+0ms", "0ms", "1줄", "0건", "0건"]);
    expect(cellTexts(laneRow(html, "llm")).slice(2, 3)).toEqual(["1줄"]);
    expect(cellTexts(laneRow(html, "llm-wrapper")).slice(2, 3)).toEqual(["1줄"]);
    const laneTable = elementByLabel(html, "table", "서비스별 시간 줄");
    expect(laneTable).not.toMatch(/scope="row"[^>]*>ci-agent-/);
    expect(textOf(html)).toContain("ci-master → ci-agent → llm → llm-wrapper");
    const logTable = elementByLabel(html, "table", "이 요청의 로그");
    expect(textOf(logTable)).toContain("ci-agent-9");
    expect(textOf(logTable)).toContain("ci-agent-158");
  });
});

describe("그 요청의 로그 전체", () => {
  it("시간순(같은 밀리초는 순번 차례)으로 서비스 · 수준(낱말) · 글", async () => {
    const html = await render({ request_id: TRACE_REQUEST_ID });
    const table = elementByLabel(html, "table", "이 요청의 로그");
    const messages = ["POST /api/chat 받음", "chat 시작", "검색 느림", "문맥 잘림", "chat queued position=1", "chat ok tokens~120", "응답 변환 실패", "응답 500 전달"];
    const positions = messages.map((message) => table.indexOf(message));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    const rows = table.match(/<tr[\s>][\s\S]*?<\/tr>/g)!.filter((row) => row.includes("<td"));
    expect(rows).toHaveLength(8);
    expect(textOf(rows[6])).toContain("backend");
    expect(textOf(rows[6])).toContain("error");   // 색만이 아니라 낱말로
    expect(textOf(rows[7])).toContain("warning");
  });

  it("글은 React 가 이스케이프한다(태그가 든 글)", async () => {
    useLines([...chatScenarioLines(), fakeLogLine({ milliseconds: T + 3700, sequence: 0, service: "front", level: "info", requestId: TRACE_REQUEST_ID, message: SCRIPT_MESSAGE })]);
    const html = await render({ request_id: TRACE_REQUEST_ID });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;");
  });

  it("줄마다 로그 화면의 그 줄로 가는 링크 — /logs?request_id&from=시작&to=끝&selected=그 줄", async () => {
    const html = await render({ request_id: TRACE_REQUEST_ID });
    const errorLine = chatScenarioLines()[6];
    expect(paramsOf(hrefOf(html, 'aria-label="[^"]* backend error 로그 화면에서 열기"'), "/logs")).toEqual({
      request_id: TRACE_REQUEST_ID, from: javaInstantText(T), to: javaInstantText(T + 3600), selected: logIdOf(errorLine),
    });
    expect(html.match(/로그 화면에서 열기"/g)).toHaveLength(8);
  });
});

describe("한계를 드러낸다", () => {
  it("요청 ID 를 남기지 않는 서비스 · 구간 안내와 시각 안내(고정 글)", async () => {
    const text = textOf(await render({ request_id: TRACE_REQUEST_ID }));
    expect(text).toContain("요청 ID 를 남기지 않는");
    expect(text).toContain("채팅");
    expect(text).toContain("alert");
    expect(text).toContain("수집 스트림에 실린 시각");
    expect(text).not.toContain("관측 서버(중앙)에 닿은 시각");
    expect(text).not.toContain("닿은 시각");
    expect(text).toContain("어긋날 수 있습니다");
  });

  it("500줄보다 많으면 '최근 500줄만' — 조용히 자르지 않는다", async () => {
    const lines = Array.from({ length: 501 }, (_, index) => fakeLogLine({
      milliseconds: T + index * 10, sequence: 0, service: index % 3 === 0 ? "front" : "backend", level: "info", requestId: TRACE_REQUEST_ID, message: `줄 ${index}`,
    }));
    useLines(lines);
    const html = await render({ request_id: TRACE_REQUEST_ID });
    expect(textOf(html)).toContain("로그가 500줄보다 많아 최근 500줄만 보입니다");
    expect(textOf(html)).toMatch(/줄 수\s*500줄 이상/);
    expect(html).not.toContain(">줄 0<");
  });

  it("정확히 500줄이면 잘림 안내가 없다", async () => {
    useLines(Array.from({ length: 500 }, (_, index) => fakeLogLine({
      milliseconds: T + index * 10, sequence: 0, service: "front", level: "info", requestId: TRACE_REQUEST_ID, message: `줄 ${index}`,
    })));
    const html = await render({ request_id: TRACE_REQUEST_ID });
    expect(textOf(html)).not.toContain("500줄보다 많아");
    expect(textOf(html)).toMatch(/줄 수\s*500줄(?! 이상)/);
  });

  it("그 요청 ID 의 로그가 없으면 까닭과 함께 — 표 없음", async () => {
    const html = await render({ request_id: "req-ffffffffffff" });
    expect(textOf(html)).toContain("이 요청 ID 의 로그가 없습니다(보관 기간이 지났거나, 요청 ID 를 남기지 않는 구간)");
    expect(html).not.toContain('aria-label="서비스별 시간 줄"');
    expect(html).not.toContain("확인하지 못함");
    expectTraceForm(html, "req-ffffffffffff");
  });

  it("한 줄뿐이면 틈 없음 · 요약의 걸린 시간은 '줄이 하나뿐이라 알 수 없음'(0ms 로 보이지 않는다) · NaN 없음", async () => {
    useLines([fakeLogLine({ milliseconds: T, sequence: 0, service: "admin", level: "info", requestId: TRACE_REQUEST_ID, message: "하나뿐" })]);
    const html = await render({ request_id: TRACE_REQUEST_ID });
    const summary = summaryText(html);
    expect(summary).toContain("줄이 하나뿐이라 알 수 없음");
    expect(summary).not.toContain("0ms");
    expect(summary).toMatch(/줄 수\s*1줄/);
    expect(textOf(html)).not.toContain("전체 걸린 시간");
    expect(cellTexts(laneRow(html, "admin")).slice(0, 5)).toEqual(["+0ms", "0ms", "1줄", "0건", "0건"]);
    expect(textOf(html)).not.toContain("동안 로그 없음");
    expect(html).not.toContain("NaN");
  });
});

describe("실패 — 확인하지 못함과 까닭, 폼은 그대로", () => {
  it.each([
    ["5xx", () => textResponse(leakyErrorBody(), 503), "확인하지 못함 — 관측 서버: 서버 일시 장애 · HTTP 503"],
    ["해석 못 함", () => textResponse(`{${leakyErrorBody()}`), "확인하지 못함 — 관측 서버: 해석 불가"],
    ["닿지 못함", () => Promise.reject(leakyNetworkError()), "확인하지 못함 — 관측 서버: 닿지 않음"],
    ["조회 시간 초과(504)", () => textResponse(leakyErrorBody(), 504), "확인하지 못함 — 관측 서버: 서버 조회 시간 초과 · HTTP 504"],
  ] as const)("%s", async (_label, respond, expected) => {
    observeHandler = () => respond();
    const html = await render({ request_id: TRACE_REQUEST_ID });
    expect(textOf(html)).toContain(expected);
    expectTraceForm(html, TRACE_REQUEST_ID);
    expect(html).not.toContain('aria-label="서비스별 시간 줄"');
    expectNoForbiddenText(html);
  });

  it("관측 서버 설정 없음 → 확인하지 못함 — 관측 서버: 설정 없음", async () => {
    vi.stubEnv("OBSERVE_URL", "");
    const html = await render({ request_id: TRACE_REQUEST_ID });
    expect(textOf(html)).toContain("확인하지 못함 — 관측 서버: 설정 없음");
    expect(networkFetch).not.toHaveBeenCalled();
  });
});

describe("HTML 에 없는 것 · 내비게이션", () => {
  it("비밀값 · 관측 서버 주소 · 원문 표식 · 스크립트가 없다", async () => {
    const html = await render({ request_id: TRACE_REQUEST_ID });
    expectNoForbiddenText(html);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain(FAKE_OBSERVE_URL);
  });

  it("내비게이션의 '요청 추적'에 aria-current, 관측 서버의 로그 조회는 한 번만", async () => {
    const html = await render({ request_id: TRACE_REQUEST_ID });
    expect(html).toMatch(/href="\/trace" aria-current="page"[^>]*>요청 추적</);
    expect(callsToPath(observeCalls(networkFetch), "/logs")).toHaveLength(1);
  });

  it("메타 제목", async () => {
    const module = await import("@/app/trace/page");
    expect(module.metadata).toEqual({ title: "요청 추적 · study-note 어드민" });
  });
});

describe("로그 화면(/logs)에서 이 화면으로", () => {
  const SELECTED_LINE = fakeLogLine();   // backend error, 요청 ID req-trace-1
  const NO_REQUEST_LINE = fakeLogLine({ milliseconds: SELECTED_MILLISECONDS + 100, sequence: 0, requestId: "", service: "observe", level: "info", message: "수집 한 바퀴" });
  const LIST_RANGE = { from: new Date(SELECTED_MILLISECONDS - HOUR).toISOString(), to: new Date(SELECTED_MILLISECONDS + HOUR).toISOString() };

  async function renderLogs(searchParams: Record<string, string>): Promise<string> {
    return renderElement(await LogsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  it("요청 ID 가 있는 줄을 고르면 그 요청 ID 의 추적 화면으로 가는 링크(/trace?request_id=…)", async () => {
    useLines([SELECTED_LINE, NO_REQUEST_LINE]);
    const html = await renderLogs({ ...LIST_RANGE, selected: SELECTED_LOG_ID });
    const links = [...html.matchAll(/<a[^>]*href="(\/trace\?[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
    expect(links.length, "추적 화면 링크가 없다").toBeGreaterThan(0);
    for (const [, href] of links) expect(paramsOf(decodeAttribute(href), "/trace")).toEqual({ request_id: SELECTED_REQUEST_ID });
    expect(links.some(([whole]) => textOf(whole).includes("추적") || /aria-label="[^"]*추적/.test(whole))).toBe(true);
  });

  it("요청 ID 가 없는 줄을 고르면 그 줄의 추적 링크는 없다(빈 요청 ID 로 가지 않는다)", async () => {
    useLines([NO_REQUEST_LINE]);
    const html = await renderLogs({ ...LIST_RANGE, selected: logIdOf(NO_REQUEST_LINE) });
    expect(html).not.toContain('href="/trace?');
  });
});
