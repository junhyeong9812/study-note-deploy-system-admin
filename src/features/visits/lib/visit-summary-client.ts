/** 관측 서버 방문 요약 조회 클라이언트(순수 — 설정을 읽지 않는다. 기준 주소 · 비밀값은 부르는 쪽이 준다). 명세 §2 · §10.2.
 *
 * 경로: `GET <base>/visits/summary?days=<7|30|90>` — 머리글 `X-Observe-Secret` · 5초 기한(UPSTREAM_TIMEOUT_MILLISECONDS — 본문 포함) ·
 * 재시도 없음 · redirect:"manual" · 본문 없음(shared/lib/upstream-fetch 의 getUpstream).
 * 계약(observe visit/VisitController.kt · VisitControllerTest · README "조회 GET /visits/summary?days="): 봉투 `{success:true,data:{…}}`,
 * 오류 401 unauthorized · 422 invalid_request · 503 query_failed · 504 query_timeout.
 *
 * 부르기 전 거절(호출하지 않는다): 기준 주소가 http(s) 로 해석되지 않거나 비밀값이 비면 not_configured · days 가 VISIT_DAYS 밖이면 invalid_input(field "days").
 * 응답 상태 → 실패 이유는 failureForHttpStatus 그대로(3xx 포함). 연결 실패 unreachable · 5초 timeout. 오류 본문 · 예외 문구 · 주소 · 비밀값은 결과에 없다.
 *
 * 응답을 믿지 않는다 — **허용 목록으로만 읽는다**(아래 칸만 옮기고, 모르는 칸은 어느 깊이에서든 버린다 — 관측 서버가 실수로 `ip` · `visitor` 를 실어도
 * 결과에 없다). 아래 칸이 빠지거나 형이 틀리면 **전체 unparseable** — 수를 0 으로 · 목록을 빈 것으로 메우지 않는다(빈 날의 0 은 관측 서버가 준 0 이다):
 * - data.days: 요청한 days 와 같은 정수.
 * - data.daily: 배열, 길이 = days. 줄마다 date(`YYYY-MM-DD` 글자 — 서울의 날, 받은 글자 그대로) · views · views_with_bots · visitors · visitors_with_bots(0 이상의 정수).
 *   받은 순서 그대로(관측 서버가 오래된 날부터 준다).
 * - data.top_paths: `{items, truncated}` — items 는 배열(VISIT_TOP_LIMIT 개 이하), 줄마다 path(글자) · views(0 이상의 정수). truncated 는 참거짓.
 * - data.top_referrers: `{items, truncated}` — 줄마다 host(글자 · null · 칸 없음 — null 과 칸 없음과 빈 글자는 모두 직접 = null) · views. 그 밖은 top_paths 와 같다.
 * - data.devices: desktop · mobile · bot(0 이상의 정수).
 * - data.bot_ratio: 0 이상 1 이하의 유한한 수(관측 서버는 방문이 없으면 0 을 준다 — 그 0 을 화면 모델이 "—" 로 바꾼다).
 * - data.timezone · from · to 는 옮기지 않는다(화면이 쓰지 않는다). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { VISIT_DAYS, type VisitDays } from "@/features/visits/lib/visits-query";
import { envelopeData, getUpstream, isHttpBaseUrl, isNonNegativeInteger, isRecord, upstreamUrl } from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, invalidInput, upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const VISIT_SUMMARY_PATH = "/visits/summary";

/** 관측 서버의 상위 목록 상한(observe VisitStore.kt TOP_LIMIT = 10). */
export const VISIT_TOP_LIMIT = 10;

export interface VisitDay {
  /** `YYYY-MM-DD`(서울의 날 — 받은 글자 그대로) */
  date: string;
  /** 봇을 뺀 조회 수 */
  views: number;
  viewsWithBots: number;
  /** 봇을 뺀 그날의 순방문자 */
  visitors: number;
  visitorsWithBots: number;
}

