/** 로그 조회 화면 — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 관측 서버)를 거쳐 폼 칸과 현재 값 유지 · 결과 줄 · 수준 배지 ·
 * 요청 ID 링크 · 더 보기 링크(조건 유지 + 커서) · 0건 · 입력 오류 · 관측 서버 실패 · 메시지 글자 그대로 · 세션 없음 · 임시 제한 표시를 본다.
 * 비밀값 · 관측 서버 주소 · 원문은 HTML 에 없다. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ restricted: false, cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => state.restricted }));
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
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, UPSTREAM_RAW_MARKER, createRoutedFetch, expectNoForbiddenText, headersOf, jsonBody, leakyErrorBody,
  leakyNetworkError, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const RANGE = { from: "2026-11-22T00:00:00.250Z", to: "2026-11-22T01:00:00.750Z" };
const MULTILINE = "요청 처리 실패: 연결 거절\n  at Handler.run (handler.ts:10)\n  at main (index.ts:3)";

type Row = { id: string; at: string; level: string; service: string; request_id: string; message: string };

const ROWS: Row[] = [
  { id: "1763773200123-0", at: "2026-11-22T01:00:00.123Z", level: "error", service: "backend", request_id: "req-flow-0001-abcd", message: MULTILINE },
  { id: "1763773199000-1", at: "2026-11-22T00:59:59Z", level: "warning", service: "llm", request_id: "req-flow-0001-abcd", message: "느린 응답 3.2초" },
  { id: "1763773198000-0", at: "2026-11-22T00:59:58Z", level: "info", service: "front", request_id: "", message: "<script>alert('x')</script> <b>굵게</b>" },
  { id: "1763773197000-0", at: "2026-11-22T00:59:57Z", level: "debug", service: "admin", request_id: "req-2", message: "캐시 적중" },
];

function logBody(rows: Row[] = ROWS, nextBefore = "", range = RANGE) {
  return jsonBody({ success: true, data: { logs: rows, next_before: nextBefore, ...range, extra: UPSTREAM_RAW_MARKER } });
}

let handler: RoutedFetchHandler = () => logBody();
const observeFetch = createRoutedFetch((url, init) => handler(url, init));

async function render(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const element = await LogsPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function decodeAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** 링크 글자(또는 여는 태그 안의 글자)로 href 를 찾는다. */
function hrefOf(html: string, pattern: RegExp): string {
  const match = new RegExp(`<a[^>]*href="([^"]*)"[^>]*>${pattern.source}`).exec(html)
    ?? new RegExp(`<a[^>]*href="([^"]*)"[^>]*${pattern.source}`).exec(html);
  expect(match, `${pattern} 링크가 없다`).not.toBeNull();
  return decodeAttribute(match![1]);
}

function paramsOf(href: string): Record<string, string> {
  const url = new URL(href, FAKE_ORIGIN);
  expect(url.pathname).toBe("/logs");
  return Object.fromEntries(url.searchParams);
}

/** name 이 그것인 폼 칸의 여는 태그(input · select) — 속성 순서에 기대지 않으려고 태그 하나를 통째로 꺼낸다. */
function fieldTag(html: string, name: string): string {
  const match = new RegExp(`<(?:input|select)\\b[^>]*\\bname="${name}"[^>]*>`).exec(html);
  expect(match, `폼 칸 ${name} 이 없다`).not.toBeNull();
  return match![0];
}

