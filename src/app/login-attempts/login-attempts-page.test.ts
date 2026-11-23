/** 로그인 시도 기록 화면 — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 관측 서버 — /auth/attempts · /auth/lock)를 거쳐
 * 폼 칸과 현재 값 유지 · 잠금 상태(잠김 · 잠기지 않음 · 확인 못 함) · 결과 낱말 전부(색 + 기호 + 글자) · IP · User-Agent(줄임 + 전체) · 나중에 보낸 기록 ·
 * 더 보기(조건 유지 + 커서) · 0건 · 입력 오류 · 관측 서버 실패(목록 · 잠금 따로) · 글자 그대로 · 세션 없음 · 임시 제한 표시 · 내비게이션을 본다.
 * 비밀값 · 관측 서버 주소 · 원문은 HTML 에 없다. IP 는 문서용 대역만 쓴다. */
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

import LoginAttemptsPage from "@/app/login-attempts/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, UPSTREAM_RAW_MARKER, createRoutedFetch, expectNoForbiddenText, headersOf, jsonBody, leakyErrorBody,
  leakyNetworkError, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const RANGE = { from: "2026-08-24T12:00:00Z", to: "2026-11-22T12:00:00Z" };
const CURSOR = "2026-11-22T09:00:00Z_6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";
const LONG_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 tail-marker-q7";

type Row = { id: string; at: string; outcome: string; ip: string; user_agent: string; replayed: boolean };