export interface VisitPathViews {
  /** 받은 글자 그대로(풀지 않은 경로) */
  path: string;
  views: number;
}

export interface VisitReferrerViews {
  /** null = 직접 */
  host: string | null;
  views: number;
}

export interface VisitSummary {
  days: VisitDays;
  daily: VisitDay[];
  topPaths: { items: VisitPathViews[]; truncated: boolean };
  topReferrers: { items: VisitReferrerViews[]; truncated: boolean };
  devices: { desktop: number; mobile: number; bot: number };
  botRatio: number;
}

export interface VisitSummaryClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface VisitSummaryClient {
  /** 거부(reject)하지 않는다 */
  summary(days: VisitDays): Promise<UpstreamResult<VisitSummary>>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 꼴이 틀렸다 — summary() 가 받아 unparseable 로 바꾼다. */
class UnexpectedShape extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new UnexpectedShape();
  return value;
}

function count(value: unknown): number {
  if (!isNonNegativeInteger(value)) throw new UnexpectedShape();
  return value;
}

function parseDay(value: unknown): VisitDay {
  const row = record(value);
  if (typeof row.date !== "string" || !DATE_PATTERN.test(row.date)) throw new UnexpectedShape();
  return {
    date: row.date, views: count(row.views), viewsWithBots: count(row.views_with_bots),
    visitors: count(row.visitors), visitorsWithBots: count(row.visitors_with_bots),
  };
}

function parseTop<Item>(value: unknown, parseItem: (row: Record<string, unknown>) => Item): { items: Item[]; truncated: boolean } {
  const top = record(value);
  if (!Array.isArray(top.items) || top.items.length > VISIT_TOP_LIMIT || typeof top.truncated !== "boolean") throw new UnexpectedShape();
  return { items: top.items.map((row) => parseItem(record(row))), truncated: top.truncated };
}

function parsePath(row: Record<string, unknown>): VisitPathViews {
  if (typeof row.path !== "string") throw new UnexpectedShape();
  return { path: row.path, views: count(row.views) };
}

function parseReferrer(row: Record<string, unknown>): VisitReferrerViews {
  const { host } = row;
  if (host !== undefined && host !== null && typeof host !== "string") throw new UnexpectedShape();
  return { host: typeof host === "string" && host !== "" ? host : null, views: count(row.views) };
}

function parseSummary(data: Record<string, unknown>, days: VisitDays): VisitSummary {
  if (data.days !== days || !Array.isArray(data.daily) || data.daily.length !== days) throw new UnexpectedShape();
  const devices = record(data.devices);
  const botRatio = data.bot_ratio;
  if (typeof botRatio !== "number" || !Number.isFinite(botRatio) || botRatio < 0 || botRatio > 1) throw new UnexpectedShape();
  return {
    days,
    daily: data.daily.map(parseDay),
    topPaths: parseTop(data.top_paths, parsePath),
    topReferrers: parseTop(data.top_referrers, parseReferrer),
    devices: { desktop: count(devices.desktop), mobile: count(devices.mobile), bot: count(devices.bot) },
    botRatio,
  };
}

export function createVisitSummaryClient(options: VisitSummaryClientOptions): VisitSummaryClient {
  const configured = isHttpBaseUrl(options.baseUrl) && options.secret.length > 0;
  return {
    async summary(days) {
      if (!configured) return upstreamFailure("not_configured");
      if (!(VISIT_DAYS as readonly number[]).includes(days)) return invalidInput("days");
      const response = await getUpstream(upstreamUrl(options.baseUrl, VISIT_SUMMARY_PATH, [["days", String(days)]]), {
        fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers: { "X-Observe-Secret": options.secret },
      });
      if (!response.ok) return response;
      if (response.status < 200 || response.status >= 300) return failureForHttpStatus(response.status);
      const data = envelopeData(response);
      if (data === undefined) return upstreamFailure("unparseable");
      try {
        return { ok: true, value: parseSummary(data, days) };
      } catch {
        return upstreamFailure("unparseable");
      }
    },
  };
}
