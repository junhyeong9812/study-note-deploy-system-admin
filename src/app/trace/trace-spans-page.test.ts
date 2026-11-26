/** 요청 추적 화면에 구간을 겹친 것(T7) — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 관측 서버 — 로그 `GET /logs` 와
 * 통신 `GET /traffic/requests` · `GET /traffic/map` 의 실제 규칙 흉내)를 거친다.
 * 서비스별 구간(같은 축 — 로그와 구간을 합친 범위) · 구간 표(서버 · 부른 쪽 · 요청 · 시작 · 끝 · 걸린 시간 · upstream · nginx 안 · 상태 · 바이트 · 구간 안 로그) ·
 * 칸마다 따로의 실패 · 빈 상태 셋 · 조용히 빠진 것의 알림(읽기 진도 · 수신 지연 · 틈 · 버린 줄 · 잘림 · 수신 상태 실패) · 경로의 이스케이프 · 자르기 · 제어 문자 ·
 * 서버 이름 속의 주소 · 색에만 기대지 않음(5xx 는 글로) · 막대는 꾸밈(표로 읽힌다) · 스크립트 없음 · 로그인. */
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
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { createFakeObserveLogs, fakeLogLine, type FakeLogLine } from "@/features/log-trace/lib/log-trace-test-fakes";
import { TRACE_REQUEST_ID, TRACE_START_MILLISECONDS } from "@/features/request-trace/lib/request-trace-test-fakes";
import {
  OVERLAY_LOG_SCENARIO, callsToPath, createFakeObserveTraffic, fakeServerReceipt, fakeSpan, observeLogsAndTraffic, overlaySpanScenario,
  fakeReceivedEntry, type FakeReceivedEntry, type FakeServerReceipt, type FakeSpan,
} from "@/features/request-trace/lib/traffic-span-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, UPSTREAM_RAW_MARKER,
  createRoutedFetch, expectNoForbiddenText, jsonBody, leakyErrorBody, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const T = TRACE_START_MILLISECONDS;
const CAUGHT_UP = T + 3700 + 60_000;   // 기준(마지막 시각 T + 3700) + 30초보다 뒤

function scenarioLogLines(): FakeLogLine[] {
  return OVERLAY_LOG_SCENARIO.map(([offset, service, level, message]) =>
    fakeLogLine({ milliseconds: T + offset, sequence: 0, service, level, requestId: TRACE_REQUEST_ID, message }));
}

let logsHandler: RoutedFetchHandler;
let traffic: ReturnType<typeof createFakeObserveTraffic>;
let trafficOverride: ((url: URL) => Response | Promise<Response> | null) | null = null;

function useLogs(lines: FakeLogLine[]) { logsHandler = createFakeObserveLogs(lines).handler; }
function useTraffic(spans: FakeSpan[], servers: FakeServerReceipt[] = [fakeServerReceipt({ readProgressMilliseconds: CAUGHT_UP })], entries: FakeReceivedEntry[] = []) {
  traffic = createFakeObserveTraffic({ spans, servers, entries });
}

