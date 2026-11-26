/** 통신 지도 화면(T8) — 실제 렌더(서버 컴포넌트 → HTML, 브라우저 조각은 첫 그림). 진입 함수 · 허브 · 전역 fetch(가짜 관측 서버 — 실제 규칙 흉내)를 거친다.
 * 쪽 · 내비게이션 · 기간 고르기(스크립트 없는 링크) · 선의 표(그림 말고 표로도 같은 값) · 그림은 꾸밈(aria-hidden) · 모름과 0 의 글 · 수집이 밀린 서버 ·
 * 잃은 순번 · 선의 상한 · 연결의 상태(연결 중 · 실시간 · 끊김 — 다시 붙는 중과 마지막으로 받은 시각 · 세션 끝) · 깨진 갱신 · 관측 서버에 닿지 못함 ·
 * HTML 에 주소 · 비밀값 · 스크립트가 없다. 본문(TrafficMapBody)은 상태마다 따로 그려 본다. */
import { createElement } from "react";
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

import TrafficPage from "@/app/traffic/page";
import { ADMIN_SCREENS } from "@/features/admin-shell/ui/admin-screens";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { formatKoreanLogTime } from "@/features/logs/ui/LogTable";
import type { TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";
import {
  initialTrafficMapStreamState, reduceTrafficMapStream, type TrafficMapStreamAction, type TrafficMapStreamState,
} from "@/features/traffic-map/lib/traffic-map-stream-state";
import {
  LEAKED_ADDRESS, chatMapEdges, createFakeObserveMap, fakeEdge, fakeMapServer, trafficMapEventOf,
} from "@/features/traffic-map/lib/traffic-map-test-fakes";
import { defaultTrafficMapHub } from "@/features/traffic-map/server/traffic-map";
import { TrafficMapBody } from "@/features/traffic-map/ui/TrafficMapBody";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, createRoutedFetch,
  expectNoForbiddenText, leakyErrorBody, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";
import { upstreamFailure } from "@/shared/lib/upstream-result";

let observe: ReturnType<typeof createFakeObserveMap>;
let observeHandler: RoutedFetchHandler;
const networkFetch = createRoutedFetch((url, init) => {
  if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected host ${url.hostname}`);
  return observeHandler(url, init);
});

async function markup(element: unknown): Promise<string> {
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

async function renderPage(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  return markup(await TrafficPage({ searchParams: Promise.resolve(searchParams) }));
}

async function renderBody(streamState: TrafficMapStreamState, range: "5m" | "1h" | "24h" = "5m"): Promise<string> {
  return markup(createElement(TrafficMapBody, { range, state: streamState }));
}

function decode(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function textOf(fragment: string): string {
  return decode(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function tableByLabel(html: string, label: string): string {
  const labelAt = html.indexOf(`aria-label="${label}"`);
  expect(labelAt, `aria-label="${label}" 가 없다`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<table", labelAt), html.indexOf("</table>", labelAt) + "</table>".length);
}

function rowsOf(html: string, label: string): string[][] {
  const body = /<tbody[\s>][\s\S]*?<\/tbody>/.exec(tableByLabel(html, label))?.[0] ?? "";
  return (body.match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? []).map((row) =>
    [...row.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/g)].map((match) => textOf(match[2])));
}

function headerOf(html: string, label: string): string[] {
  const head = /<thead[\s>][\s\S]*?<\/thead>/.exec(tableByLabel(html, label))?.[0] ?? "";
  return [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((match) => textOf(match[1]));
}

function statusText(html: string): string {
  const match = /<[a-z]+[^>]*role="status"[^>]*>([\s\S]*?)<\/(p|div)>/.exec(html);
  expect(match, "연결 상태(role=status)가 없다").not.toBeNull();
  return textOf(match![1]);
}

function svgOf(html: string): string {
  const match = /<svg[\s\S]*?<\/svg>/.exec(html);
  expect(match, "그림(svg)이 없다").not.toBeNull();
  return match![0];
}

function stateAfter(initial: TrafficMapEvent | null, ...actions: TrafficMapStreamAction[]): TrafficMapStreamState {
  return actions.reduce(reduceTrafficMapStream, initialTrafficMapStreamState(initial));
}

const mapAction = (event: unknown): TrafficMapStreamAction => ({ type: "map", data: JSON.stringify(event) });

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
  observe = createFakeObserveMap({ edges: chatMapEdges(), servers: [fakeMapServer()] });
  observeHandler = observe.handler;
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  defaultTrafficMapHub().clear();
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("쪽 · 내비게이션 · 기간", () => {
  it("화면 목록에 통신 지도(/traffic) — 내비게이션의 그 링크에 aria-current", async () => {
    expect(ADMIN_SCREENS.find((screen) => (screen.key as string) === "traffic")).toMatchObject({ title: "통신 지도", path: "/traffic" });
    const html = await renderPage();
    expect(html).toMatch(/href="\/traffic" aria-current="page"[^>]*>통신 지도</);
    expect(html).toMatch(/<h1[^>]*>통신 지도<\/h1>/);
  });

  it("메타 제목", async () => {
    const module = await import("@/app/traffic/page");
    expect(module.metadata).toEqual({ title: "통신 지도 · study-note 어드민" });
  });

  it("로그인하지 않으면 /login — 관측 서버를 부르지 않는다", async () => {
    state.cookieValue = undefined;
    await expect(renderPage()).rejects.toThrow("redirect:/login");
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("기간 고르기는 스크립트 없는 링크 셋(5분 · 1시간 · 24시간) — 고른 것에 aria-current · 기본은 5분", async () => {
    const html = await renderPage();
    const nav = /<nav[^>]*aria-label="기간"[^>]*>[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    expect([...nav.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((match) => [decode(match[1]), match[2]])).toEqual([
      ["/traffic?range=5m", "5분"], ["/traffic?range=1h", "1시간"], ["/traffic?range=24h", "24시간"],
    ]);
    expect(nav).toMatch(/href="\/traffic\?range=5m" aria-current="page"/);
    const longer = await renderPage({ range: "24h" });
    expect(longer).toMatch(/href="\/traffic\?range=24h" aria-current="page"/);
    const url = new URL(networkFetch.mock.calls.at(-1)![0]);
    expect(Date.parse(url.searchParams.get("to")!) - Date.parse(url.searchParams.get("from")!)).toBe(24 * 60 * 60_000);
  });

  it("관측 서버는 한 번 — 첫 그림은 허브의 snapshot", async () => {
    await renderPage();
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });
});

describe("선의 표 — 그림 말고 표로도 같은 값", () => {
  it("머리글", async () => {
    expect(headerOf(await renderPage(), "통신 선")).toEqual(["부른 쪽", "받는 쪽", "갈래", "요청", "오류 비율", "중앙값", "95%", "가장 긴", "채움"]);
  });

  it("줄마다 — 관측 서버의 차례 · 모름과 0 을 가른 글 · 분위수의 경계 · 갈래의 낱말", async () => {
    expect(rowsOf(await renderPage(), "통신 선")).toEqual([
      ["front", "backend", "요청", "20건 + 채우는 중 50건", "10.0%", "≤ 5ms", "≤ 1초", "3분 20초", "덜 들어왔을 수 있음"],
      ["edge", "front", "요청", "40건", "2.5%", "≤ 250ms", "≤ 5초", "4.1초", "채워짐"],
      ["backend", "llm-wrapper", "요청", "아직 모름(채우는 중 3건)", "—", "—", "—", "—", "아직 모름"],
      ["backend", "llm-wrapper", "스트림", "8건", "0.0%", "—", "—", "—", "채워짐"],
      ["alert", "observe", "헬스", "4건", "0.0%", "—", "—", "—", "채워짐"],
    ]);
  });

  it("목록 밖 이름은 '(목록 밖)'을 곁에 — 글로만", async () => {
    observe.store.edges = [fakeEdge({ service: "backend", caller: "batch-job" })];
    const [row] = rowsOf(await renderPage(), "통신 선");
    expect(row.slice(0, 2)).toEqual(["batch-job (목록 밖)", "backend"]);
  });

  it("그림은 꾸밈 — svg 는 aria-hidden · 마디마다 이름 · 선마다 하나(data-edge) · 모름 · 덜 들어온 선은 점선(색에만 기대지 않는다)", async () => {
    const svg = svgOf(await renderPage());
    expect(svg).toMatch(/^<svg[^>]*aria-hidden="true"/);
    for (const name of ["front", "backend", "llm-wrapper", "observe", "edge", "alert"]) expect(svg).toContain(`>${name}</text>`);
    const lines = [...svg.matchAll(/<[a-z]+[^>]*data-edge="([^"]+)"[^>]*>/g)];
    expect(lines.map((match) => decode(match[1]))).toEqual([
      "front→backend:request", "edge→front:request", "backend→llm-wrapper:request", "backend→llm-wrapper:stream", "alert→observe:health",
    ]);
    const dashed = (key: string) => lines.find((match) => decode(match[1]) === key)![0].includes("stroke-dasharray");
    expect(dashed("backend→llm-wrapper:request")).toBe(true);
    expect(dashed("front→backend:request")).toBe(true);
    expect(dashed("edge→front:request")).toBe(false);
  });

  it("선이 없으면 — '이 기간에 지나간 요청이 없습니다'(밀린 서버가 없을 때)", async () => {
    observe.store.edges = [];
    const html = await renderPage();
    expect(textOf(html)).toContain("이 기간에 지나간 요청이 없습니다");
    expect(html).not.toContain('aria-label="통신 선"');
  });

  it("선이 없고 수집이 밀린 서버가 있으면 — 0 이라 하지 않고 '아직 모를 수 있습니다'", async () => {
    observe.store.edges = [];
    observe.store.servers = [fakeMapServer({ receiveDelayed: true })];
    const text = textOf(await renderPage());
    expect(text).toContain("이 기간에 받은 선이 없습니다 — 수집이 밀린 서버가 있어 아직 모를 수 있습니다");
    expect(text).not.toContain("지나간 요청이 없습니다");
  });

  it("선이 200개보다 많으면 '요청이 많은 200개만' — 표도 200줄", async () => {
    observe.store.edges = Array.from({ length: 230 }, (_, index) => fakeEdge({ service: `svc-${String(index).padStart(3, "0")}` }));
    const html = await renderPage();
    expect(textOf(html)).toContain("선이 230개라 요청이 많은 200개만 보입니다");
    expect(rowsOf(html, "통신 선")).toHaveLength(200);
  });
});

describe("모름을 드러낸다 — 서버의 수신 상태", () => {
  it("수집 상태 표 — 서버 · 읽기 진도 · 수신 · 잃은 순번 · 버린 요청별 줄", async () => {
    observe.store.servers = [
      fakeMapServer({ server: "ci-agent-158" }),
      fakeMapServer({ server: "ci-agent-164", readProgressMilliseconds: null, receiveDelayed: true, sequenceGaps: 2, requestsDropped: 3, requestsRejected: 1 }),
    ];
    const html = await renderPage();
    expect(headerOf(html, "수집 상태")).toEqual(["서버", "읽기 진도", "수신", "잃은 순번", "버린 요청별 줄"]);
    expect(rowsOf(html, "수집 상태")).toEqual([
      ["ci-agent-158", formatKoreanLogTime("2026-11-25T04:09:00Z"), "정상", "0개", "0줄"],
      ["ci-agent-164", "아직 없음", "수신 지연", "2개", "4줄"],
    ]);
  });

  it("수집이 밀린 서버 · 채우는 중인 선 · 잃은 순번 — 글로(role=note)", async () => {
    observe.store.servers = [fakeMapServer({ server: "ci-agent-164", receiveDelayed: true, sequenceGaps: 2 })];
    const html = await renderPage();
    const text = textOf(html);
    expect(text).toContain("수집이 밀린 서버: ci-agent-164 — 그 서버가 받은 요청은 지도에 덜 들어왔을 수 있습니다");
    expect(text).toContain("채우는 중인 선이 있습니다 — 그 수는 아직 늘 수 있고 판정(색)에 쓰지 않습니다");
    expect(text).toContain("잃은 순번이 있는 서버: ci-agent-164 2개 — 잃은 항목의 요청은 지도에 없습니다(확정된 잃음과 아직 기다리는 중을 가르지 않습니다)");
    expect(html.match(/role="note"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("모두 정상이고 채우는 중이 없으면 그 알림들이 없다", async () => {
    observe.store.edges = [fakeEdge()];
    const text = textOf(await renderPage());
    expect(text).not.toContain("수집이 밀린 서버");
    expect(text).not.toContain("채우는 중인 선이 있습니다");
    expect(text).not.toContain("잃은 순번이 있는 서버");
  });

  it("관측 서버에 닿지 못하면(첫 그림) — '지도를 읽지 못했습니다' · 표 없음 · 원문 없음", async () => {
    observeHandler = () => textResponse(leakyErrorBody(), 503);
    const html = await renderPage();
    expect(textOf(html)).toContain("지도를 읽지 못했습니다 — 관측 서버: 서버 일시 장애 · HTTP 503");
    expect(html).not.toContain('aria-label="통신 선"');
    expectNoForbiddenText(html);
  });
});

describe("연결의 상태 — 본문을 상태마다", () => {
  const FIRST_AT = Date.UTC(2026, 10, 25, 4, 10, 0, 0);
  const firstTime = formatKoreanLogTime(new Date(FIRST_AT).toISOString());
  let first: TrafficMapEvent;
  beforeEach(() => { first = trafficMapEventOf(1, chatMapEdges(), { fetchedAt: FIRST_AT }); });

  it("첫 그림(연결 중) — '연결 중 · 마지막 갱신 <시각>'", async () => {
    expect(statusText(await renderBody(stateAfter(first)))).toBe(`연결 중 · 마지막 갱신 ${firstTime}`);
  });

  it("열림 + 새 사건 — '실시간 · 마지막 갱신 <새 시각>' · 값이 바뀐다", async () => {
    const next = trafficMapEventOf(2, [fakeEdge({ service: "front", caller: "edge", count: 99 })], { fetchedAt: Date.UTC(2026, 10, 25, 4, 10, 30, 0) });
    const html = await renderBody(stateAfter(first, { type: "open" }, mapAction(next)));
    expect(statusText(html)).toBe(`실시간 · 마지막 갱신 ${formatKoreanLogTime(next.fetchedAt)}`);
    expect(rowsOf(html, "통신 선").map((row) => row[3])).toEqual(["99건"]);
  });

  it("끊김 — '끊김 — 다시 붙는 중 · 마지막으로 받은 시각 <시각>' · 값은 그 시각의 것이라고 적는다(낡은 값을 지금 값처럼 보이지 않는다)", async () => {
    const html = await renderBody(stateAfter(first, { type: "open" }, { type: "error" }));
    expect(statusText(html)).toBe(`끊김 — 다시 붙는 중 · 마지막으로 받은 시각 ${firstTime}`);
    expect(textOf(html)).toContain(`아래 값은 ${firstTime} 의 것입니다 — 지금 값이 아닐 수 있습니다`);
    expect(html).toMatch(/role="note"[^>]*>[^<]*아래 값은/);
  });

  it("열려 있을 때는 낡은 값이라는 글이 없다", async () => {
    expect(textOf(await renderBody(stateAfter(first, { type: "open" })))).not.toContain("지금 값이 아닐 수 있습니다");
  });

  it("세션 끝 — '세션이 끝났습니다 — 다시 로그인하세요'와 로그인 링크", async () => {
    const html = await renderBody(stateAfter(first, { type: "open" }, { type: "session" }));
    expect(statusText(html)).toContain("세션이 끝났습니다 — 다시 로그인하세요");
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>/);
  });

  it("관측 서버에 닿지 못한 사건 — 앞의 지도는 그대로 · '관측 서버에 닿지 못함 — <까닭>' · '아래는 <시각> 에 받은 값입니다'", async () => {
    const failed: TrafficMapEvent = { sequence: 2, fetchedAt: "2026-11-25T04:10:30.000Z", range: "5m", map: upstreamFailure("server_timeout", { status: 504 }) };
    const html = await renderBody(stateAfter(first, { type: "open" }, mapAction(failed)));
    const text = textOf(html);
    expect(text).toContain("관측 서버에 닿지 못함 — 서버 조회 시간 초과 · HTTP 504");
    expect(text).toContain(`아래는 ${firstTime} 에 받은 값입니다`);
    expect(rowsOf(html, "통신 선")).toHaveLength(5);
    expect(html).toMatch(/role="alert"[^>]*>[\s\S]*?관측 서버에 닿지 못함/);
  });

  it("깨진 갱신 — 화면은 그대로 · '깨진 갱신 2건을 버렸습니다'", async () => {
    const html = await renderBody(stateAfter(first, { type: "open" }, { type: "map", data: "{broken" }, { type: "map", data: "{}" }));
    expect(textOf(html)).toContain("깨진 갱신 2건을 버렸습니다");
    expect(rowsOf(html, "통신 선")).toHaveLength(5);
  });

  it("진도가 뒤로 간 사건 — '채워짐'이던 선이 '덜 들어왔을 수 있음' · '아직 모름'으로 다시(0건이 아니다)", async () => {
    const settled = trafficMapEventOf(2, [fakeEdge({ service: "front", caller: "edge", count: 20 })]);
    const back = trafficMapEventOf(3, [fakeEdge({ service: "front", caller: "edge", count: 0, fillingCount: 20, status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 }, p50: null, p95: null, maxMilliseconds: null })]);
    const before = await renderBody(stateAfter(first, { type: "open" }, mapAction(settled)));
    expect(rowsOf(before, "통신 선")[0].slice(3)).toEqual(["20건", "0.0%", "≤ 50ms", "≤ 250ms", "240ms", "채워짐"]);
    const after = await renderBody(stateAfter(first, { type: "open" }, mapAction(settled), mapAction(back)));
    expect(rowsOf(after, "통신 선")[0].slice(3)).toEqual(["아직 모름(채우는 중 20건)", "—", "—", "—", "—", "아직 모름"]);
    expect(rowsOf(after, "통신 선")[0]).not.toContain("0건");
  });

  it("첫 그림도 사건도 없으면(연결 중) — 값 대신 '아직 받은 지도가 없습니다'", async () => {
    const html = await renderBody(stateAfter(null));
    expect(textOf(html)).toContain("아직 받은 지도가 없습니다");
    expect(html).not.toContain('aria-label="통신 선"');
  });
});

describe("HTML 에 없는 것", () => {
  it("관측 서버가 계약 밖 칸에 실은 주소 · 비밀값 · 관측 서버 주소 · 스크립트 태그가 없다", async () => {
    const html = await renderPage();
    expect(html).not.toContain(LEAKED_ADDRESS);
    expectNoForbiddenText(html);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain(FAKE_OBSERVE_URL);
  });

  it("서버 이름 속의 주소 꼴은 가린다", async () => {
    observe.store.servers = [fakeMapServer({ server: "edge-203.0.113.9" })];
    const html = await renderPage();
    expect(html).not.toContain("203.0.113.9");
    expect(rowsOf(html, "수집 상태")[0][0]).toBe("edge-(주소)");
  });
});