function observeParams(callIndex = 0): Record<string, string> {
  return Object.fromEntries(new URL(observeFetch.mock.calls[callIndex][0]).searchParams);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  state.restricted = false;
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  handler = () => logBody();
  observeFetch.mockClear();
  vi.stubGlobal("fetch", observeFetch);
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("로그 조회 화면 — 폼", () => {
  it("GET 폼 · 칸마다 label(for = id) · 조건 전부(시작 · 끝 · 서비스 · 수준 · 요청 ID · 낱말 · 건수) · 브라우저 스크립트 없음", async () => {
    const html = await render();
    const formTag = /<form\b[^>]*>/.exec(html)?.[0] ?? "";
    expect(formTag).toContain('method="get"');
    expect(formTag).toContain('action="/logs"');
    for (const [id, name] of [["log-from", "from_kst"], ["log-to", "to_kst"], ["log-service", "service"], ["log-level", "level"],
      ["log-request-id", "request_id"], ["log-text", "q"], ["log-limit", "limit"]]) {
      expect(html).toContain(`for="${id}"`);
      expect(fieldTag(html, name)).toContain(`id="${id}"`);
    }
    expect(fieldTag(html, "from_kst")).toContain('type="datetime-local"');
    expect(fieldTag(html, "to_kst")).toContain('type="datetime-local"');
    for (const level of ["debug", "info", "warning", "error"]) expect(html).toContain(`<option value="${level}">${level}</option>`);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+="/i);
  });

  it("주소의 값을 폼에 다시 채운다 — KST 시각 칸은 UTC 로 바꿔 관측 서버에 보낸다", async () => {
    const html = await render({
      from_kst: "2026-11-22T09:00", to_kst: "2026-11-22T10:30:15", service: "backend", level: "error", request_id: "req-1", q: "time out", limit: "50",
    });
    expect(observeParams()).toEqual({
      from: "2026-11-22T00:00:00Z", to: "2026-11-22T01:30:15Z", service: "backend", level: "error", request_id: "req-1", q: "time out", limit: "50",
    });
    expect(headersOf(observeFetch.mock.calls[0][1]).get("X-Observe-Secret")).toBe(FAKE_OBSERVE_SECRET);
    expect(fieldTag(html, "from_kst")).toContain('value="2026-11-22T09:00"');
    expect(fieldTag(html, "to_kst")).toContain('value="2026-11-22T10:30:15"');
    expect(fieldTag(html, "service")).toContain('value="backend"');
    expect(html).toMatch(/<option value="error" selected="">error<\/option>/);
    expect(fieldTag(html, "request_id")).toContain('value="req-1"');
    expect(fieldTag(html, "q")).toContain('value="time out"');
    expect(fieldTag(html, "limit")).toContain('value="50"');
  });

  it("UTC 의 from · to(더 보기 주소)로 열면 시각 칸에는 KST 로 보인다", async () => {
    const html = await render({ from: "2026-11-22T00:00:00Z", to: "2026-11-22T01:00:00Z", before: "1763773197000-0" });
    expect(observeParams()).toMatchObject({ from: "2026-11-22T00:00:00Z", to: "2026-11-22T01:00:00Z", before: "1763773197000-0" });
    expect(fieldTag(html, "from_kst")).toContain('value="2026-11-22T09:00:00"');
    expect(fieldTag(html, "to_kst")).toContain('value="2026-11-22T10:00:00"');
  });

  it("빈 칸으로 제출하면(빈 글자) 조건이 없는 것과 같다", async () => {
    await render({ from_kst: "", to_kst: "", service: "", level: "", request_id: "", q: "", limit: "" });
    expect(observeParams()).toEqual({ limit: "100" });
  });
});

describe("로그 조회 화면 — 결과", () => {
  it("표 머리글 · 시각은 KST(밀리초까지, 원본 UTC 는 title) · 서비스 · 건수 · 조회 범위(KST)", async () => {
    const html = await render();
    for (const header of ["시각(KST)", "서비스", "수준", "요청 ID", "메시지"]) expect(html).toContain(`<th scope="col">${header}</th>`);
    expect(html).toContain("2026-11-22 10:00:00.123");
    expect(html).toContain('title="UTC 2026-11-22T01:00:00.123Z"');
    expect(html).toContain("2026-11-22 09:59:59.000");
    for (const service of ["backend", "llm", "front", "admin"]) expect(html).toContain(`<td>${service}</td>`);
    expect(html).toContain("4건");
    expect(html).toMatch(/조회 범위\(KST\) <time[^>]*>2026-11-22 09:00:00\.250<\/time> ~ <time[^>]*>2026-11-22 10:00:00\.750<\/time>/);
  });

  it("최신순 그대로(관측 서버가 준 순서)", async () => {
    const html = await render();
    const positions = ["10:00:00.123", "09:59:59.000", "09:59:58.000", "09:59:57.000"].map((time) => html.indexOf(time));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it("수준은 색만이 아니라 낱말과 기호로도 — error · warning · info · debug", async () => {
    const html = await render();
    for (const [level, mark] of [["error", "✕"], ["warning", "!"], ["info", "i"], ["debug", "·"]]) {
      expect(html).toMatch(new RegExp(`<span class="[^"]*level[^"]*"><span aria-hidden="true"[^>]*>${mark}</span>${level}</span>`));
    }
  });

  it("요청 ID 를 누르면 그 요청 ID 와 지금 조회 범위로 다시 조회(서비스 · 수준 · 낱말 · 커서는 뺀다) · 빈 요청 ID 는 링크 없음", async () => {
    const html = await render({ service: "backend", level: "error", q: "실패", limit: "50" });
    expect(paramsOf(hrefOf(html, /title="req-flow-0001-abcd"/))).toEqual({
      request_id: "req-flow-0001-abcd", from: RANGE.from, to: RANGE.to, limit: "50",
    });
    expect(html).toContain(">req-flow<");   // 앞 8자
    expect(html).toContain('aria-label="요청 ID req-flow-0001-abcd 의 로그만 보기"');
    expect(html).not.toMatch(/href="[^"]*request_id=&/);
  });

  it("더 보기 — 같은 조건 + 응답의 from · to + before = next_before (조건을 잃지 않는다)", async () => {
    handler = () => logBody(ROWS, "1763773197000-0");
    const html = await render({ service: "backend", level: "error", request_id: "req-flow-0001-abcd", q: "실패 a&b", limit: "4" });
    expect(paramsOf(hrefOf(html, /더 보기/))).toEqual({
      service: "backend", level: "error", request_id: "req-flow-0001-abcd", q: "실패 a&b", limit: "4",
      from: RANGE.from, to: RANGE.to, before: "1763773197000-0",
    });
  });

  it("더 보기 주소로 열면 관측 서버에 커서와 앞 응답의 범위를 그대로 보내고, '최신부터' 링크는 커서만 뺀다", async () => {
    handler = () => logBody(ROWS, "1763773100000-0");
    const html = await render({ service: "backend", from: RANGE.from, to: RANGE.to, before: "1763773197000-0" });
    expect(observeParams()).toEqual({ service: "backend", from: RANGE.from, to: RANGE.to, before: "1763773197000-0", limit: "100" });
    expect(html).toContain("이어 보기 중");
    expect(paramsOf(hrefOf(html, /이 범위의 최신부터 보기/))).toEqual({ service: "backend", from: RANGE.from, to: RANGE.to });
    expect(paramsOf(hrefOf(html, /더 보기/))).toEqual({ service: "backend", from: RANGE.from, to: RANGE.to, before: "1763773100000-0" });
  });

  it("next_before 가 비면 더 보기 없이 '끝까지'", async () => {
    const html = await render();
    expect(html).not.toContain("더 보기");
    expect(html).toContain("이 범위의 로그를 끝까지 보았습니다.");
  });

  it("0건 → '조건에 맞는 로그가 없습니다', 표 없음", async () => {
    handler = () => logBody([]);
    const html = await render({ q: "없는말" });
    expect(html).toContain("조건에 맞는 로그가 없습니다");
    expect(html).not.toContain("<table");
    expect(html).toContain("0건");
  });
});

describe("로그 조회 화면 — 메시지는 글자 그대로", () => {
  it("<script> · 태그가 든 메시지는 이스케이프된 글자로 나온다(요소가 되지 않는다)", async () => {
    const html = await render();
    expect(html).toContain("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt; &lt;b&gt;굵게&lt;/b&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>굵게");
  });

  it("여러 줄 메시지 — 첫 줄 요약 + <details> 안에 전체(줄바꿈 그대로)", async () => {
    const html = await render();
    expect(html).toMatch(/<details[^>]*><summary[^>]*><span[^>]*>요청 처리 실패: 연결 거절<\/span><span[^>]*>3줄 · 전체 보기<\/span><\/summary>/);
    expect(html).toMatch(/<pre[^>]*>요청 처리 실패: 연결 거절\n {2}at Handler\.run \(handler\.ts:10\)\n {2}at main \(index\.ts:3\)<\/pre>/);
  });

  it("짧은 한 줄은 접지 않는다 · 긴 한 줄(160자 초과)은 접는다", async () => {
    handler = () => logBody([{ ...ROWS[3], message: "가".repeat(161) }, { ...ROWS[1] }]);
    const html = await render();
    expect(html).toContain("161자 · 전체 보기");
    expect(html).toMatch(/<td class="[^"]*"><span class="[^"]*">느린 응답 3\.2초<\/span><\/td>/);
  });
});

describe("로그 조회 화면 — 입력 오류 · 관측 서버 실패", () => {
  it("틀린 낱말(1자) → 폼 위에 어느 칸이 틀렸는지 · 그 칸에 aria-invalid · 값 유지 · 결과 없음 · 관측 서버를 부르지 않는다", async () => {
    const html = await render({ q: "a", service: "backend" });
    expect(html).toContain("조회 조건이 맞지 않습니다");
    expect(html).toContain("<strong>낱말</strong>");
    expect(html.indexOf("조회 조건이 맞지 않습니다")).toBeLessThan(html.indexOf("<form"));
    const textField = fieldTag(html, "q");
    for (const attribute of ['value="a"', 'aria-invalid="true"', 'aria-describedby="log-query-problem"']) expect(textField).toContain(attribute);
    expect(fieldTag(html, "service")).not.toContain("aria-invalid");
    expect(fieldTag(html, "service")).toContain('value="backend"');
    expect(html).not.toContain("<table");
    expect(html).not.toContain("조건에 맞는 로그가 없습니다");
    expect(html).not.toContain("조회 범위");
    expect(observeFetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ from_kst: "2026-11-22T25:00" }, "시작 시각", "from"],
    [{ to_kst: "어제" }, "끝 시각", "to"],
    [{ from_kst: "2026-11-22T09:00", from: "2026-11-22T00:00:00Z" }, "시작 시각", "from"],
    [{ from_kst: "2026-11-22T10:00", to_kst: "2026-11-22T09:00" }, "시작 시각", "from"],
    [{ level: "fatal" }, "수준", "level"],
    [{ request_id: "a b" }, "요청 ID", "request_id"],
    [{ service: "Back End" }, "서비스", "service"],
    [{ limit: "501" }, "건수", "limit"],
    [{ before: "1763773197000-0" }, "이어 보기 위치", "before"],
  ] as const)("%j → '%s' 칸 표시, 호출 없음", async (input, label, field) => {
    const html = await render(input as Record<string, string>);
    expect(html).toContain(`<strong>${label}</strong>`);
    const formName = { from: "from_kst", to: "to_kst", level: "level", request_id: "request_id", service: "service", limit: "limit", before: null }[field];
    if (formName !== null) expect(fieldTag(html, formName)).toContain('aria-invalid="true"');
    expect(html.match(/aria-invalid="true"/g)?.length ?? 0).toBe(formName === null ? 0 : 1);
    expect(observeFetch).not.toHaveBeenCalled();
  });

  it("관측 서버 연결 실패 → '로그를 불러오지 못했습니다 / 관측 서버: 닿지 않음', 예외 문구 · 주소 · 비밀값 없음, 폼은 그대로", async () => {
    handler = () => Promise.reject(leakyNetworkError());
    const html = await render({ service: "backend" });
    expect(html).toContain("로그를 불러오지 못했습니다");
    expect(html).toContain("관측 서버: 닿지 않음");
    expect(fieldTag(html, "service")).toContain('value="backend"');
    expect(html).not.toContain("<table");
    expectNoForbiddenText(html);
  });

  it("관측 서버 503 → 짧은 사유와 상태 코드만", async () => {
    handler = () => textResponse(leakyErrorBody(), 503);
    const html = await render();
    expect(html).toContain("관측 서버: 서버 일시 장애 · HTTP 503");
    expectNoForbiddenText(html);
  });

  it("정상 응답에도 비밀값 · 관측 서버 주소 · 응답의 다른 칸은 HTML 에 없다", async () => {
    expectNoForbiddenText(await render());
  });
});

describe("로그 조회 화면 — 세션 · 공통 틀", () => {
  it("세션이 없으면 로그인으로 — 관측 서버를 부르지 않는다", async () => {
    state.cookieValue = undefined;
    await expect(render({ q: "timeout" })).rejects.toThrow(/^redirect:.*\/login$/);
    expect(observeFetch).not.toHaveBeenCalled();
  });

  it("내비게이션 — 로그 조회가 현재 화면", async () => {
    const html = await render();
    expect(html).toMatch(/href="\/logs" aria-current="page"[^>]*>로그 조회</);
    expect(html).toMatch(/href="\/deploys"[^>]*>배포 이력</);
  });

  it("임시 제한 중이면 로그 조회 화면에도 표시", async () => {
    state.restricted = true;
    expect(await render()).toContain("임시 제한 중");
    state.restricted = false;
    expect(await render()).not.toContain("임시 제한 중");
  });
});