const ROWS: Row[] = [
  { id: "0f8fad5b-d9cb-469f-a165-70867728950e", at: "2026-11-22T10:05:00Z", outcome: "success", ip: "203.0.113.9", user_agent: "curl/8.5.0", replayed: false },
  { id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", at: "2026-11-22T10:04:00Z", outcome: "failure", ip: "203.0.113.10", user_agent: LONG_USER_AGENT, replayed: false },
  { id: "2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", at: "2026-11-22T10:03:00Z", outcome: "locked", ip: "2001:db8::1", user_agent: "", replayed: true },
  { id: "3d9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", at: "2026-11-22T10:02:00Z", outcome: "rate_limited", ip: "203.0.113.11", user_agent: "<script>alert('ua')</script>", replayed: false },
  { id: "4e9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", at: "2026-11-22T10:01:00Z", outcome: "origin_rejected", ip: "<b>203.0.113.12</b>", user_agent: "x", replayed: false },
  { id: "5f9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", at: "2026-11-22T10:00:00Z", outcome: "malformed", ip: "203.0.113.13", user_agent: "y", replayed: false },
];

function attemptsBody(rows: Row[] = ROWS, nextBefore = "", range = RANGE) {
  return jsonBody({ success: true, data: { attempts: rows, next_before: nextBefore, ...range, extra: UPSTREAM_RAW_MARKER } });
}

function lockBody(locked = false, lockedUntil: string | null = null, failures = 2) {
  return jsonBody({ success: true, data: { locked, locked_until: lockedUntil, failures, extra: UPSTREAM_RAW_MARKER } });
}

let attemptsHandler: RoutedFetchHandler = () => attemptsBody();
let lockHandler: RoutedFetchHandler = () => lockBody();
const observeFetch = createRoutedFetch((url, init) => {
  if (url.pathname === "/auth/attempts") return attemptsHandler(url, init);
  if (url.pathname === "/auth/lock") return lockHandler(url, init);
  throw new Error(`unexpected path ${url.pathname}`);
});

async function render(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const element = await LoginAttemptsPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function decodeAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function hrefOf(html: string, pattern: RegExp): string {
  const match = new RegExp(`<a[^>]*href="([^"]*)"[^>]*>${pattern.source}`).exec(html);
  expect(match, `${pattern} 링크가 없다`).not.toBeNull();
  return decodeAttribute(match![1]);
}

function paramsOf(href: string): Record<string, string> {
  const url = new URL(href, FAKE_ORIGIN);
  expect(url.pathname).toBe("/login-attempts");
  return Object.fromEntries(url.searchParams);
}

function fieldTag(html: string, name: string): string {
  const match = new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`).exec(html);
  expect(match, `폼 칸 ${name} 이 없다`).not.toBeNull();
  return match![0];
}

/** 잠금 상태 구역(section) 안의 글자(태그 제거). */
function lockSectionText(html: string): string {
  const match = /<section[^>]*aria-labelledby="login-lock-heading"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  expect(match, "잠금 상태 구역이 없다").not.toBeNull();
  return match![1].replace(/<[^>]+>/g, "");
}

function attemptCalls() {
  return observeFetch.mock.calls.filter(([input]) => new URL(input).pathname === "/auth/attempts");
}

function attemptParams(): Record<string, string> {
  const calls = attemptCalls();
  expect(calls.length).toBe(1);
  return Object.fromEntries(new URL(calls[0][0]).searchParams);
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
  attemptsHandler = () => attemptsBody();
  lockHandler = () => lockBody();
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

describe("로그인 시도 기록 화면 — 폼", () => {
  it("GET 폼 · 칸마다 label(for = id) · 기간(KST) · 건수 · 브라우저 스크립트 없음", async () => {
    const html = await render();
    const formTag = /<form\b[^>]*>/.exec(html)?.[0] ?? "";
    expect(formTag).toContain('method="get"');
    expect(formTag).toContain('action="/login-attempts"');
    for (const [id, name] of [["attempt-from", "from_kst"], ["attempt-to", "to_kst"], ["attempt-limit", "limit"]]) {
      expect(html).toContain(`for="${id}"`);
      expect(fieldTag(html, name)).toContain(`id="${id}"`);
    }
    expect(fieldTag(html, "from_kst")).toContain('type="datetime-local"');
    expect(fieldTag(html, "to_kst")).toContain('type="datetime-local"');
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+="/i);
  });

  it("KST 시각 칸은 UTC 로 바꿔 관측 서버에 보내고, 주소의 값을 폼에 다시 채운다", async () => {
    const html = await render({ from_kst: "2026-11-22T09:00", to_kst: "2026-11-22T10:30:15", limit: "20" });
    expect(attemptParams()).toEqual({ from: "2026-11-22T00:00:00Z", to: "2026-11-22T01:30:15Z", limit: "20" });
    expect(headersOf(attemptCalls()[0][1]).get("X-Observe-Secret")).toBe(FAKE_OBSERVE_SECRET);
    expect(fieldTag(html, "from_kst")).toContain('value="2026-11-22T09:00"');
    expect(fieldTag(html, "to_kst")).toContain('value="2026-11-22T10:30:15"');
    expect(fieldTag(html, "limit")).toContain('value="20"');
  });

  it("빈 칸으로 제출하면 조건 없음(건수 50)", async () => {
    await render({ from_kst: "", to_kst: "", limit: "" });
    expect(attemptParams()).toEqual({ limit: "50" });
  });
});

describe("로그인 시도 기록 화면 — 현재 잠금 상태", () => {
  it("잠기지 않음 → 연속 실패 횟수와 잠금까지 남은 횟수", async () => {
    const text = lockSectionText(await render());
    expect(text).toContain("현재 잠금 상태");
    expect(text).toContain("✓잠기지 않음");
    expect(text).toContain("연속 실패 2회");
    expect(text).toContain("3회 더 실패하면 15분 잠금");
  });

  it("잠김 → 풀리는 시각(KST) · 연속 실패 횟수", async () => {
    lockHandler = () => lockBody(true, "2026-11-22T10:15:00Z", 5);
    const html = await render();
    const text = lockSectionText(html);
    expect(text).toContain("!잠김");
    expect(text).toContain("풀리는 시각(KST) 2026-11-22 19:15:00");
    expect(text).toContain("연속 실패 5회");
    expect(html).toContain('title="UTC 2026-11-22T10:15:00Z"');
  });

  it("잠금 조회만 실패 → 그 자리만 '확인 못 함', 목록은 그대로", async () => {
    lockHandler = () => textResponse(leakyErrorBody(), 503);
    const html = await render();
    const text = lockSectionText(html);
    expect(text).toContain("?확인 못 함");
    expect(text).toContain("관측 서버: 서버 일시 장애 · HTTP 503");
    expect(html).toContain("<table");
    expect(html).toContain("6건");
    expect(html).not.toContain("로그인 시도 기록을 불러오지 못했습니다");
    expectNoForbiddenText(html);
  });

  it("목록만 실패 → 목록 자리에 실패 상자, 잠금 상태는 그대로", async () => {
    attemptsHandler = () => Promise.reject(leakyNetworkError());
    const html = await render();
    expect(html).toContain("로그인 시도 기록을 불러오지 못했습니다");
    expect(html).toContain("관측 서버: 닿지 않음");
    expect(html).not.toContain("<table");
    expect(lockSectionText(html)).toContain("잠기지 않음");
    expectNoForbiddenText(html);
  });
});

describe("로그인 시도 기록 화면 — 목록", () => {
  it("표 머리글 · 시각은 KST(원본 UTC 는 title) · 건수 · 조회 범위(KST) · 관측 서버가 준 순서", async () => {
    const html = await render();
    for (const header of ["시각(KST)", "결과", "IP", "브라우저(User-Agent)", "전송"]) expect(html).toContain(`<th scope="col">${header}</th>`);
    expect(html).toContain("2026-11-22 19:05:00");
    expect(html).toContain('title="UTC 2026-11-22T10:05:00Z"');
    expect(html).toContain("6건");
    expect(html).toMatch(/조회 범위\(KST\) <time[^>]*>2026-08-24 21:00:00<\/time> ~ <time[^>]*>2026-11-22 21:00:00<\/time>/);
    const positions = ["19:05:00", "19:04:00", "19:03:00", "19:02:00", "19:01:00", "19:00:00"].map((time) => html.indexOf(`2026-11-22 ${time}`));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it("결과 낱말 전부 — 색만이 아니라 기호와 글자로도, 뜻은 title", async () => {
    const html = await render();
    for (const [mark, label] of [["✓", "성공"], ["✕", "실패"], ["!", "잠금 중 거절"], ["⊘", "거절 · 속도 제한"], ["⊘", "거절 · 출처 다름"], ["⊘", "거절 · 형식 오류"]]) {
      expect(html).toMatch(new RegExp(`<span class="[^"]*" title="[^"]+"><span aria-hidden="true"[^>]*>${mark}</span>${label}</span>`));
    }
  });

  it("나중에 보낸 기록(replayed) 표시 — 그 줄에만", async () => {
    const html = await render();
    expect(html.match(/↻<\/span>나중에 보낸 기록/g)?.length).toBe(1);
    const lockedRow = /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*잠금 중 거절(?:(?!<\/tr>)[\s\S])*<\/tr>/.exec(html)?.[0] ?? "";
    expect(lockedRow).toContain("나중에 보낸 기록");
  });

  it("IP · User-Agent 는 글자 그대로(태그가 요소가 되지 않는다) · IPv6 그대로", async () => {
    const html = await render();
    expect(html).toContain("&lt;script&gt;alert(&#x27;ua&#x27;)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;203.0.113.12&lt;/b&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>203");
    expect(html).toContain(">2001:db8::1<");
  });

  it("긴 User-Agent 는 앞부분 + '전체 보기'(<details> 안에 전체) · 짧은 것은 접지 않는다 · 빈 것은 —", async () => {
    const html = await render();
    expect(html).toMatch(/<details[^>]*><summary[^>]*><span[^>]*>Mozilla\/5\.0 [^<]*…<\/span><span[^>]*>전체 보기<\/span><\/summary>/);
    expect(html).toMatch(/<p[^>]*>Mozilla\/5\.0 [^<]*tail-marker-q7<\/p><\/details>/);
    expect(html.match(/<details/g)?.length).toBe(1);
    expect(html).toMatch(/<span class="[^"]*">curl\/8\.5\.0<\/span>/);
  });

  it("더 보기 — 같은 건수 + 응답의 from · to + before = next_before", async () => {
    attemptsHandler = () => attemptsBody(ROWS, CURSOR);
    const html = await render({ limit: "6" });
    expect(paramsOf(hrefOf(html, /더 보기/))).toEqual({ from: RANGE.from, to: RANGE.to, before: CURSOR, limit: "6" });
    expect(html).not.toContain("끝까지 보았습니다");
  });

  it("더 보기 주소로 열면 관측 서버에 커서와 범위를 그대로 보내고, '최신부터' 링크는 커서만 뺀다", async () => {
    attemptsHandler = () => attemptsBody(ROWS, "2026-11-22T08:00:00Z_6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b");
    const html = await render({ from: RANGE.from, to: RANGE.to, before: CURSOR });
    expect(attemptParams()).toEqual({ from: RANGE.from, to: RANGE.to, before: CURSOR, limit: "50" });
    expect(html).toContain("이어 보기 중");
    expect(paramsOf(hrefOf(html, /이 범위의 최신부터 보기/))).toEqual({ from: RANGE.from, to: RANGE.to });
  });

  it("next_before 가 비면 더 보기 없이 '끝까지'", async () => {
    const html = await render();
    expect(html).not.toContain("더 보기");
    expect(html).toContain("이 범위의 기록을 끝까지 보았습니다.");
  });

  it("0건 → 빈 상태, 표 없음", async () => {
    attemptsHandler = () => attemptsBody([]);
    const html = await render();
    expect(html).toContain("이 범위에 로그인 시도 기록이 없습니다.");
    expect(html).not.toContain("<table");
    expect(html).toContain("0건");
    expect(html).not.toContain("끝까지 보았습니다");
  });
});

describe("로그인 시도 기록 화면 — 입력 오류 · 관측 서버 실패", () => {
  it.each([
    [{ from_kst: "2026-11-22T25:00" }, "시작 시각", "from_kst"],
    [{ to_kst: "어제" }, "끝 시각", "to_kst"],
    [{ from_kst: "2026-11-22T10:00", to_kst: "2026-11-22T09:00" }, "시작 시각", "from_kst"],
    [{ from_kst: "2026-01-01T00:00", to_kst: "2026-11-22T00:00" }, "시작 시각", "from_kst"],
    [{ limit: "201" }, "건수", "limit"],
    [{ before: CURSOR }, "이어 보기 위치", null],
  ] as const)("%j → '%s' 안내 · 그 칸만 aria-invalid · 목록을 부르지 않는다 · 잠금 상태는 보인다", async (input, label, formName) => {
    const html = await render(input as Record<string, string>);
    expect(html).toContain("조회 조건이 맞지 않습니다");
    expect(html).toContain(`<strong>${label}</strong>`);
    expect(html.indexOf("조회 조건이 맞지 않습니다")).toBeLessThan(html.indexOf("<form"));
    if (formName !== null) {
      expect(fieldTag(html, formName)).toContain('aria-invalid="true"');
      expect(fieldTag(html, formName)).toContain('aria-describedby="login-attempts-query-problem"');
    }
    expect(html.match(/aria-invalid="true"/g)?.length ?? 0).toBe(formName === null ? 0 : 1);
    expect(attemptCalls()).toHaveLength(0);
    expect(html).not.toContain("<table");
    expect(lockSectionText(html)).toContain("잠기지 않음");
  });

  it("관측 서버 503 → 짧은 사유와 상태 코드만, 원문 · 비밀값 · 주소 없음", async () => {
    attemptsHandler = () => textResponse(leakyErrorBody(), 503);
    lockHandler = () => textResponse(leakyErrorBody(), 503);
    const html = await render();
    expect(html).toContain("관측 서버: 서버 일시 장애 · HTTP 503");
    expect(lockSectionText(html)).toContain("확인 못 함");
    expectNoForbiddenText(html);
  });

  it("정상 응답에도 비밀값 · 관측 서버 주소 · 응답의 다른 칸은 HTML 에 없다", async () => {
    expectNoForbiddenText(await render());
  });
});

describe("로그인 시도 기록 화면 — 세션 · 공통 틀", () => {
  it("세션이 없으면 로그인으로 — 관측 서버를 부르지 않는다", async () => {
    state.cookieValue = undefined;
    await expect(render()).rejects.toThrow(/^redirect:.*\/login$/);
    expect(observeFetch).not.toHaveBeenCalled();
  });

  it("내비게이션 — 로그인 시도 기록이 현재 화면, '준비 중' 없음", async () => {
    const html = await render();
    expect(html).toMatch(/href="\/login-attempts" aria-current="page"[^>]*>로그인 시도 기록</);
    expect(html).toMatch(/href="\/logs"[^>]*>로그 조회</);
    expect(html).not.toContain("준비 중");
  });

  it("임시 제한 중이면 이 화면에도 표시", async () => {
    state.restricted = true;
    expect(await render()).toContain("임시 제한 중");
    state.restricted = false;
    expect(await render()).not.toContain("임시 제한 중");
  });
});
