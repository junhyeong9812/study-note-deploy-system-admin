/** 관측 서버 방문 요약 조회 클라이언트 — 명세 §2 "어드민 조회는 로그인 뒤에만, 관측 서버는 비밀값 머리글로" · "주소 원문은 관측 서버 DB 의 방문 표에만 있다 —
 * … 어드민 화면의 목록 · 요약 응답에는 싣지 않는다" · §10.2 "조회 `GET /visits/summary?days=7|30|90` … 빈 날도 0 으로 줄이 있다. 응답에 주소 · 구분값이 없다".
 * 계약 = observe visit/VisitController.kt · VisitControllerTest · README "조회 GET /visits/summary?days=" (feat/visit-tracking d75b528).
 * 허용 목록으로만 읽는다 — 관측 서버가 실수로 ip · visitor 를 실어도 결과에 없다. 꼴이 틀리면 전체 unparseable — 0 · 빈 목록으로 메우지 않는다. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { VISIT_SUMMARY_PATH, VISIT_TOP_LIMIT, createVisitSummaryClient } from "@/features/visits/lib/visit-summary-client";
import {
  LEAKED_VALUES, createFakeObserveVisits, observeDay, observeEmptySummary, observeEnvelope, observeError, observeLeakySummary, observeSummary, seoulDates,
} from "@/features/visits/lib/visit-summary-test-fakes";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, SECRET_HEADER_NAMES, createRoutedFetch, createTimerTimeoutSignal, expectFailure, expectNoForbiddenText,
  expectReadOnlyRequest, hangUntilAborted, headersOf, headersThenStalledBody, jsonBody, leakyErrorBody, leakyNetworkError, okValue, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";

type RoutedFetch = ReturnType<typeof createRoutedFetch>;

function client(fetch: RoutedFetch, overrides: { baseUrl?: string; secret?: string; timeoutSignal?: (milliseconds: number) => AbortSignal } = {}) {
  return createVisitSummaryClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch, ...overrides });
}

function answering(data: unknown, status = 200): RoutedFetch {
  return createRoutedFetch(() => jsonBody(observeEnvelope(data), status));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("상수", () => {
  it("경로 /visits/summary · 상위 10(observe VisitStore.kt TOP_LIMIT)", () => {
    expect(VISIT_SUMMARY_PATH).toBe("/visits/summary");
    expect(VISIT_TOP_LIMIT).toBe(10);
  });
});

describe("요청 — GET · X-Observe-Secret 만 · redirect manual · 5초", () => {
  it.each([7, 30, 90] as const)("days=%i — GET <base>/visits/summary?days=<그 값>, 끝의 / 허용", async (days) => {
    const fake = createFakeObserveVisits();
    const fetch = createRoutedFetch(fake.handler);
    okValue(await client(fetch, { baseUrl: `${FAKE_OBSERVE_URL}/` }).summary(days));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${FAKE_OBSERVE_URL}/visits/summary?days=${days}`);
    expectReadOnlyRequest(init);
    expect(init?.redirect).toBe("manual");
    for (const name of SECRET_HEADER_NAMES) expect(headersOf(init).get(name)).toBe(name === "x-observe-secret" ? FAKE_OBSERVE_SECRET : null);
  });

  it("제한 시간 신호를 5000ms 로", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch(createFakeObserveVisits().handler);
    await client(fetch, { timeoutSignal: timeout.factory }).summary(7);
    expect(timeout.requestedMilliseconds).toEqual([5_000]);
  });
});

describe("부르기 전 거절 — 호출하지 않는다", () => {
  it.each([
    ["기준 주소가 빔", { baseUrl: "" }], ["기준 주소가 http(s) 가 아님", { baseUrl: "observe.example.test:17000" }],
    ["기준 주소가 ftp", { baseUrl: "ftp://observe.example.test" }], ["비밀값이 빔", { secret: "" }],
  ] as const)("%s → not_configured", async (_label, overrides) => {
    const fetch = createRoutedFetch(createFakeObserveVisits().handler);
    expectFailure(await client(fetch, overrides).summary(7), "not_configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([1, 14, 0, -7, 7.5, Number.NaN])("days 가 허용 목록 밖(%s) → invalid_input field days", async (days) => {
    const fetch = createRoutedFetch(createFakeObserveVisits().handler);
    const result = await client(fetch).summary(days as 7);
    expectFailure(result, "invalid_input");
    expect(result.ok ? null : result.field).toBe("days");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("요약 — 칸 고르기(허용 목록)", () => {
  it("받은 꼴을 그대로 옮긴다 — 날짜 글자 · 봇 제외/포함 · 상위(받은 순서) · 직접 = null · 기기 · 비율", async () => {
    const summary = okValue(await client(answering(observeSummary())).summary(7));
    expect(summary).toEqual({
      days: 7,
      daily: seoulDates(7).map((date, index) => (
        index === 5 ? { date, views: 1200, viewsWithBots: 1500, visitors: 300, visitorsWithBots: 320 }
          : index === 6 ? { date, views: 34, viewsWithBots: 40, visitors: 12, visitorsWithBots: 14 }
            : { date, views: 0, viewsWithBots: 0, visitors: 0, visitorsWithBots: 0 })),
      topPaths: { items: [
        { path: "/wiki/01-N으로%20표현", views: 900 }, { path: "/", views: 200 }, { path: "/wiki/100%25%20done", views: 100 }, { path: "/search", views: 34 },
      ], truncated: false },
      topReferrers: { items: [{ host: null, views: 800 }, { host: "www.example.com", views: 300 }, { host: "www.google.com", views: 134 }], truncated: false },
      devices: { desktop: 1000, mobile: 234, bot: 306 },
      botRatio: 306 / 1540,
    });
    expect(summary.daily[0].date).toBe("2026-11-20");
    expect(summary.daily[6].date).toBe("2026-11-26");
  });

  it("빈 날의 0 은 받은 0 그대로 — 모든 날이 0 인 요약 · 빈 목록 · 비율 0", async () => {
    const summary = okValue(await client(answering(observeEmptySummary(30))).summary(30));
    expect(summary.daily).toHaveLength(30);
    expect(summary.daily.every((day) => day.views === 0 && day.viewsWithBots === 0 && day.visitors === 0 && day.visitorsWithBots === 0)).toBe(true);
    expect(summary.topPaths).toEqual({ items: [], truncated: false });
    expect(summary.topReferrers).toEqual({ items: [], truncated: false });
    expect(summary.devices).toEqual({ desktop: 0, mobile: 0, bot: 0 });
    expect(summary.botRatio).toBe(0);
  });

  it("90일 · 상위 10개와 truncated", async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ path: `/wiki/p${index}`, views: 100 - index }));
    const summary = okValue(await client(answering(observeSummary({ top_paths: { items, truncated: true } }, 90))).summary(90));
    expect(summary.daily).toHaveLength(90);
    expect(summary.topPaths.items).toHaveLength(10);
    expect(summary.topPaths.truncated).toBe(true);
  });

  it("들어온 곳의 host — null · 칸 없음 · 빈 글자는 모두 직접(null)", async () => {
    const summary = okValue(await client(answering(observeSummary({ top_referrers: { items: [{ host: null, views: 3 }, { views: 2 }, { host: "", views: 1 }], truncated: false } }))).summary(7));
    expect(summary.topReferrers.items).toEqual([{ host: null, views: 3 }, { host: null, views: 2 }, { host: null, views: 1 }]);
  });

  it("방문자가 보낸 글자(HTML · 아주 긴 값)도 받은 그대로 — 이 층은 고치지 않는다", async () => {
    const strange = `/wiki/<img src=x onerror=alert(1)>${"가".repeat(400)}`;
    const summary = okValue(await client(answering(observeSummary({ top_paths: { items: [{ path: strange, views: 1 }], truncated: false } }))).summary(7));
    expect(summary.topPaths.items[0].path).toBe(strange);
  });

  it("모르는 칸은 어느 깊이에서든 버린다 — 관측 서버가 ip · visitor 를 실어도 결과에 없다", async () => {
    const summary = okValue(await client(answering(observeLeakySummary())).summary(7));
    expectNoForbiddenText(summary, LEAKED_VALUES);
    const text = JSON.stringify(summary);
    for (const key of ["\"ip\"", "\"visitor\"", "\"visitors_list\"", "\"extra\"", "\"timezone\"", "\"from\"", "\"to\""]) expect(text).not.toContain(key);
    expect(Object.keys(summary).sort()).toEqual(["botRatio", "daily", "days", "devices", "topPaths", "topReferrers"]);
    expect(Object.keys(summary.daily[0]).sort()).toEqual(["date", "views", "viewsWithBots", "visitors", "visitorsWithBots"]);
    expect(Object.keys(summary.topPaths).sort()).toEqual(["items", "truncated"]);
    expect(Object.keys(summary.topPaths.items[0]).sort()).toEqual(["path", "views"]);
    expect(Object.keys(summary.topReferrers.items[0]).sort()).toEqual(["host", "views"]);
    expect(Object.keys(summary.devices).sort()).toEqual(["bot", "desktop", "mobile"]);
  });
});

describe("꼴이 틀리면 unparseable — 수를 0 으로 · 목록을 빈 것으로 메우지 않는다", () => {
  const base = () => observeSummary() as Record<string, unknown> & { daily: Record<string, unknown>[] };
  const cases: [string, () => unknown][] = [
    ["data 가 없음", () => undefined],
    ["data 가 배열", () => []],
    ["days 가 요청과 다름", () => ({ ...base(), days: 30 })],
    ["days 가 글자", () => ({ ...base(), days: "7" })],
    ["daily 가 없음", () => { const { daily: _daily, ...rest } = base(); return rest; }],
    ["daily 가 null", () => ({ ...base(), daily: null })],
    ["daily 가 하루 모자람", () => ({ ...base(), daily: base().daily.slice(1) })],
    ["daily 가 하루 넘침", () => ({ ...base(), daily: [...base().daily, observeDay("2026-11-27")] })],
    ["daily 의 views 가 글자", () => ({ ...base(), daily: base().daily.map((row, index) => (index === 6 ? { ...row, views: "34" } : row)) })],
    ["daily 의 views 가 null", () => ({ ...base(), daily: base().daily.map((row, index) => (index === 0 ? { ...row, views: null } : row)) })],
    ["daily 의 visitors 가 빠짐", () => ({ ...base(), daily: base().daily.map((row, index) => { if (index !== 3) return row; const { visitors: _visitors, ...rest } = row; return rest; }) })],
    ["daily 의 views_with_bots 가 음수", () => ({ ...base(), daily: base().daily.map((row, index) => (index === 1 ? { ...row, views_with_bots: -1 } : row)) })],
    ["daily 의 visitors_with_bots 가 소수", () => ({ ...base(), daily: base().daily.map((row, index) => (index === 1 ? { ...row, visitors_with_bots: 1.5 } : row)) })],
    ["daily 의 date 가 시각 꼴", () => ({ ...base(), daily: base().daily.map((row, index) => (index === 2 ? { ...row, date: "2026-11-22T00:00:00Z" } : row)) })],
    ["daily 의 date 가 숫자", () => ({ ...base(), daily: base().daily.map((row, index) => (index === 2 ? { ...row, date: 20261122 } : row)) })],
    ["daily 줄이 객체가 아님", () => ({ ...base(), daily: [...base().daily.slice(0, 6), 34] })],
    ["top_paths 가 없음", () => { const { top_paths: _paths, ...rest } = base(); return rest; }],
    ["top_paths 가 배열(items 가 아님)", () => ({ ...base(), top_paths: [] })],
    ["top_paths.items 가 없음", () => ({ ...base(), top_paths: { truncated: false } })],
    ["top_paths.truncated 가 없음", () => ({ ...base(), top_paths: { items: [] } })],
    ["top_paths.truncated 가 글자", () => ({ ...base(), top_paths: { items: [], truncated: "false" } })],
    ["top_paths 의 path 가 null", () => ({ ...base(), top_paths: { items: [{ path: null, views: 1 }], truncated: false } })],
    ["top_paths 의 views 가 빠짐", () => ({ ...base(), top_paths: { items: [{ path: "/" }], truncated: false } })],
    ["top_paths 가 11개", () => ({ ...base(), top_paths: { items: Array.from({ length: 11 }, (_, index) => ({ path: `/p${index}`, views: 1 })), truncated: true } })],
    ["top_referrers 가 없음", () => { const { top_referrers: _referrers, ...rest } = base(); return rest; }],
    ["top_referrers 의 host 가 숫자", () => ({ ...base(), top_referrers: { items: [{ host: 1, views: 1 }], truncated: false } })],
    ["top_referrers 의 views 가 글자", () => ({ ...base(), top_referrers: { items: [{ host: null, views: "1" }], truncated: false } })],
    ["top_referrers 가 11개", () => ({ ...base(), top_referrers: { items: Array.from({ length: 11 }, (_, index) => ({ host: `h${index}.example.net`, views: 1 })), truncated: true } })],
    ["devices 가 없음", () => { const { devices: _devices, ...rest } = base(); return rest; }],
    ["devices.bot 이 빠짐", () => ({ ...base(), devices: { desktop: 1, mobile: 1 } })],
    ["devices.mobile 이 null", () => ({ ...base(), devices: { desktop: 1, mobile: null, bot: 0 } })],
    ["bot_ratio 가 없음", () => { const { bot_ratio: _ratio, ...rest } = base(); return rest; }],
    ["bot_ratio 가 null", () => ({ ...base(), bot_ratio: null })],
    ["bot_ratio 가 글자", () => ({ ...base(), bot_ratio: "0.2" })],
    ["bot_ratio 가 1 보다 큼", () => ({ ...base(), bot_ratio: 1.5 })],
    ["bot_ratio 가 음수", () => ({ ...base(), bot_ratio: -0.1 })],
  ];

  it.each(cases)("%s", async (_label, makeData) => {
    const data = makeData();
    const fetch = createRoutedFetch(() => jsonBody(data === undefined ? { success: true } : observeEnvelope(data)));
    expectFailure(await client(fetch).summary(7), "unparseable");
  });

  it.each([
    ["JSON 이 아님", () => textResponse("<html>oops</html>", 200, "text/html")],
    ["success 가 false", () => jsonBody({ success: false, data: observeSummary() })],
    ["봉투가 없음(data 만)", () => jsonBody(observeSummary())],
    ["빈 본문", () => textResponse("")],
  ] as const)("본문이 %s → unparseable", async (_label, respond) => {
    expectFailure(await client(createRoutedFetch(() => respond())).summary(7), "unparseable");
  });
});

describe("실패 — 고정 이유와 상태 코드만(원문 · 주소 · 비밀값 없음)", () => {
  it.each([
    [401, "unauthorized"], [422, "invalid_request"], [503, "unavailable"], [504, "server_timeout"], [500, "bad_status"], [404, "bad_status"], [302, "bad_status"],
  ] as const)("HTTP %i → %s", async (status, reason) => {
    const fetch = createRoutedFetch(() => textResponse(leakyErrorBody(), status));
    expectFailure(await client(fetch).summary(7), reason, status);
  });

  it("관측 서버의 실제 오류 본문(401 · 503 · 504)도 같은 이유", async () => {
    expectFailure(await client(createRoutedFetch(() => jsonBody(observeError("unauthorized"), 401))).summary(7), "unauthorized", 401);
    expectFailure(await client(createRoutedFetch(() => jsonBody(observeError("query_failed"), 503))).summary(7), "unavailable", 503);
    expectFailure(await client(createRoutedFetch(() => jsonBody(observeError("query_timeout"), 504))).summary(7), "server_timeout", 504);
  });

  it("비밀값이 틀리면 가짜 관측 서버가 401 → unauthorized", async () => {
    const fetch = createRoutedFetch(createFakeObserveVisits().handler);
    expectFailure(await client(fetch, { secret: "wrong-secret" }).summary(7), "unauthorized", 401);
  });

  it("연결 실패(예외 문구에 주소 · 비밀값) → unreachable", async () => {
    const fetch = createRoutedFetch(() => Promise.reject(leakyNetworkError()));
    expectFailure(await client(fetch).summary(7), "unreachable");
  });

  it("fetch 가 동기로 던져도 거부하지 않고 unreachable", async () => {
    const fetch = createRoutedFetch(() => { throw leakyNetworkError(); });
    expectFailure(await client(fetch).summary(7), "unreachable");
  });

  it.each([
    ["응답하지 않음", (_url: URL, init: RequestInit) => hangUntilAborted(init)],
    ["머리글만 주고 본문을 끝내지 않음", (_url: URL, init: RequestInit) => headersThenStalledBody(init)],
  ] as const)("%s → 5초에 timeout, 호출 1회", async (_label, behave) => {
    vi.useFakeTimers();
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch(behave);
    const pending = track(client(fetch, { timeoutSignal: timeout.factory }).summary(7));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expectFailure(pending.value!, "timeout");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
