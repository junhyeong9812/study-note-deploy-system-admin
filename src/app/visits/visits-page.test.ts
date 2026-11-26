/** 방문 기록 화면 — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 관측 서버)를 거쳐 명세 §1(날짜별 조회 수 · 하루 순방문자 · 많이 본 글 · 들어온 곳 ·
 * 봇 비율) · §2(주소 원문은 어드민 화면에 없다) · §13(경로의 %20 · %25 는 보일 때 푼다) · §14(자기 사이트를 뺀다 · 누구나 올릴 수 있는 글자)를 본다.
 * 표로 읽힌다(막대는 꾸밈 — aria-hidden) · 읽지 못함은 0 이 아니다 · 빈 상태 · 기간 링크 셋(스크립트 없이) · 내비게이션 · 로그인. */
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

import VisitsPage from "@/app/visits/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  FAKE_SITE_HOST, FAKE_SITE_ORIGIN, LEAKED_VALUES, createFakeObserveVisits, observeDay, observeEmptySummary, observeEnvelope, observeLeakySummary, observeSummary, seoulDates,
  type FakeObserveVisits,
} from "@/features/visits/lib/visit-summary-test-fakes";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, createRoutedFetch, expectNoForbiddenText, jsonBody, leakyErrorBody, leakyNetworkError, textResponse,
} from "@/shared/lib/upstream-test-fakes";

