/** 방문 기록 화면의 데이터(순수 — 설정은 options 로 받는다, 거부(reject)하지 않는다). 명세 §1 · §2 · §10.2 · §13 · §14.
 *
 * 호출: 관측 서버 `GET /visits/summary?days=` 한 번(createVisitSummaryClient — 5초). 실패하면 summary 가 그 실패(UpstreamResult) — 수를 0 으로 메우지 않는다.
 * 설정(observeUrl 이 http(s) 가 아니거나 observeSecret 이 빔)이 없으면 호출 없이 not_configured. 해석 중 뜻밖의 예외도 unparseable.
 * 실패를 앱 로그로 남길 때의 칸 이름(server/ 진입이 쓴다 — visitsScreenFailures 는 실패한 칸만 `[칸 이름, 실패]` 로 — 성공이면 빈 목록): `summary`.
 *
 * 화면 데이터(VisitsScreen — API 응답 `data` 와 같은 것. **주소 · 구분값(visitor) 칸은 없다** — 요약의 허용 목록에서만 만든다):
 * - days · dayOptions(VISIT_DAYS 순서 — href = visitsHref(days), selected = 지금 days) · notice = VISITS_TEXT.untrustedNotice.
 * - summary.ok 일 때(VisitsSummaryView):
 *   - daily: 받은 줄 그대로(날짜 글자 그대로). totals: views · viewsWithBots 의 합(순방문자는 날마다 따로 센 값이라 더하지 않는다).
 *   - empty: 모든 날의 viewsWithBots 가 0(봇만 온 날이 있으면 비어 있지 않다).
 *   - topPaths.items: 받은 순서 그대로 `{path(받은 글자), text: displayVisitPath(path), href: visitPathHref(siteOrigin, path), views}`. truncated 그대로.
 *   - topReferrers.items: 받은 순서 그대로 `{host, text: displayReferrerHost(host), views}` — 단 siteOrigin 이 있으면 host 가 siteHostOf(siteOrigin) 와
 *     같은 줄은 빼고(빈자리를 메우지 않는다 — 10개 중 하나를 빼면 9개), 뺀 줄의 views 합을 siteInternal 로 따로.
 *   - siteInternal: siteOrigin 이 없으면(빈 값 · 꼴이 틀림 — parseSiteOrigin 이 null) `{state:"not_configured"}`(빼지 않는다) ·
 *     뺀 줄이 있으면 `{state:"excluded", views}` · 없으면 `{state:"absent"}`(받은 상위 목록에 없었다 — 0 이라고 하지 않는다).
 *   - devices 그대로. botRatio: devices 의 합이 0 이면 null("—"), 아니면 받은 bot_ratio.
 * siteOrigin 은 링크와 자기 사이트 빼기에만 쓴다(설정 없음이 요약 칸의 실패가 되지 않는다). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { VisitDay } from "@/features/visits/lib/visit-summary-client";
import type { VisitDays, VisitsQuery } from "@/features/visits/lib/visits-query";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

/** 화면에 보이는 고정 글(테스트가 이 글자를 고정한다). */
export const VISITS_TEXT = {
  title: "방문 기록",
  untrustedNotice: "경로와 들어온 곳은 방문자가 보낸 값입니다 — 사이트에 없는 글도 올라올 수 있습니다.",
  empty: "아직 방문 기록이 없습니다",
  unknown: "확인하지 못함",
  noItems: "기록 없음",
  truncated: "더 있음 — 상위 10개만 보입니다",
  siteInternalNotConfigured: "사이트 주소 설정(SITE_ORIGIN)이 없어 사이트 안 이동을 빼지 않았습니다",
  siteInternalAbsent: "사이트 안 이동: 받은 상위 10개에 없음",
  /** 뒤에 수(천 단위)가 붙는다 — `사이트 안 이동 1,234 (목록에서 뺌)` */
  siteInternalExcludedPrefix: "사이트 안 이동",
  siteInternalExcludedSuffix: "(목록에서 뺌)",
} as const;

export interface VisitDayOption {
  days: VisitDays;
  label: string;
  href: string;
  selected: boolean;
}

export interface VisitPathItem {
  path: string;
  text: string;
  href: string | null;
  views: number;
}

export interface VisitReferrerItem {
  host: string | null;
  text: string;
  views: number;
}

export type VisitSiteInternal =
  | { state: "not_configured" }
  | { state: "absent" }
  | { state: "excluded"; views: number };

export interface VisitsSummaryView {
  daily: VisitDay[];
  totals: { views: number; viewsWithBots: number };
  empty: boolean;
  topPaths: { items: VisitPathItem[]; truncated: boolean };
  topReferrers: { items: VisitReferrerItem[]; truncated: boolean };
  siteInternal: VisitSiteInternal;
  devices: { desktop: number; mobile: number; bot: number };
  botRatio: number | null;
}

export interface VisitsScreen {
  days: VisitDays;
  dayOptions: VisitDayOption[];
  notice: string;
  summary: UpstreamResult<VisitsSummaryView>;
}

export interface CollectVisitsScreenOptions {
  observeUrl: string;
  observeSecret: string;
  /** 사이트의 공개 주소(설정 SITE_ORIGIN 의 값 그대로 — 비었거나 꼴이 틀리면 링크 · 자기 사이트 빼기 없음) */
  siteOrigin: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
  query: VisitsQuery;
}

export async function collectVisitsScreen(options: CollectVisitsScreenOptions): Promise<VisitsScreen> {
  void options;
  throw new Error("구현 전");
}

export function visitsScreenFailures(screen: VisitsScreen): [string, UpstreamResult<unknown>][] {
  void screen;
  throw new Error("구현 전");
}
