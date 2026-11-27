/** 방문 기록 화면의 데이터 — 명세 §1 "날짜별 조회 수 · 하루 순방문자 · 많이 본 글 · 들어온 곳 · 봇 비율" · §2 "주소 원문은 … 어드민 화면의 목록 · 요약 응답에는 싣지 않는다" ·
 * §14 "V5 에 넘김: 클라이언트 이동의 referrer_host 는 자기 사이트다 — '들어온 곳' 상위 목록에서 자기 호스트를 뺀다 / 누구나 … 아무 글을 상위 목록에 올릴 수 있다".
 * 읽지 못한 것은 "확인하지 못함"(실패 결과)이지 0 이 아니다 · 빈 날의 0 은 관측 서버가 준 0 · 봇 비율의 분모가 0 이면 null("—"). */
import { describe, expect, it } from "vitest";
import { VISITS_TEXT, collectVisitsScreen, visitsScreenFailures, type VisitsScreen } from "@/features/visits/lib/visits-screen";
import {
  FAKE_SITE_HOST, FAKE_SITE_ORIGIN, LEAKED_VALUES, createFakeObserveVisits, observeDay, observeEmptySummary, observeEnvelope, observeLeakySummary, observeSummary, seoulDates,
} from "@/features/visits/lib/visit-summary-test-fakes";
import type { VisitDays } from "@/features/visits/lib/visits-query";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, createRoutedFetch, expectFailure, expectNoForbiddenText, jsonBody, leakyErrorBody, leakyNetworkError, okValue, textResponse,
} from "@/shared/lib/upstream-test-fakes";

type Handler = Parameters<typeof createRoutedFetch>[0];

async function collect(options: { handler?: Handler; data?: unknown; days?: VisitDays; siteOrigin?: string; observeUrl?: string; observeSecret?: string } = {}) {
  const days = options.days ?? 7;
  const fake = createFakeObserveVisits(options.data === undefined ? undefined : () => jsonBody(observeEnvelope(options.data)));
  const fetch = createRoutedFetch(options.handler ?? fake.handler);
  const screen = await collectVisitsScreen({
    observeUrl: options.observeUrl ?? FAKE_OBSERVE_URL, observeSecret: options.observeSecret ?? FAKE_OBSERVE_SECRET,
    siteOrigin: options.siteOrigin ?? FAKE_SITE_ORIGIN, fetch, query: { days },
  });
  return { screen, fetch, fake };
}

describe("기간 · 고르는 링크 · 안내", () => {
  it.each([7, 30, 90] as const)("days=%i — 관측 서버에 그 값으로, 링크 셋(고른 것 표시)", async (days) => {
    const { screen, fake } = await collect({ days });
    expect(fake.calls.map((call) => call.days)).toEqual([String(days)]);
    expect(screen.days).toBe(days);
    expect(screen.dayOptions).toEqual([
      { days: 7, label: "7일", href: "/visits?days=7", selected: days === 7 },
      { days: 30, label: "30일", href: "/visits?days=30", selected: days === 30 },
      { days: 90, label: "90일", href: "/visits?days=90", selected: days === 90 },
    ]);
    expect(okValue(screen.summary).daily).toHaveLength(days);
  });

  it("안내 글 — 방문자가 보낸 값이라는 것", async () => {
    const { screen } = await collect();
    expect(screen.notice).toBe("경로와 들어온 곳은 방문자가 보낸 값입니다 — 사이트에 없는 글도 올라올 수 있습니다.");
    expect(screen.notice).toBe(VISITS_TEXT.untrustedNotice);
  });
});

describe("요약 — 날짜별 · 합 · 빈 상태", () => {
  it("날짜별은 받은 줄 그대로(서울의 날 글자) · 합은 조회 수만(순방문자는 더하지 않는다)", async () => {
    const summary = okValue((await collect()).screen.summary);
    expect(summary.daily.map((day) => day.date)).toEqual(seoulDates(7));
    expect(summary.daily[5]).toEqual({ date: "2026-11-25", views: 1200, viewsWithBots: 1500, visitors: 300, visitorsWithBots: 320 });
    expect(summary.totals).toEqual({ views: 1234, viewsWithBots: 1540 });
    expect(summary.empty).toBe(false);
  });

  it("모든 날이 0 이면 empty — 날짜별 줄은 그대로(0 은 관측 서버가 준 0)", async () => {
    const summary = okValue((await collect({ data: observeEmptySummary() })).screen.summary);
    expect(summary.empty).toBe(true);
    expect(summary.daily).toHaveLength(7);
    expect(summary.totals).toEqual({ views: 0, viewsWithBots: 0 });
  });

  it("봇만 온 기간은 비어 있지 않다", async () => {
    const data = observeEmptySummary();
    (data.daily as Record<string, unknown>[])[6] = observeDay("2026-11-26", { views_with_bots: 5, visitors_with_bots: 1 });
    const summary = okValue((await collect({ data: { ...data, devices: { desktop: 0, mobile: 0, bot: 5 }, bot_ratio: 1 } })).screen.summary);
    expect(summary.empty).toBe(false);
    expect(summary.totals).toEqual({ views: 0, viewsWithBots: 5 });
    expect(summary.botRatio).toBe(1);
  });
});