let fake: FakeObserveVisits;
const upstreamFetch = createRoutedFetch((url, init) => {
  if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected upstream ${url.hostname}`);
  return fake.handler(url, init);
});

function answer(data: unknown) {
  fake.summary = () => jsonBody(observeEnvelope(data));
}

async function render(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const element = await VisitsPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ""));
}

/** 제목(caption)으로 표 하나를 찾아 thead · tbody · tfoot 의 칸 글자(th · td)를 줄마다 */
function table(html: string, caption: string) {
  const match = new RegExp(`<table[^>]*>\\s*<caption[^>]*>([\\s\\S]*?)</caption>([\\s\\S]*?)</table>`, "g");
  for (const found of html.matchAll(match)) {
    if (textOf(found[1]).trim() !== caption) continue;
    const part = (name: string) => {
      const section = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(found[2]);
      if (section === null) return [];
      return [...section[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => textOf(cell[1]).trim()));
    };
    return { html: found[0], head: part("thead"), body: part("tbody"), foot: part("tfoot") };
  }
  throw new Error(`"${caption}" 표가 없다 — 제목들: ${[...html.matchAll(/<caption[^>]*>([\s\S]*?)<\/caption>/g)].map((found) => textOf(found[1])).join(" | ")}`);
}

const DAILY = "날짜별 조회 수 · 순방문자";
const PATHS = "많이 본 경로 상위 10 (봇 제외)";
const REFERRERS = "들어온 곳 상위 10 (봇 제외)";
const DEVICES = "기기별 조회 수";

/** 정의 목록의 값(dt 이름 → dd 글) */
function definition(html: string, label: string): string {
  const match = new RegExp(`<dt[^>]*>${label}</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`).exec(html);
  expect(match, `${label} 칸이 없다`).not.toBeNull();
  return textOf(match![1]).trim();
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("SITE_ORIGIN", FAKE_SITE_ORIGIN);
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  fake = createFakeObserveVisits();
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

describe("틀 — 제목 · 안내 · 기간 링크 셋", () => {
  it("제목과 방문자가 보낸 값이라는 안내 한 줄", async () => {
    const html = await render();
    expect(html).toContain(">방문 기록</h1>");
    expect(textOf(html)).toContain("경로와 들어온 곳은 방문자가 보낸 값입니다 — 사이트에 없는 글도 올라올 수 있습니다.");
  });

  it("기간 링크 셋 — 스크립트 없이 ?days=, 고른 것은 aria-current 와 '(고름)'", async () => {
    const html = await render({ days: "30" });
    const nav = /<nav aria-label="기간">([\s\S]*?)<\/nav>/.exec(html);
    expect(nav, "기간 nav 가 없다").not.toBeNull();
    const links = [...nav![1].matchAll(/<a[^>]*href="([^"]*)"([^>]*)>([^<]*)/g)].map((match) => [decodeEntities(match[1]), /aria-current="page"/.test(match[0]), match[3]]);
    expect(links).toEqual([["/visits?days=7", false, "7일"], ["/visits?days=30", true, "30일"], ["/visits?days=90", false, "90일"]]);
    expect(textOf(nav![1])).toContain("30일 (고름)");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<form/i);
  });

  it("주소 입력이 틀리면 7일(거절하지 않는다)", async () => {
    const html = await render({ days: "365" });
    expect(html).toMatch(/href="\/visits\?days=7"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/visits\?days=7"/);
    expect(fake.calls.map((call) => call.days)).toEqual(["7"]);
  });

  it("내비게이션에 '방문 기록' 하나 — 이 화면에서 aria-current", async () => {
    const html = await render();
    expect(html).toMatch(/href="\/visits" aria-current="page"[^>]*>방문 기록</);
    expect(html.match(/href="\/visits"/g)).toHaveLength(1);
    expect(html).toMatch(/<a[^>]*href="\/resources"[^>]*>서버 자원</);
  });

  it("세션이 없으면 /login(관측 서버를 부르지 않는다)", async () => {
    state.cookieValue = undefined;
    await expect(render()).rejects.toThrow("redirect:/login");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("날짜별 — 표 · 서울의 날 · 봇 제외/포함 · 합 · 천 단위", () => {
  it("날마다 한 줄(받은 날짜 글자 그대로, 오래된 날부터) · 칸 다섯", async () => {
    const daily = table(await render(), DAILY);
    expect(daily.head).toEqual([["날짜", "조회 수", "조회 수(봇 포함)", "순방문자", "순방문자(봇 포함)"]]);
    expect(daily.body.map((row) => row[0])).toEqual(seoulDates(7));
    expect(daily.body[5]).toEqual(["2026-11-25", "1,200", "1,500", "300", "320"]);
    expect(daily.body[6]).toEqual(["2026-11-26", "34", "40", "12", "14"]);
    expect(daily.body[0]).toEqual(["2026-11-20", "0", "0", "0", "0"]);   // 빈 날의 0 은 관측 서버가 준 0
  });

  it("기간의 합 — 조회 수만 더하고 순방문자는 더하지 않는다(—)", async () => {
    const daily = table(await render(), DAILY);
    expect(daily.foot).toEqual([["합", "1,234", "1,540", "—", "—"]]);
  });

  it("머리 칸은 scope=col", async () => {
    const daily = table(await render(), DAILY);
    expect([...daily.html.matchAll(/<thead[\s\S]*?<\/thead>/g)][0][0].match(/<th scope="col"/g)).toHaveLength(5);
  });

  it("90일이면 90줄", async () => {
    expect(table(await render({ days: "90" }), DAILY).body).toHaveLength(90);
  });

  it("큰 수는 천 단위 쉼표", async () => {
    const data = observeSummary();
    (data.daily as Record<string, unknown>[])[6] = observeDay("2026-11-26", { views: 1_234_567, views_with_bots: 2_000_000, visitors: 45_678, visitors_with_bots: 50_000 });
    answer(data);
    expect(table(await render(), DAILY).body[6]).toEqual(["2026-11-26", "1,234,567", "2,000,000", "45,678", "50,000"]);
  });
});

describe("많이 본 경로 — 풀어 보이고 · 사이트의 그 글로 링크", () => {
  it("받은 순서 · 풀어 보인 글자 · 조회 수", async () => {
    const paths = table(await render(), PATHS);
    expect(paths.head).toEqual([["경로", "조회 수"]]);
    expect(paths.body).toEqual([["/wiki/01-N으로 표현", "900"], ["/", "200"], ["/wiki/100% done", "100"], ["/search", "34"]]);
  });

  it("링크는 사이트 출처 + 받은 경로 그대로 · rel=noreferrer", async () => {
    const paths = table(await render(), PATHS);
    const anchors = [...paths.html.matchAll(/<a([^>]*)>([^<]*)<\/a>/g)].map((match) => ({
      href: decodeEntities(/href="([^"]*)"/.exec(match[1])?.[1] ?? ""), rel: /rel="([^"]*)"/.exec(match[1])?.[1] ?? "", text: decodeEntities(match[2]),
    }));
    expect(anchors.map((anchor) => [anchor.text, anchor.href])).toEqual([
      ["/wiki/01-N으로 표현", "https://www.example.com/wiki/01-N으로%20표현"], ["/", "https://www.example.com/"],
      ["/wiki/100% done", "https://www.example.com/wiki/100%25%20done"], ["/search", "https://www.example.com/search"],
    ]);
    for (const anchor of anchors) expect(anchor.rel.split(/\s+/)).toContain("noreferrer");
  });

  it("SITE_ORIGIN 이 없으면 링크 없이 글자만", async () => {
    vi.stubEnv("SITE_ORIGIN", "");
    const paths = table(await render(), PATHS);
    expect(paths.html).not.toMatch(/<a\b/);
    expect(paths.body.map((row) => row[0])).toEqual(["/wiki/01-N으로 표현", "/", "/wiki/100% done", "/search"]);
  });

  it("//host · javascript: 꼴은 링크가 되지 않는다 — 글자만", async () => {
    answer(observeSummary({ top_paths: { items: [
      { path: "//evil.example.net/x", views: 3 }, { path: "javascript:alert(1)", views: 2 }, { path: "/\\evil.example.net", views: 1 },
    ], truncated: false } }));
    const paths = table(await render(), PATHS);
    expect(paths.html).not.toMatch(/<a\b/);
    expect(paths.body.map((row) => row[0])).toEqual(["//evil.example.net/x", "javascript:alert(1)", "/\\evil.example.net"]);
    const html = await render();
    expect(html).not.toMatch(/href="\/\/|href="javascript:|href="\/\\/i);
  });

  it("더 있으면 '더 있음'", async () => {
    answer(observeSummary({ top_paths: { items: Array.from({ length: 10 }, (_, index) => ({ path: `/wiki/p${index}`, views: 10 - index })), truncated: true } }));
    const html = await render();
    expect(table(html, PATHS).body).toHaveLength(10);
    expect(textOf(html)).toContain("더 있음 — 상위 10개만 보입니다");
  });
});

describe("들어온 곳 — 직접 · 자기 사이트 빼기", () => {
  it("직접 = '직접' · 자기 사이트는 목록에서 빼고 따로 한 줄", async () => {
    const html = await render();
    const referrers = table(html, REFERRERS);
    expect(referrers.head).toEqual([["들어온 곳", "조회 수"]]);
    expect(referrers.body).toEqual([["직접", "800"], ["www.google.com", "134"]]);
    expect(textOf(html)).toContain("사이트 안 이동 300 (목록에서 뺌)");
    expect(referrers.html).not.toContain(FAKE_SITE_HOST);
  });

  it("상위 10 에서 하나를 빼면 9줄(메우지 않는다)", async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ host: index === 0 ? FAKE_SITE_HOST : `r${index}.example.net`, views: 5_000 - index }));
    answer(observeSummary({ top_referrers: { items, truncated: true } }));
    const html = await render();
    expect(table(html, REFERRERS).body).toHaveLength(9);
    expect(textOf(html)).toContain("사이트 안 이동 5,000 (목록에서 뺌)");
  });

  it("받은 목록에 자기 사이트가 없으면 그렇다고", async () => {
    answer(observeSummary({ top_referrers: { items: [{ host: null, views: 1 }], truncated: false } }));
    expect(textOf(await render())).toContain("사이트 안 이동: 받은 상위 10개에 없음");
  });

  it("SITE_ORIGIN 이 없으면 빼지 않고 그대로 — 그렇다고 글로", async () => {
    vi.stubEnv("SITE_ORIGIN", "");
    const html = await render();
    expect(table(html, REFERRERS).body).toEqual([["직접", "800"], [FAKE_SITE_HOST, "300"], ["www.google.com", "134"]]);
    expect(textOf(html)).toContain("사이트 주소 설정(SITE_ORIGIN)이 없어 사이트 안 이동을 빼지 않았습니다");
    expect(textOf(html)).not.toContain("목록에서 뺌");
  });

  it("들어온 곳은 링크가 아니다(주소 꼴 · 호스트 모두 글자만)", async () => {
    answer(observeSummary({ top_referrers: { items: [{ host: "203.0.113.7", views: 2 }, { host: "www.google.com", views: 1 }], truncated: false } }));
    const referrers = table(await render(), REFERRERS);
    expect(referrers.html).not.toMatch(/<a\b/);
    expect(referrers.body.map((row) => row[0])).toEqual(["203.0.113.7", "www.google.com"]);
  });
});

describe("기기 · 봇 비율", () => {
  it("기기별 수와 봇 비율(소수 한 자리)", async () => {
    const html = await render();
    expect(table(html, DEVICES).body).toEqual([["데스크톱", "1,000"], ["모바일", "234"], ["봇", "306"]]);
    expect(definition(html, "봇 비율")).toBe("19.9%");
  });

  it("방문이 있고 봇이 0 이면 0.0%", async () => {
    answer(observeSummary({ devices: { desktop: 3, mobile: 1, bot: 0 }, bot_ratio: 0 }));
    expect(definition(await render(), "봇 비율")).toBe("0.0%");
  });
});

describe("빈 상태 — 모든 날이 0", () => {
  it("'아직 방문 기록이 없습니다' · 날짜별 0 은 그대로 · 상위 목록은 '기록 없음' · 봇 비율 — (0% 가 아니다)", async () => {
    answer(observeEmptySummary());
    const html = await render();
    expect(textOf(html)).toContain("아직 방문 기록이 없습니다");
    expect(table(html, DAILY).body.every((row) => row.slice(1).every((cell) => cell === "0"))).toBe(true);
    expect(textOf(table(html, PATHS).html)).toContain("기록 없음");
    expect(textOf(table(html, REFERRERS).html)).toContain("기록 없음");
    expect(definition(html, "봇 비율")).toBe("—");
    expect(html).not.toContain("0.0%");
  });

  it("방문이 있으면 빈 상태 글이 없다", async () => {
    expect(textOf(await render())).not.toContain("아직 방문 기록이 없습니다");
  });
});

describe("읽지 못함 — '확인하지 못함'이지 0 이 아니다", () => {
  it("꼴이 틀리면 해석 불가 — 표 · 0 · 빈 상태 글 · 봇 비율 없음, 틀(제목 · 안내 · 기간)은 그대로", async () => {
    const broken = observeSummary();
    (broken.daily as Record<string, unknown>[])[6] = { ...(broken.daily as Record<string, unknown>[])[6], views: "34" };
    answer(broken);
    const html = await render();
    expect(textOf(html)).toContain("방문 요약: 확인하지 못함 — 관측 서버: 해석 불가");
    expect(html).not.toMatch(/<table/);
    expect(textOf(html)).not.toContain("아직 방문 기록이 없습니다");
    expect(html).not.toContain("봇 비율");
    expect(html).not.toMatch(/<dd/);
    expect(textOf(html)).not.toMatch(/사이트 안 이동/);
    expect(html).toContain(">방문 기록</h1>");
    expect(html).toContain('aria-label="기간"');
  });

  it.each([
    ["503", () => textResponse(leakyErrorBody(), 503), "서버 일시 장애 · HTTP 503"],
    ["504", () => textResponse(leakyErrorBody(), 504), "서버 조회 시간 초과 · HTTP 504"],
    ["401", () => textResponse(leakyErrorBody(), 401), "비밀값 거절됨 · HTTP 401"],
    ["422", () => textResponse(leakyErrorBody(), 422), "요청 조건 거절됨 · HTTP 422"],
  ] as const)("관측 서버 %s → 고정 글과 HTTP 상태만", async (_label, respond, text) => {
    fake.summary = () => respond();
    const html = await render();
    expect(textOf(html)).toContain(`방문 요약: 확인하지 못함 — 관측 서버: ${text}`);
    expect(html).not.toMatch(/<table/);
    expectNoForbiddenText(html);
  });

  it("닿지 않음", async () => {
    fake.handler = () => Promise.reject(leakyNetworkError());
    const html = await render();
    expect(textOf(html)).toContain("방문 요약: 확인하지 못함 — 관측 서버: 닿지 않음");
    expectNoForbiddenText(html);
  });
});

describe("누구나 올릴 수 있는 글자 — 화면은 글자로만", () => {
  it("태그 · 속성 주입은 HTML 로 해석되지 않는다(경로 · 들어온 곳)", async () => {
    answer(observeSummary({
      top_paths: { items: [
        { path: "/wiki/<img src=x onerror=alert(1)>", views: 3 }, { path: "/wiki/x\" onmouseover=\"alert(1)", views: 2 }, { path: "/wiki/a&b", views: 1 },
      ], truncated: false },
      top_referrers: { items: [{ host: "<b>evil</b>.example.net", views: 2 }, { host: "x\" onclick=\"alert(1)", views: 1 }], truncated: false },
    }));
    const html = await render();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(html).not.toMatch(/\sonmouseover="alert/);
    expect(html).not.toMatch(/\sonclick="alert/);
    expect(html).toContain("a&amp;b");
    expect(html).not.toContain("&amp;amp;");   // 두 번 이스케이프하지 않는다
    expect(table(html, PATHS).body.map((row) => row[0])).toEqual(["/wiki/<img src=x onerror=alert(1)>", "/wiki/x\" onmouseover=\"alert(1)", "/wiki/a&b"]);
  });

  it("아주 긴 값은 잘라 '…' — 링크는 받은 경로 그대로", async () => {
    const long = `/wiki/${"가".repeat(500)}`;
    answer(observeSummary({ top_paths: { items: [{ path: long, views: 1 }], truncated: false }, top_referrers: { items: [{ host: `${"a".repeat(250)}.net`, views: 1 }], truncated: false } }));
    const html = await render();
    const pathCell = table(html, PATHS).body[0][0];
    expect(Array.from(pathCell)).toHaveLength(121);
    expect(pathCell.endsWith("…")).toBe(true);
    expect(decodeEntities(html)).toContain(`href="${FAKE_SITE_ORIGIN}${long}"`);
    expect(Array.from(table(html, REFERRERS).body[0][0])).toHaveLength(121);
  });

  it("방향 뒤집기 · 제어 문자는 보이게 바꾼다", async () => {
    answer(observeSummary({ top_paths: { items: [{ path: "/wiki/a‮exe.txt", views: 1 }], truncated: false }, top_referrers: { items: [{ host: "evil​.example.net", views: 1 }], truncated: false } }));
    const html = await render();
    expect(html).not.toMatch(/[‮​]/);
    expect(table(html, PATHS).body[0][0]).toBe("/wiki/a�exe.txt");
    expect(table(html, REFERRERS).body[0][0]).toBe("evil�.example.net");
  });

  it("주소 꼴 · 메일 주소 꼴은 글자로만 — mailto · 그 주소로 가는 링크 없음", async () => {
    answer(observeSummary({
      top_paths: { items: [{ path: "/wiki/203.0.113.7", views: 2 }, { path: "/wiki/someone@example.com", views: 1 }], truncated: false },
      top_referrers: { items: [{ host: "203.0.113.8", views: 1 }], truncated: false },
    }));
    const html = await render();
    expect(textOf(html)).toContain("/wiki/someone@example.com");
    expect(html).not.toMatch(/mailto:/i);
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
      const target = decodeEntities(href);
      expect(target.startsWith("/") && !target.startsWith("//") || target.startsWith(`${FAKE_SITE_ORIGIN}/`), target).toBe(true);
    }
  });
});

describe("HTML 에 없는 것 — 주소 · 구분값 · 비밀값 · 스크립트", () => {
  it("관측 서버가 ip · visitor 를 실어도 HTML 에 없다", async () => {
    answer(observeLeakySummary());
    const html = await render();
    expectNoForbiddenText(html, LEAKED_VALUES);
    expectNoForbiddenText(html);
    expect(html).not.toMatch(/<script/i);
  });

  it("막대는 꾸밈 — style 을 단 요소는 모두 aria-hidden", async () => {
    const html = await render({ days: "30" });
    for (const [tag] of html.matchAll(/<[a-z]+\b[^>]*\sstyle="[^"]*"[^>]*>/g)) expect(tag).toContain('aria-hidden="true"');
  });

  it("모든 수가 글자로 있다(막대 · 색에만 기대지 않는다)", async () => {
    const html = await render();
    for (const value of ["1,200", "1,500", "900", "800", "1,000", "234", "306", "19.9%"]) expect(textOf(html)).toContain(value);
  });
});
