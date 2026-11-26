/** 테스트 전용 — 방문 기록 사례의 가짜 관측 서버(`GET /visits/summary`). 주소 · 비밀값은 upstream-test-fakes 의 명백한 가짜.
 * 응답 꼴은 관측 서버의 실제 소스에서 옮겼다(feat/visit-tracking d75b528):
 * - observe visit/VisitController.kt `data()`: `{days, timezone:"Asia/Seoul", from, to(Instant 글자), daily:[{date, views, views_with_bots, visitors, visitors_with_bots}],
 *   top_paths:{items:[{path, views}], truncated}, top_referrers:{items:[{host(null = 직접), views}], truncated}, devices:{desktop, mobile, bot}, bot_ratio}`.
 * - observe VisitControllerTest `요약의 칸 이름과 값` — date 는 `2026-11-24` 꼴, 직접은 host null, bot_ratio = 봇 ÷ 전체(0.25) · 방문이 없으면 0.0.
 * - observe VisitStore.kt summary(): 서울 시각의 날마다 한 줄(빈 날도 0 — 오래된 날부터) · 상위는 봇을 빼고 10개(TOP_LIMIT), 하나 더 읽어 truncated ·
 *   같은 수는 바이트 순(직접 null 은 맨 앞) · devices 는 봇 포함 창 안의 조회 수.
 * - 오류(VisitController.kt · README): 401 `{success:false,error:{code:"unauthorized"}}` · 422 `invalid_request`(detail) · 503 `query_failed` · 504 `query_timeout`.
 * 일부러 계약 밖 칸(ip · visitor · extra)에 주소 · 구분값 · 표식을 넣는다 — 결과에 나오면 허용 목록으로 읽지 않은 것이다. */
import { FAKE_OBSERVE_SECRET, UPSTREAM_RAW_MARKER, headersOf, jsonBody, type RoutedFetchHandler } from "@/shared/lib/upstream-test-fakes";

/** 사이트의 공개 주소(가짜 — 문서용 도메인) */
export const FAKE_SITE_ORIGIN = "https://www.example.com";
export const FAKE_SITE_HOST = "www.example.com";

/** 관측 서버가 실수로 실을 수 있는 방문자 주소 · 구분값(문서용 대역 · 가짜 해시) — 어드민의 결과 어디에도 나오면 안 된다. */
export const LEAKED_VISITOR_IPV4 = "198.51.100.23";
export const LEAKED_VISITOR_IPV6 = "2001:db8::bad:23";
export const LEAKED_VISITOR_ID = "c0ffee".padEnd(64, "e");
export const LEAKED_VALUES: readonly string[] = [LEAKED_VISITOR_IPV4, LEAKED_VISITOR_IPV6, LEAKED_VISITOR_ID, UPSTREAM_RAW_MARKER];

/** 2026-11-26(서울) 을 끝으로 하는 days 날의 날짜 글자(오래된 날부터) */
export function seoulDates(days: number, lastDate = "2026-11-26"): string[] {
  const last = Date.parse(`${lastDate}T00:00:00Z`);
  return Array.from({ length: days }, (_, index) => new Date(last - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10));
}

export function observeDay(date: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { date, views: 0, views_with_bots: 0, visitors: 0, visitors_with_bots: 0, ...overrides };
}

/** 모든 날이 0 인 요약(관측 서버의 빈 표 — 스트림이 없어도 이 꼴) */
export function observeEmptySummary(days = 7): Record<string, unknown> {
  return {
    days, timezone: "Asia/Seoul", from: "2026-11-19T15:00:00Z", to: "2026-11-26T03:00:00Z",
    daily: seoulDates(days).map((date) => observeDay(date)),
    top_paths: { items: [], truncated: false },
    top_referrers: { items: [], truncated: false },
    devices: { desktop: 0, mobile: 0, bot: 0 },
    bot_ratio: 0.0,
  };
}