describe("봇 비율 — 분모가 0 이면 null(0% 로 꾸미지 않는다)", () => {
  it("방문이 없으면(관측 서버는 0 을 준다) null", async () => {
    const summary = okValue((await collect({ data: observeEmptySummary() })).screen.summary);
    expect(summary.botRatio).toBeNull();
    expect(summary.devices).toEqual({ desktop: 0, mobile: 0, bot: 0 });
  });

  it("방문이 있고 봇이 0 이면 실제 0", async () => {
    const summary = okValue((await collect({ data: observeSummary({ devices: { desktop: 3, mobile: 1, bot: 0 }, bot_ratio: 0 }) })).screen.summary);
    expect(summary.botRatio).toBe(0);
  });

  it("그 밖은 받은 비율 그대로", async () => {
    expect(okValue((await collect()).screen.summary).botRatio).toBe(306 / 1540);
  });
});

describe("많이 본 경로 — 보일 글자 · 링크", () => {
  it("받은 순서 그대로, 풀어 보이고 링크는 받은 경로를 사이트 출처 뒤에", async () => {
    const summary = okValue((await collect()).screen.summary);
    expect(summary.topPaths).toEqual({ items: [
      { path: "/wiki/01-N으로%20표현", text: "/wiki/01-N으로 표현", href: "https://www.example.com/wiki/01-N으로%20표현", views: 900 },
      { path: "/", text: "/", href: "https://www.example.com/", views: 200 },
      { path: "/wiki/100%25%20done", text: "/wiki/100% done", href: "https://www.example.com/wiki/100%25%20done", views: 100 },
      { path: "/search", text: "/search", href: "https://www.example.com/search", views: 34 },
    ], truncated: false });
  });

  it("사이트 주소 설정이 없으면(빈 값 · 꼴이 틀림) 링크 없음 — 요약은 그대로", async () => {
    for (const siteOrigin of ["", "www.example.com", "https://www.example.com/"]) {
      const summary = okValue((await collect({ siteOrigin })).screen.summary);
      expect(summary.topPaths.items.map((item) => item.href)).toEqual([null, null, null, null]);
      expect(summary.topPaths.items.map((item) => item.text)).toEqual(["/wiki/01-N으로 표현", "/", "/wiki/100% done", "/search"]);
    }
  });

  it("링크가 될 수 없는 경로(//host · 역슬래시 · 제어 문자) — 글자만, 링크 없음", async () => {
    const items = [
      { path: "//evil.example.net/x", views: 3 }, { path: "/\\evil.example.net", views: 2 }, { path: "/wiki/a‮b", views: 1 },
    ];
    const summary = okValue((await collect({ data: observeSummary({ top_paths: { items, truncated: true } }) })).screen.summary);
    expect(summary.topPaths.items.map((item) => [item.text, item.href])).toEqual([
      ["//evil.example.net/x", null], ["/\\evil.example.net", null], ["/wiki/a�b", null],
    ]);
    expect(summary.topPaths.truncated).toBe(true);
  });

  it("깨진 % 가 든 경로도 던지지 않고 받은 글자 그대로", async () => {
    const summary = okValue((await collect({ data: observeSummary({ top_paths: { items: [{ path: "/wiki/%E0%A4%A", views: 1 }, { path: "/wiki/50%", views: 1 }], truncated: false } }) })).screen.summary);
    expect(summary.topPaths.items.map((item) => item.text)).toEqual(["/wiki/%E0%A4%A", "/wiki/50%"]);
  });
});

