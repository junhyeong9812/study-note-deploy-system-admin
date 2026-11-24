/** 상태 한눈에의 서버 자원 요약(순수 — 설정은 options 로). 명세 §2.6 "'상태 한눈에': 서버별 한 줄(CPU · 메모리 · 디스크 · 마지막 수신 시각)과
 * 넘어 있는 임계값을 요약에 더한다. '서버 자원'으로 가는 링크" · §2.3 "한 구역이 실패해도 다른 구역은 보인다" · §16 latest 의 서버 목록.
 *
 * 기존 StatusOverview(다섯 칸)의 꼴은 바꾸지 않는다 — 자원 요약은 따로 모아 collectStatusScreen 이 { overview, resources } 로 묶는다.
 * (기존 진입 loadStatusOverview 는 지금처럼 다섯 주소만 부른다 — app/screen-data-entries.test.ts:235-236 이 호출 주소의 집합을 고정한다.)
 *
 * 조회: 관측 서버 `GET /metrics/latest` 한 번뿐(계열 조회 없음) — createResourceMetricsClient 를 그대로 쓴다(실패 종류 · 비밀값 비노출 · 본문 상한은 그 클라이언트의 것).
 * collectStatusScreen 은 기존 다섯 호출과 이 호출을 **한꺼번에** 시작한다(서로 기다리지 않는다 — 전체 소요는 가장 느린 한 호출, 각자 5초).
 * 관측 서버 설정(observeUrl · observeSecret)이 없으면 resources 만 not_configured(호출 없음) — 다섯 칸은 그대로.
 *
 * 요약(statusResourcesFromLatest — latest 를 받아 순수 계산):
 * - 줄: 서버 이름순(글자 코드 순), 앞 STATUS_RESOURCE_SERVER_LIMIT 대(그 밖은 hiddenServerCount).
 * - 신선도: 서버 자원 화면과 같은 규칙 — measuredAt null → never("수신 없음", ageMilliseconds 는 받은 값) · stale null → unknown("확인하지 못함") ·
 *   stale true → stale(`"<formatAge(age)> 값"`, age 를 모르면 "오래된 값") · stale false → fresh(label null). 음수 age 는 0.
 * - receivedAt: 받은 글자 그대로(마지막 수신 시각 — §2.6).
 * - CPU · 메모리 · 디스크: 값이면 state "value"(formatPercent — 메모리 · 디스크는 used ÷ total × 100, total 이 0 · null 이면 값 없음).
 *   값이 없을 때 missing 에 "host" 가 있으면 "unread"("읽지 못함"), 아니면 "none"("없음"). never 인 서버는 "none". 0 은 값이다.
 * - 임계값: latest.firing 이 null 이면 firingKnown false(줄마다 firingCount 0 · worstFiring null). 그 서버의 firing 수와 가장 심한 것
 *   (critical > warning > 그 밖, 같으면 받은 순서의 앞) — 규칙 · 심각도 이름은 FIRING_RULE_LABELS · FIRING_SEVERITY_LABELS(모르는 낱말은 그대로).
 *   화면에 남긴 줄에 없는 서버의 firing 은 elsewhereFiringCount 로 센다.
 * - 링크: 줄마다 href = `resourcesHref({ range: "1h", container: null }) + "#resource-server-<서버>"`(서버 자원 화면의 그 서버 묶음 —
 *   ui/ResourcesScreen.tsx 의 제목 id), screenHref = resourcesHref({ range: "1h", container: null }).
 * 요약 줄(statusResourceSummaryItems — 상태 화면 맨 위 요약에 더할 재료):
 * - 실패 → unreachable [{ label: "서버 자원" }], problems [].
 * - 성공 → firing 마다 problems `"서버 <서버> <규칙 이름>[ <대상>](<심각도 이름>)"`(화면에 남긴 줄의 서버 이름순, 서버 안에서는 받은 순서, 그 다음 다른 서버의 것을 받은 순서),
 *   firingKnown false 면 unreachable [{ label: "서버 자원 임계값" }]. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { LatestResources } from "@/features/resources/lib/resource-metrics-client";
import type { StatusOverview, StatusOverviewOptions } from "@/features/status/lib/status-overview";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

export const STATUS_RESOURCE_SERVER_LIMIT = 10;
export const STATUS_RESOURCE_ANCHOR_PREFIX = "resource-server-";

export type StatusResourceValueState = "value" | "none" | "unread";

export interface StatusResourceValue {
  state: StatusResourceValueState;
  value: number | null;
  /** "3.4%" · "없음" · "읽지 못함" */
  text: string;
}

export interface StatusResourceFiring {
  rule: string;
  ruleLabel: string;
  severity: string;
  severityLabel: string;
  target: string | null;
}

export type StatusResourceFreshness =
  | { kind: "fresh"; label: null; ageMilliseconds: number | null }
  | { kind: "stale"; label: string; ageMilliseconds: number | null }
  | { kind: "never"; label: string; ageMilliseconds: number | null }
  | { kind: "unknown"; label: string; ageMilliseconds: number | null };

export interface StatusResourceRow {
  server: string;
  /** 서버 자원 화면의 그 서버 묶음 */
  href: string;
  freshness: StatusResourceFreshness;
  /** 마지막 수신 시각(받은 글자) — 없으면 null */
  receivedAt: string | null;
  cpu: StatusResourceValue;
  memory: StatusResourceValue;
  disk: StatusResourceValue;
  firingCount: number;
  worstFiring: StatusResourceFiring | null;
}

export interface StatusResourcesSummary {
  rows: StatusResourceRow[];
  hiddenServerCount: number;
  firingKnown: boolean;
  elsewhereFiringCount: number;
  /** 서버 자원 화면 */
  screenHref: string;
}

export interface StatusResourcesOptions {
  observeUrl: string;
  observeSecret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface StatusScreenOptions extends StatusOverviewOptions {
  observeSecret: string;
}

export interface StatusScreenData {
  /** 기존 다섯 칸 그대로 */
  overview: StatusOverview;
  resources: UpstreamResult<StatusResourcesSummary>;
}

export interface StatusResourceSummaryItems {
  problems: { label: string }[];
  unreachable: { label: string }[];
}

export function statusResourcesFromLatest(latest: LatestResources): StatusResourcesSummary {
  void latest;
  throw new Error("not implemented");
}

/** latest 한 번 → 요약. 거부(reject)하지 않는다 — 해석 중 뜻밖의 예외는 unparseable. */
export function collectStatusResources(options: StatusResourcesOptions): Promise<UpstreamResult<StatusResourcesSummary>> {
  void options;
  throw new Error("not implemented");
}

/** 기존 다섯 호출(collectStatusOverview)과 자원 요약을 한꺼번에 시작해 둘 다 끝나면 묶는다. */
export function collectStatusScreen(options: StatusScreenOptions): Promise<StatusScreenData> {
  void options;
  throw new Error("not implemented");
}

export function statusResourceSummaryItems(resources: UpstreamResult<StatusResourcesSummary>): StatusResourceSummaryItems {
  void resources;
  throw new Error("not implemented");
}