const networkFetch = createRoutedFetch((url, init) => {
  if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected host ${url.hostname}`);
  return observeLogsAndTraffic(logsHandler, (trafficUrl, trafficInit) => trafficOverride?.(trafficUrl) ?? traffic.handler(trafficUrl, trafficInit))(url, init);
});

async function render(searchParams: Record<string, string | string[]> = { request_id: TRACE_REQUEST_ID }): Promise<string> {
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(await TracePage({ searchParams: Promise.resolve(searchParams) }));
}

function decode(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function textOf(fragment: string): string {
  return decode(fragment.replace(/<[^>]+>/g, ""));
}

function tableByLabel(html: string, label: string): string {
  const labelAt = html.indexOf(`aria-label="${label}"`);
  expect(labelAt, `aria-label="${label}" 가 없다`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<table", labelAt);
  const end = html.indexOf("</table>", labelAt);
  return html.slice(start, end + "</table>".length);
}

/** 표의 본문 줄마다 [줄 머리(th) 글, …칸(td) 글]. */
function bodyRows(table: string): string[][] {
  const body = /<tbody[\s>][\s\S]*?<\/tbody>/.exec(table)?.[0] ?? "";
  return (body.match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? []).map((row) =>
    [...row.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/g)].map((match) => textOf(match[2]).trim()));
}

function rowsOf(html: string, label: string): string[][] {
  return bodyRows(tableByLabel(html, label));
}

function headerOf(html: string, label: string): string[] {
  const head = /<thead[\s>][\s\S]*?<\/thead>/.exec(tableByLabel(html, label))?.[0] ?? "";
  return [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((match) => textOf(match[1]).trim());
}

/** 구간 절(<section aria-labelledby="request-trace-spans">)의 글. */
function spansSectionText(html: string): string {
  const match = /<section[^>]*aria-labelledby="request-trace-spans"[^>]*>[\s\S]*?<\/section>/.exec(html);
  expect(match, "구간 절이 없다").not.toBeNull();
  return textOf(match![0]);
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
  useLogs(scenarioLogLines());
  useTraffic(overlaySpanScenario(TRACE_REQUEST_ID, T));
  trafficOverride = null;
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("서비스별 구간 — 로그와 구간을 한 축에(글로 읽힌다)", () => {
  it("머리글과 축의 범위 — 로그와 구간을 합친 0 ~ 3.7초(로그만이면 3.7초가 아니다)", async () => {
    const html = await render();
    expect(headerOf(html, "서비스별 구간")).toEqual(["서비스", "구간", "로그", "구간 밖 로그", "시간 줄(0 ~ 3.7초)"]);
  });

  it("줄마다 서비스(규약 이름) · 구간 수 · 로그 수 · 구간 밖 로그 — 처음 나타난 시각 차례, 에이전트의 로그 이름은 ci-agent 로 읽고 이름을 함께 보인다", async () => {
    const rows = rowsOf(await render(), "서비스별 구간").map((row) => row.slice(0, 4));
    expect(rows).toEqual([
      ["front", "1개", "2줄", "0줄"],
      ["backend", "1개", "3줄", "1줄"],
      ["llm-wrapper", "1개", "1줄", "0줄"],
      ["ci-agent", "구간 없음", "1줄(ci-agent-158)", "1줄"],
    ]);
  });

  it("막대는 꾸밈 — 막대 칸은 aria-hidden 이고 글이 없다(글은 표에 다 있다)", async () => {
    const table = tableByLabel(await render(), "서비스별 구간");
    const body = /<tbody[\s>][\s\S]*?<\/tbody>/.exec(table)![0];
    for (const row of body.match(/<tr[\s>][\s\S]*?<\/tr>/g)!) {
      const cells = [...row.matchAll(/<td[^>]*>[\s\S]*?<\/td>/g)].map((match) => match[0]);
      const barCell = cells[cells.length - 1];
      expect(barCell).toContain('aria-hidden="true"');
      expect(textOf(barCell).trim()).toBe("");
    }
  });

  it("T3 의 서비스별 시간 줄 표 · 이 요청의 로그는 그대로 있다", async () => {
    const html = await render();
    expect(html).toContain('aria-label="서비스별 시간 줄"');
    expect(html).toContain('aria-label="이 요청의 로그"');
  });
});

describe("접속 기록의 구간 — 구간 하나 = 한 줄", () => {
  it("머리글", async () => {
    expect(headerOf(await render(), "접속 기록의 구간")).toEqual([
      "서비스", "서버", "부른 쪽", "요청", "시작", "끝", "걸린 시간", "뒤(upstream)", "nginx 안", "상태", "보낸 바이트", "구간 안 로그",
    ]);
  });

  it("시작순 · 시작은 끝 − 걸린 시간 · 같은 축의 +ms · upstream 과 nginx 안이 갈린다 · 5xx 는 글로 · 구간 안 로그의 수", async () => {
    expect(rowsOf(await render(), "접속 기록의 구간")).toEqual([
      ["front", "ci-agent-158", "outside", "POST /api/chat", "+0ms", "+3.7초", "3.7초", "3.6초", "100ms", "500 서버 오류", "512바이트", "2줄"],
      ["backend", "ci-agent-164", "front", "POST /api/chat", "+110ms", "+3.6초", "3.4초", "3.4초", "10ms", "502 서버 오류", "0바이트", "2줄"],
      ["llm-wrapper", "ci-agent-164", "backend", "POST /chat", "+2.3초", "+3.3초", "1초", "990ms", "10ms", "200", "2048바이트", "1줄"],
    ]);
  });

  it("upstream 이 없으면 '—'(0 으로 두지 않는다) · 0ms 구간은 0ms · 4xx 는 오류 낱말 없이", async () => {
    useLogs([]);
    useTraffic([
      fakeSpan({ requestId: TRACE_REQUEST_ID, service: "front", caller: "edge", endMilliseconds: T, durationMilliseconds: 0, upstreamMilliseconds: null, upstreamStatus: null, status: 404 }),
    ]);
    const [row] = rowsOf(await render(), "접속 기록의 구간");
    expect(row.slice(4, 11)).toEqual(["+0ms", "+0ms", "0ms", "—", "—", "404", "5120바이트"]);
  });

  it("nginx 안이 음수면 '—'가 아닌 글 — 값과 '(시계 어긋남)'(upstream 이 없는 '—'와 다르다 — T7 리뷰 4)", async () => {
    useLogs([]);
    useTraffic([
      fakeSpan({ requestId: TRACE_REQUEST_ID, service: "backend", status: 504, endMilliseconds: T + 100, durationMilliseconds: 0, upstreamMilliseconds: 5, upstreamStatus: "502, 504" }),
      fakeSpan({ requestId: TRACE_REQUEST_ID, service: "front", endMilliseconds: T + 200, durationMilliseconds: 500, upstreamMilliseconds: 2000 }),
      fakeSpan({ requestId: TRACE_REQUEST_ID, service: "admin", endMilliseconds: T + 300, durationMilliseconds: 10, upstreamMilliseconds: null }),
    ]);
    const rows = rowsOf(await render(), "접속 기록의 구간");
    expect(rows.map((row) => [row[0], row[7], row[8]])).toEqual([
      ["front", "2초", "-1.5초(시계 어긋남)"], ["backend", "5ms", "-5ms(시계 어긋남)"], ["admin", "—", "—"],
    ]);
  });

  it("걸린 시간이 날짜의 범위를 벗어나게 크면(9000000000000000) — 화면이 깨지지 않고 '구간을 읽지 못했습니다 — 해석 불가'(T7 리뷰 7)", async () => {
    trafficOverride = (url) => (url.pathname === "/traffic/requests" ? jsonBody({ success: true, data: {
      request_id: TRACE_REQUEST_ID, truncated: false,
      spans: [{ server: "ci-agent-158", service: "backend", caller: "front", method: "GET", path: "/", path_truncated: false, status: 200,
        end_at: "2026-11-22T10:00:00Z", duration_ms: 9_000_000_000_000_000, upstream_ms: null, upstream_status: null, slot: null, bytes_sent: 0 }],
    } }) : null);
    const html = await render();
    expect(spansSectionText(html)).toContain("구간을 읽지 못했습니다 — 관측 서버: 해석 불가");
    expect(html).toContain('aria-label="서비스별 시간 줄"');
  });

  it("같은 서비스의 구간 여럿(재시도 · 두 서버) — 줄마다 서버가 드러난다", async () => {
    useLogs([]);
    useTraffic([
      fakeSpan({ requestId: TRACE_REQUEST_ID, server: "ci-agent-158", service: "backend", endMilliseconds: T + 100, durationMilliseconds: 100, status: 502 }),
      fakeSpan({ requestId: TRACE_REQUEST_ID, server: "ci-agent-164", service: "backend", endMilliseconds: T + 300, durationMilliseconds: 100, status: 200 }),
    ]);
    const html = await render();
    expect(rowsOf(html, "접속 기록의 구간").map((row) => [row[0], row[1], row[9]])).toEqual([
      ["backend", "ci-agent-158", "502 서버 오류"], ["backend", "ci-agent-164", "200"],
    ]);
    expect(rowsOf(html, "서비스별 구간").map((row) => row.slice(0, 2))).toEqual([["backend", "2개"]]);
  });

  it("시계가 어긋나 구간이 로그보다 앞에서 끝나도 그대로 — 음수 · NaN 없이", async () => {
    useLogs([fakeLogLine({ milliseconds: T + 10, sequence: 0, service: "backend", level: "info", requestId: TRACE_REQUEST_ID, message: "늦게 찍힌 줄" })]);
    useTraffic([fakeSpan({ requestId: TRACE_REQUEST_ID, service: "backend", endMilliseconds: T - 500, durationMilliseconds: 200 })]);
    const html = await render();
    expect(rowsOf(html, "접속 기록의 구간")[0].slice(4, 7)).toEqual(["+0ms", "+200ms", "200ms"]);
    expect(rowsOf(html, "서비스별 구간")[0].slice(0, 4)).toEqual(["backend", "1개", "1줄", "1줄"]);
    expect(html).not.toContain("NaN");
    expect(textOf(html)).not.toMatch(/\+-\d/);
  });
});

describe("경로 · 이름 — 받은 글자를 그대로 믿지 않는다", () => {
  it("태그가 든 경로는 이스케이프된다", async () => {
    useTraffic([fakeSpan({ requestId: TRACE_REQUEST_ID, path: `/<img src=x onerror=alert(1)><script>alert("x")</script>`, endMilliseconds: T + 100 })]);
    const html = await render();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("아주 긴 경로는 앞 120자 + … 로 — 나머지는 HTML 어디에도 없다", async () => {
    const path = `/${"a".repeat(200)}${"zzpathtail".repeat(80)}`;
    useTraffic([fakeSpan({ requestId: TRACE_REQUEST_ID, path, endMilliseconds: T + 100 })]);
    const html = await render();
    const [row] = rowsOf(html, "접속 기록의 구간");
    expect(row[3]).toBe(`GET /${"a".repeat(119)}…`);
    expect(html).not.toContain("zzpathtail");
  });

  it("관측 서버가 1024자에서 잘랐으면(path_truncated) 짧아도 …", async () => {
    useTraffic([fakeSpan({ requestId: TRACE_REQUEST_ID, path: "/wiki/doc", pathTruncated: true, endMilliseconds: T + 100 })]);
    expect(rowsOf(await render(), "접속 기록의 구간")[0][3]).toBe("GET /wiki/doc…");
  });

  it("경로의 쿼리 · 제어 문자는 화면에 없다(관측 서버가 막아도 한 겹 더)", async () => {
    useTraffic([fakeSpan({ requestId: TRACE_REQUEST_ID, path: "/search?q=secret-word", endMilliseconds: T + 100 }),
      fakeSpan({ requestId: TRACE_REQUEST_ID, path: "/a\u0007b\u001bc", endMilliseconds: T + 200 })]);
    const html = await render();
    expect(html).not.toContain("secret-word");
    expect(html).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
    expect(rowsOf(html, "접속 기록의 구간").map((row) => row[3])).toEqual(["GET /search", "GET /a�b�c"]);
  });

  it("서버 이름 속의 주소(IPv4)는 가린다", async () => {
    useTraffic([fakeSpan({ requestId: TRACE_REQUEST_ID, server: "edge-203.0.113.9", endMilliseconds: T + 100 })]);
    const html = await render();
    expect(html).not.toContain("203.0.113.9");
    expect(rowsOf(html, "접속 기록의 구간")[0][1]).toBe("edge-(주소)");
  });

  it("서비스 · 호출자 이름에 태그 · 주소가 오면 구간 전체를 읽지 못함으로(그 글자를 보이지 않는다)", async () => {
    trafficOverride = (url) => (url.pathname === "/traffic/requests" ? jsonBody({ success: true, data: {
      request_id: TRACE_REQUEST_ID, truncated: false,
      spans: [{ server: "ci-agent-158", service: "<b>x</b>", caller: "198.51.100.7", method: "GET", path: "/", path_truncated: false, status: 200,
        end_at: "2026-11-22T10:00:00Z", duration_ms: 1, upstream_ms: null, upstream_status: null, slot: null, bytes_sent: 0 }],
    } }) : null);
    const html = await render();
    expect(spansSectionText(html)).toContain("구간을 읽지 못했습니다 — 관측 서버: 해석 불가");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("198.51.100.7");
  });
});

describe("칸마다 따로 실패한다", () => {
  it("구간 조회가 실패해도(503) 로그의 시간 줄은 그대로 — '구간을 읽지 못했습니다'(‘구간이 없습니다’가 아니다)", async () => {
    trafficOverride = (url) => (url.pathname === "/traffic/requests" ? textResponse(leakyErrorBody(), 503) : null);
    const html = await render();
    const text = spansSectionText(html);
    expect(text).toContain("구간을 읽지 못했습니다 — 관측 서버: 서버 일시 장애 · HTTP 503");
    expect(text).not.toContain("구간이 없습니다");
    expect(html).not.toContain('aria-label="접속 기록의 구간"');
    expect(html).toContain('aria-label="서비스별 시간 줄"');
    expect(html).toMatch(/role="alert"[^>]*>[\s\S]*?구간을 읽지 못했습니다/);
    expectNoForbiddenText(html);
  });

  it("구간 조회가 닿지 않으면 '닿지 않음' — 원문 없음", async () => {
    trafficOverride = () => Promise.reject(new TypeError(`fetch failed ${UPSTREAM_RAW_MARKER} ${FAKE_OBSERVE_URL}`));
    const html = await render();
    expect(spansSectionText(html)).toContain("구간을 읽지 못했습니다 — 관측 서버: 닿지 않음");
    expectNoForbiddenText(html);
  });

  it("로그 조회가 실패해도(504) 구간은 그대로 — 로그 칸은 '읽지 못함', 구간 안 로그는 '—'", async () => {
    logsHandler = () => textResponse(leakyErrorBody(), 504);
    const html = await render();
    expect(textOf(html)).toContain("확인하지 못함 — 관측 서버: 서버 조회 시간 초과 · HTTP 504");
    expect(rowsOf(html, "서비스별 구간").map((row) => row.slice(0, 4))).toEqual([
      ["front", "1개", "읽지 못함", "—"], ["backend", "1개", "읽지 못함", "—"], ["llm-wrapper", "1개", "읽지 못함", "—"],
    ]);
    expect(rowsOf(html, "접속 기록의 구간").map((row) => row[11])).toEqual(["—", "—", "—"]);
    expect(textOf(html)).not.toContain("로그도 구간도 없습니다");
  });

  it("설정이 비면 두 칸 모두 '설정 없음' — 부르지 않는다", async () => {
    vi.stubEnv("OBSERVE_URL", "");
    const html = await render();
    expect(textOf(html)).toContain("확인하지 못함 — 관측 서버: 설정 없음");
    expect(spansSectionText(html)).toContain("구간을 읽지 못했습니다 — 관측 서버: 설정 없음");
    expect(networkFetch).not.toHaveBeenCalled();
  });
});

describe("빈 상태 셋", () => {
  it("요청 ID 없음 — 폼만, 구간 절 없음, 부르지 않는다", async () => {
    const html = await render({});
    expect(html).not.toContain('aria-labelledby="request-trace-spans"');
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("틀린 요청 ID — 구간 절 없음, 부르지 않는다", async () => {
    const html = await render({ request_id: "req:1" });
    expect(html).not.toContain('aria-labelledby="request-trace-spans"');
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("로그도 구간도 없음 — '이 요청 ID 의 로그도 구간도 없습니다', 표 없음", async () => {
    useLogs([]);
    useTraffic([]);
    const html = await render();
    expect(spansSectionText(html)).toContain("이 요청 ID 의 로그도 구간도 없습니다");
    expect(html).not.toContain('aria-label="서비스별 구간"');
    expect(html).not.toContain('aria-label="접속 기록의 구간"');
  });

  it("구간만 없음 — '이 요청 ID 의 구간이 없습니다', 로그의 시간 줄은 그대로", async () => {
    useTraffic([]);
    const html = await render();
    const text = spansSectionText(html);
    expect(text).toContain("이 요청 ID 의 구간이 없습니다");
    expect(text).not.toContain("로그도 구간도");
    expect(text).not.toContain("구간을 읽지 못했습니다");
    expect(html).toContain('aria-label="서비스별 시간 줄"');
    expect(html).not.toContain('aria-label="접속 기록의 구간"');
  });

  it("로그만 없음 — 구간은 보이고 로그 칸은 0줄(읽지 못함이 아니다)", async () => {
    useLogs([]);
    const html = await render();
    expect(rowsOf(html, "서비스별 구간").map((row) => row.slice(0, 4))).toEqual([
      ["front", "1개", "0줄", "0줄"], ["backend", "1개", "0줄", "0줄"], ["llm-wrapper", "1개", "0줄", "0줄"],
    ]);
    expect(textOf(html)).not.toContain("로그도 구간도 없습니다");
  });
});

describe("조용히 빠진 것을 글로 드러낸다", () => {
  const LEAD = "구간이 아직 다 들어오지 않았을 수 있습니다";

  it("모두 따라잡았으면 알림 없음 · 관측 서버를 세 번(로그 · 구간 · 수신 상태)", async () => {
    const html = await render();
    expect(textOf(html)).not.toContain(LEAD);
    expect(callsToPath(networkFetch.mock.calls, "/logs")).toHaveLength(1);
    expect(callsToPath(networkFetch.mock.calls, "/traffic/requests")).toHaveLength(1);
    expect(callsToPath(networkFetch.mock.calls, "/traffic/map")).toHaveLength(1);
  });

  it.each([
    ["읽기 진도가 마지막 시각 + 30초에 못 미침", { readProgressMilliseconds: T + 3700 + 29_999 }, "읽기 진도가 이 요청의 마지막 시각에 못 미친 서버: ci-agent-158"],
    ["읽기 진도가 없음", { readProgressMilliseconds: null }, "읽기 진도가 이 요청의 마지막 시각에 못 미친 서버: ci-agent-158"],
    ["수신 지연이고 진도도 못 미침", { readProgressMilliseconds: T + 1000, receiveDelayed: true }, "수신 지연: ci-agent-158"],
    ["읽지 못한 범위", { readProgressMilliseconds: CAUGHT_UP, missing: ["backend-nginx:rotated"] }, "읽지 못한 범위가 있는 서버: ci-agent-158"],
    ["상한으로 버린 줄", { readProgressMilliseconds: CAUGHT_UP, requestsDropped: 7 }, "상한으로 싣지 못한 요청별 줄: 7줄"],
    ["경로로 버린 줄", { readProgressMilliseconds: CAUGHT_UP, requestsRejected: 3 }, "경로 때문에 버린 요청별 줄: 3줄"],
  ] as const)("%s → 알림과 까닭(글로 · role=note)", async (_label, receipt, detail) => {
    useTraffic(overlaySpanScenario(TRACE_REQUEST_ID, T), [fakeServerReceipt(receipt as Partial<FakeServerReceipt>)]);
    const html = await render();
    const text = spansSectionText(html);
    expect(text).toContain(LEAD);
    expect(text).toContain(detail);
    expect(html).toMatch(new RegExp(`role="note"[^>]*>[\\s\\S]*?${LEAD}`));
  });

  const LOST_NOTE = /최근에 잃은 항목: ([^—]*?) — 이 요청의 것인지는 알 수 없습니다/;

  it("순번의 틈만 — 머리는 없고(누적이라 이 요청과 무관할 수 있다) 따로 한 줄: 서버와 수(T7 리뷰 1)", async () => {
    useTraffic(overlaySpanScenario(TRACE_REQUEST_ID, T), [
      fakeServerReceipt({ server: "ci-agent-158", readProgressMilliseconds: CAUGHT_UP, sequenceGaps: 2 }),
      fakeServerReceipt({ server: "ci-agent-164", readProgressMilliseconds: CAUGHT_UP, sequenceGaps: 1 }),
    ]);
    const html = await render();
    const text = spansSectionText(html);
    expect(text).not.toContain(LEAD);
    expect(LOST_NOTE.exec(text)?.[1]).toBe("ci-agent-158 2개, ci-agent-164 1개");
    expect(html).toMatch(/<p[^>]*role="note"[^>]*>최근에 잃은 항목: /);
  });

  it("구간이 없는 요청 ID(로그는 있음)에서 틈만 — 머리 없음 · '구간이 없습니다'와 틈의 한 줄", async () => {
    useTraffic([], [fakeServerReceipt({ readProgressMilliseconds: CAUGHT_UP, sequenceGaps: 1 })]);
    const text = spansSectionText(await render());
    expect(text).not.toContain(LEAD);
    expect(text).toContain("이 요청 ID 의 구간이 없습니다");
    expect(LOST_NOTE.exec(text)?.[1]).toBe("ci-agent-158 1개");
  });

  it("틈이 있고 진도도 못 미치면 — 머리(진도 때문)와 틈의 한 줄이 따로, 틈의 글은 머리의 목록 밖", async () => {
    useTraffic(overlaySpanScenario(TRACE_REQUEST_ID, T), [fakeServerReceipt({ readProgressMilliseconds: T, sequenceGaps: 3 })]);
    const html = await render();
    const lead = new RegExp(`<[a-z]+[^>]*role="note"[^>]*>(?:(?!role="note")[\\s\\S])*?${LEAD}(?:(?!role="note")[\\s\\S])*`).exec(html)?.[0] ?? "";
    expect(textOf(lead)).toContain("읽기 진도가 이 요청의 마지막 시각에 못 미친 서버: ci-agent-158");
    expect(textOf(lead)).not.toContain("최근에 잃은 항목");
    expect(LOST_NOTE.exec(spansSectionText(html))?.[1]).toBe("ci-agent-158 3개");
  });

  it("틈이 없으면 틈의 한 줄도 없다", async () => {
    expect(spansSectionText(await render())).not.toContain("최근에 잃은 항목");
  });

  it("수신 지연이어도 진도가 이 요청의 마지막 시각 + 30초를 지났으면 알림 없음(T7 리뷰 2)", async () => {
    useTraffic(overlaySpanScenario(TRACE_REQUEST_ID, T), [fakeServerReceipt({ readProgressMilliseconds: CAUGHT_UP, receiveDelayed: true })]);
    const text = spansSectionText(await render());
    expect(text).not.toContain(LEAD);
    expect(text).not.toContain("수신 지연");
  });

  it("요청 + 5분 뒤에 받은 항목의 버린 줄 · 읽지 못한 범위도 알림에 든다 — 요청 앞에 받은 것은 들지 않는다(창의 끝은 지금 — T7 리뷰 3)", async () => {
    useTraffic(overlaySpanScenario(TRACE_REQUEST_ID, T), [fakeServerReceipt({ readProgressMilliseconds: CAUGHT_UP })], [
      fakeReceivedEntry({ receivedMilliseconds: T - 60_000, requestsDropped: 100 }),
      fakeReceivedEntry({ receivedMilliseconds: T + 6 * 60_000, requestsDropped: 4, missing: ["backend-nginx:rotated"] }),
    ]);
    const text = spansSectionText(await render());
    expect(text).toContain(LEAD);
    expect(text).toContain("상한으로 싣지 못한 요청별 줄: 4줄");
    expect(text).toContain("읽지 못한 범위가 있는 서버: ci-agent-158");
  });

  it("로그도 구간도 없는 요청 ID — 진도가 없는 서버가 있어도 '못 미친 서버' 알림 없음 · 수신 상태를 부르지 않는다(T7 리뷰 5)", async () => {
    useLogs([]);
    useTraffic([], [fakeServerReceipt({ readProgressMilliseconds: null, receiveDelayed: true, sequenceGaps: 2 })]);
    const html = await render({ request_id: "req-typo-000" });
    const text = spansSectionText(html);
    expect(text).toContain("이 요청 ID 의 로그도 구간도 없습니다");
    expect(text).not.toContain(LEAD);
    expect(text).not.toContain("못 미친 서버");
    expect(callsToPath(networkFetch.mock.calls, "/traffic/map")).toHaveLength(0);
  });

  it("여러 서버 — 못 미친 서버만 이름이 나온다(받은 차례)", async () => {
    useTraffic(overlaySpanScenario(TRACE_REQUEST_ID, T), [
      fakeServerReceipt({ server: "ci-agent-158", readProgressMilliseconds: CAUGHT_UP }),
      fakeServerReceipt({ server: "ci-agent-164", readProgressMilliseconds: T }),
      fakeServerReceipt({ server: "ci-agent-170", readProgressMilliseconds: null }),
    ]);
    expect(spansSectionText(await render())).toContain("읽기 진도가 이 요청의 마지막 시각에 못 미친 서버: ci-agent-164, ci-agent-170");
  });

  it("구간이 없어도 진도가 못 미치면 알림 — '구간이 없습니다'와 함께(방금 끝난 요청)", async () => {
    useTraffic([], [fakeServerReceipt({ readProgressMilliseconds: T })]);
    const text = spansSectionText(await render());
    expect(text).toContain("이 요청 ID 의 구간이 없습니다");
    expect(text).toContain(LEAD);
  });

  it("수신 상태를 확인하지 못하면 그 까닭과 알림 — 구간은 그대로", async () => {
    trafficOverride = (url) => (url.pathname === "/traffic/map" ? textResponse(leakyErrorBody(), 503) : null);
    const html = await render();
    const text = spansSectionText(html);
    expect(text).toContain(LEAD);
    expect(text).toContain("수신 상태를 확인하지 못했습니다 — 관측 서버: 서버 일시 장애 · HTTP 503");
    expect(rowsOf(html, "접속 기록의 구간")).toHaveLength(3);
    expectNoForbiddenText(html);
  });

  it("관측 서버가 500 개에서 잘랐으면 '앞의 500개만'", async () => {
    useLogs([]);
    useTraffic(Array.from({ length: 501 }, (_, index) => fakeSpan({ requestId: TRACE_REQUEST_ID, endMilliseconds: T + index, durationMilliseconds: 1 })),
      [fakeServerReceipt({ readProgressMilliseconds: T + 600_000 })]);
    const html = await render();
    expect(spansSectionText(html)).toContain("구간이 500개보다 많아 앞의 500개만 보입니다");
    expect(spansSectionText(html)).not.toContain(LEAD);
    expect(rowsOf(html, "접속 기록의 구간")).toHaveLength(500);
  });

  it("읽기 진도는 뒤로 갈 수 있다 — 앞선 진도를 기억해 알림을 감추지 않는다(조회마다 새로 판정)", async () => {
    useTraffic(overlaySpanScenario(TRACE_REQUEST_ID, T), [fakeServerReceipt({ readProgressMilliseconds: CAUGHT_UP })]);
    expect(spansSectionText(await render())).not.toContain(LEAD);
    traffic.store.servers = [fakeServerReceipt({ readProgressMilliseconds: T + 1000 })];
    expect(spansSectionText(await render())).toContain(LEAD);
    traffic.store.servers = [fakeServerReceipt({ readProgressMilliseconds: CAUGHT_UP })];
    expect(spansSectionText(await render())).not.toContain(LEAD);
  });
});

describe("HTML 에 없는 것 · 로그인", () => {
  it("비밀값 · 관측 서버 주소 · 원문 표식 · 스크립트가 없다", async () => {
    const html = await render();
    expectNoForbiddenText(html);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain(FAKE_OBSERVE_URL);
  });

  it("로그인하지 않으면 /login — 관측 서버를 부르지 않는다(구간 조회 포함)", async () => {
    state.cookieValue = undefined;
    await expect(render()).rejects.toThrow("redirect:/login");
    expect(networkFetch).not.toHaveBeenCalled();
  });
});