describe("들어온 곳 — 직접 · 자기 사이트 빼기", () => {
  it("자기 사이트의 호스트는 목록에서 빼고 그 수를 따로 — 남은 줄은 받은 순서", async () => {
    const summary = okValue((await collect()).screen.summary);
    expect(summary.topReferrers).toEqual({ items: [
      { host: null, text: "직접", views: 800 },
      { host: "www.google.com", text: "www.google.com", views: 134 },
    ], truncated: false });
    expect(summary.siteInternal).toEqual({ state: "excluded", views: 300 });
  });

  it("상위 10 에서 하나를 빼면 9개 — 메우지 않는다(관측 서버가 10개만 준다)", async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ host: index === 4 ? FAKE_SITE_HOST : `r${index}.example.net`, views: 100 - index }));
    const summary = okValue((await collect({ data: observeSummary({ top_referrers: { items, truncated: true } }) })).screen.summary);
    expect(summary.topReferrers.items).toHaveLength(9);
    expect(summary.topReferrers.items.map((item) => item.host)).toEqual(items.filter((item) => item.host !== FAKE_SITE_HOST).map((item) => item.host));
    expect(summary.topReferrers.truncated).toBe(true);
    expect(summary.siteInternal).toEqual({ state: "excluded", views: 96 });
  });

  it("받은 목록에 자기 사이트가 없으면 absent — 0 이라고 하지 않는다", async () => {
    const summary = okValue((await collect({ data: observeSummary({ top_referrers: { items: [{ host: "www.google.com", views: 5 }], truncated: false } }) })).screen.summary);
    expect(summary.siteInternal).toEqual({ state: "absent" });
    expect(summary.topReferrers.items).toHaveLength(1);
  });

  it("호스트가 같을 때만 뺀다(다른 하위 이름 · 포트 꼴 · 앞뒤가 붙은 것은 남는다)", async () => {
    const items = [
      { host: "example.com", views: 5 }, { host: "blog.www.example.com", views: 4 }, { host: "www.example.com.evil.example.net", views: 3 }, { host: FAKE_SITE_HOST, views: 2 },
    ];
    const summary = okValue((await collect({ data: observeSummary({ top_referrers: { items, truncated: false } }) })).screen.summary);
    expect(summary.topReferrers.items.map((item) => item.host)).toEqual(["example.com", "blog.www.example.com", "www.example.com.evil.example.net"]);
    expect(summary.siteInternal).toEqual({ state: "excluded", views: 2 });
  });

  it("사이트 주소 설정이 없으면 빼지 않고 그대로 — not_configured", async () => {
    for (const siteOrigin of ["", "not an origin"]) {
      const summary = okValue((await collect({ siteOrigin })).screen.summary);
      expect(summary.topReferrers.items.map((item) => item.host)).toEqual([null, FAKE_SITE_HOST, "www.google.com"]);
      expect(summary.siteInternal).toEqual({ state: "not_configured" });
    }
  });

  it("직접(null) 은 사이트 호스트와 같다고 보지 않는다", async () => {
    const summary = okValue((await collect({ data: observeSummary({ top_referrers: { items: [{ host: null, views: 9 }], truncated: false } }) })).screen.summary);
    expect(summary.topReferrers.items).toEqual([{ host: null, text: "직접", views: 9 }]);
  });
});

describe("주소 · 구분값이 없다 — 허용 목록으로만", () => {
  it("관측 서버가 ip · visitor 를 실어도 화면 데이터에 없다", async () => {
    const { screen } = await collect({ data: observeLeakySummary() });
    expectNoForbiddenText(screen, LEAKED_VALUES);
    const text = JSON.stringify(screen);
    expect(text).not.toMatch(/"(ip|visitor|visitors_list|extra)"/);
  });

  it("화면 데이터에 관측 서버의 주소 · 비밀값이 없다", async () => {
    expectNoForbiddenText((await collect()).screen);
  });
});

describe("읽지 못함 — 0 으로 메우지 않는다", () => {
  it("꼴이 틀리면 summary 가 unparseable 이고 수 · 목록 칸이 없다", async () => {
    const broken = observeSummary();
    (broken.daily as Record<string, unknown>[])[0] = { ...(broken.daily as Record<string, unknown>[])[0], views: "0" };
    const { screen } = await collect({ data: broken });
    expectFailure(screen.summary, "unparseable");
    expect(screen.summary).not.toHaveProperty("value");
    expect(screen.dayOptions).toHaveLength(3);   // 화면 틀은 그대로
  });

  it.each([
    ["503", () => textResponse(leakyErrorBody(), 503), "unavailable"],
    ["504", () => textResponse(leakyErrorBody(), 504), "server_timeout"],
    ["401", () => textResponse(leakyErrorBody(), 401), "unauthorized"],
    ["422", () => textResponse(leakyErrorBody(), 422), "invalid_request"],
  ] as const)("관측 서버 %s → 그 이유", async (_label, respond, reason) => {
    const { screen } = await collect({ handler: () => respond() });
    expectFailure(screen.summary, reason);
    expectNoForbiddenText(screen);
  });

  it("닿지 않음 → unreachable", async () => {
    const { screen } = await collect({ handler: () => Promise.reject(leakyNetworkError()) });
    expectFailure(screen.summary, "unreachable");
  });

  it("설정이 없으면 호출 없이 not_configured", async () => {
    const empty = await collect({ observeUrl: "" });
    expectFailure(empty.screen.summary, "not_configured");
    expect(empty.fetch).not.toHaveBeenCalled();
    const noSecret = await collect({ observeSecret: "" });
    expectFailure(noSecret.screen.summary, "not_configured");
    expect(noSecret.fetch).not.toHaveBeenCalled();
  });
});

describe("visitsScreenFailures — 로그에 남길 칸", () => {
  it("성공이면 빈 목록 · 실패면 [summary, 그 실패] 하나(resourcesScreenFailures 와 같은 꼴)", async () => {
    const ok = (await collect()).screen;
    expect(visitsScreenFailures(ok)).toEqual([]);
    const failed: VisitsScreen = (await collect({ handler: () => textResponse("x", 503) })).screen;
    const [[cell, result]] = visitsScreenFailures(failed);
    expect(cell).toBe("summary");
    expectFailure(result as never, "unavailable", 503);
  });
});