/** 방문이 있는 요약(7일) — 마지막 두 날에 방문, 직접 · 검색 · 자기 사이트가 섞인 들어온 곳 */
export function observeSummary(overrides: Record<string, unknown> = {}, days = 7): Record<string, unknown> {
  const dates = seoulDates(days);
  const daily = dates.map((date, index) => {
    if (index === days - 2) return observeDay(date, { views: 1200, views_with_bots: 1500, visitors: 300, visitors_with_bots: 320 });
    if (index === days - 1) return observeDay(date, { views: 34, views_with_bots: 40, visitors: 12, visitors_with_bots: 14 });
    return observeDay(date);
  });
  return {
    ...observeEmptySummary(days),
    daily,
    top_paths: { items: [
      { path: "/wiki/01-N으로%20표현", views: 900 },
      { path: "/", views: 200 },
      { path: "/wiki/100%25%20done", views: 100 },
      { path: "/search", views: 34 },
    ], truncated: false },
    top_referrers: { items: [
      { host: null, views: 800 },
      { host: FAKE_SITE_HOST, views: 300 },
      { host: "www.google.com", views: 134 },
    ], truncated: false },
    devices: { desktop: 1000, mobile: 234, bot: 306 },
    bot_ratio: 306 / 1540,
    ...overrides,
  };
}

/** 봉투(성공) */
export function observeEnvelope(data: unknown): Record<string, unknown> {
  return { success: true, data };
}

export function observeError(code: string): Record<string, unknown> {
  return { success: false, error: code === "invalid_request" ? { code, detail: "days 는 7 · 30 · 90 중 하나" } : { code } };
}

/** 관측 서버가 실수로 주소 · 구분값을 실은 요약 — data · daily 줄 · 상위 줄 · devices 에 모두 */
export function observeLeakySummary(days = 7): Record<string, unknown> {
  const base = observeSummary({}, days) as {
    daily: Record<string, unknown>[]; top_paths: { items: Record<string, unknown>[] }; top_referrers: { items: Record<string, unknown>[] }; devices: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    ...base,
    ip: LEAKED_VISITOR_IPV4,
    visitor: LEAKED_VISITOR_ID,
    visitors_list: [LEAKED_VISITOR_ID],
    extra: UPSTREAM_RAW_MARKER,
    daily: base.daily.map((row) => ({ ...row, ip: LEAKED_VISITOR_IPV6, visitor: LEAKED_VISITOR_ID })),
    top_paths: { ...base.top_paths, ip: LEAKED_VISITOR_IPV4, items: base.top_paths.items.map((row) => ({ ...row, ip: LEAKED_VISITOR_IPV4, visitor: LEAKED_VISITOR_ID })) },
    top_referrers: { ...base.top_referrers, visitor: LEAKED_VISITOR_ID, items: base.top_referrers.items.map((row) => ({ ...row, ip: LEAKED_VISITOR_IPV6 })) },
    devices: { ...base.devices, ip: LEAKED_VISITOR_IPV4 },
  };
}

export interface FakeObserveVisits {
  /** `days` 인자 → 응답(기본: 그 days 의 observeSummary 봉투) */
  summary: (days: string | null, init: RequestInit) => Promise<Response> | Response;
  calls: { url: URL; days: string | null; secret: string | null; init: RequestInit }[];
  handler: RoutedFetchHandler;
}

/** 가짜 관측 서버 — 비밀값이 틀리면 실제처럼 401(입력 검사보다 먼저), 허용 목록 밖의 days 는 422, 그 밖의 경로는 404. */
export function createFakeObserveVisits(summary?: FakeObserveVisits["summary"]): FakeObserveVisits {
  const fake: FakeObserveVisits = {
    summary: summary ?? ((days) => jsonBody(observeEnvelope(observeSummary({}, Number(days ?? "7"))))),
    calls: [],
    handler: (url, init) => {
      const days = url.searchParams.get("days");
      const secret = headersOf(init).get("x-observe-secret");
      fake.calls.push({ url, days, secret, init });
      if (url.pathname !== "/visits/summary") return jsonBody({ success: false, error: { code: "not_found" } }, 404);
      if (secret !== FAKE_OBSERVE_SECRET) return jsonBody(observeError("unauthorized"), 401);
      if (days !== null && !["7", "30", "90"].includes(days)) return jsonBody(observeError("invalid_request"), 422);
      return fake.summary(days, init);
    },
  };
  return fake;
}
