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
 *   firingKnown false 면 unreachable [{ label: "서버 자원 임계값" }].
 * - 성공이면 unreachable 에 신선도가 fresh 가 아닌 줄(오래된 값 · 수신 없음 · 확인하지 못함)마다 `"서버 <서버> <받은 때 글>"`(줄 순서 — §18, 알림이 울리지 않은 동안에도). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { createResourceMetricsClient, type FiringRule, type LatestResources } from "@/features/resources/lib/resource-metrics-client";
import { resourcesHref } from "@/features/resources/lib/resources-query";
import {
  byCharacterCode, currentReadings, firingView, freshnessOf, serverFiringOf, type MetricReading,
} from "@/features/resources/lib/resources-screen";
import { collectStatusOverview, type StatusOverview, type StatusOverviewOptions } from "@/features/status/lib/status-overview";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

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

export interface StatusResourceElsewhereFiring extends StatusResourceFiring {
  server: string;
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
  /** 그 서버의 울리는 임계값 전부(받은 순서) — 맨 위 요약(statusResourceSummaryItems)의 재료 */
  firing: StatusResourceFiring[];
}

export interface StatusResourcesSummary {
  rows: StatusResourceRow[];
  hiddenServerCount: number;
  /** latest 에서 이름을 읽지 못해 버린 서버 줄의 수(§18) */
  unreadableServerNameCount: number;
  firingKnown: boolean;
  elsewhereFiringCount: number;
  /** 화면에 남긴 줄에 없는 서버의 울리는 임계값(받은 순서) — 맨 위 요약의 재료 */
  elsewhereFiring: StatusResourceElsewhereFiring[];
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

/** 심각도의 무게 — critical > warning > 그 밖. */
function severityWeight(severity: string): number {
  return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
}

function statusFiring(rule: FiringRule): StatusResourceFiring {
  const view = firingView(rule);
  return { rule: view.rule, ruleLabel: view.ruleLabel, severity: view.severity, severityLabel: view.severityLabel, target: view.target };
}

/** 가장 심한 것 — 같으면 받은 순서의 앞. */
function worstOf(firing: StatusResourceFiring[]): StatusResourceFiring | null {
  return firing.reduce<StatusResourceFiring | null>(
    (worst, candidate) => (worst === null || severityWeight(candidate.severity) > severityWeight(worst.severity) ? candidate : worst), null);
}

/** 서버 자원 화면의 현재 값(MetricReading)에서 요약에 쓰는 칸만. */
function summaryValue(reading: MetricReading): StatusResourceValue {
  return { state: reading.state, value: reading.value, text: reading.text };
}

export function statusResourcesFromLatest(latest: LatestResources): StatusResourcesSummary {
  const screenHref = resourcesHref({ range: "1h", container: null });
  const sorted = [...latest.servers].sort((left, right) => byCharacterCode(left.server, right.server));
  const shown = sorted.slice(0, STATUS_RESOURCE_SERVER_LIMIT);
  const shownNames = new Set(shown.map((server) => server.server));
  const firingRules = latest.firing ?? [];
  // 신선도 · 값 읽기는 서버 자원 화면의 규칙 그대로(freshnessOf · currentReadings) — 이 요약에는 자리마다 임계값을 붙이지 않는다
  const noFiring = serverFiringOf([]);
  const rows = shown.map((server): StatusResourceRow => {
    const freshness = freshnessOf(server, null);
    const readings = currentReadings(server, noFiring);
    const firing = firingRules.filter((rule) => rule.server === server.server).map(statusFiring);
    return {
      server: server.server,
      href: `${screenHref}#${STATUS_RESOURCE_ANCHOR_PREFIX}${server.server}`,
      freshness: { kind: freshness.kind, label: freshness.label, ageMilliseconds: freshness.ageMilliseconds } as StatusResourceFreshness,
      receivedAt: server.receivedAt,
      cpu: summaryValue(readings.cpu), memory: summaryValue(readings.memory), disk: summaryValue(readings.disk),
      firingCount: firing.length, worstFiring: worstOf(firing), firing,
    };
  });
  const elsewhereFiring = firingRules.filter((rule) => !shownNames.has(rule.server)).map((rule) => ({ ...statusFiring(rule), server: rule.server }));
  return {
    rows, hiddenServerCount: sorted.length - shown.length, unreadableServerNameCount: latest.unreadableServerNameCount, firingKnown: latest.firing !== null,
    elsewhereFiringCount: elsewhereFiring.length, elsewhereFiring, screenHref,
  };
}

/** latest 한 번 → 요약. 거부(reject)하지 않는다 — 해석 중 뜻밖의 예외는 unparseable. */
export async function collectStatusResources(options: StatusResourcesOptions): Promise<UpstreamResult<StatusResourcesSummary>> {
  try {
    // 설정이 없으면 클라이언트가 호출 없이 not_configured 를 돌려준다
    const client = createResourceMetricsClient({ baseUrl: options.observeUrl, secret: options.observeSecret, fetch: options.fetch, timeoutSignal: options.timeoutSignal });
    const latest = await client.latest();
    if (!latest.ok) return latest;
    return { ok: true, value: statusResourcesFromLatest(latest.value) };
  } catch {
    return upstreamFailure("unparseable");
  }
}

/** 기존 다섯 호출(collectStatusOverview)과 자원 요약을 한꺼번에 시작해 둘 다 끝나면 묶는다. */
export async function collectStatusScreen(options: StatusScreenOptions): Promise<StatusScreenData> {
  const { observeSecret, ...overviewOptions } = options;
  const [overview, resources] = await Promise.all([
    collectStatusOverview(overviewOptions),
    collectStatusResources({ observeUrl: options.observeUrl, observeSecret, fetch: options.fetch, timeoutSignal: options.timeoutSignal }),
  ]);
  return { overview, resources };
}

function problemLabel(server: string, firing: StatusResourceFiring): string {
  const target = firing.target === null ? "" : ` ${firing.target}`;
  return `서버 ${server} ${firing.ruleLabel}${target}(${firing.severityLabel})`;
}

export function statusResourceSummaryItems(resources: UpstreamResult<StatusResourcesSummary>): StatusResourceSummaryItems {
  if (!resources.ok) return { problems: [], unreachable: [{ label: "서버 자원" }] };
  const summary = resources.value;
  // §18 — 오래된 값 · 수신 없음 · 신선도를 모르는 줄은 알림이 아직 울리지 않았어도 "확인 못 함"(줄 순서)
  const freshness = summary.rows.filter((row) => row.freshness.kind !== "fresh").map((row) => ({ label: `서버 ${row.server} ${row.freshness.label}` }));
  if (!summary.firingKnown) return { problems: [], unreachable: [{ label: "서버 자원 임계값" }, ...freshness] };
  const problems = [
    ...summary.rows.flatMap((row) => row.firing.map((firing) => ({ label: problemLabel(row.server, firing) }))),
    ...summary.elsewhereFiring.map((firing) => ({ label: problemLabel(firing.server, firing) })),
  ];
  return { problems, unreachable: freshness };
}
