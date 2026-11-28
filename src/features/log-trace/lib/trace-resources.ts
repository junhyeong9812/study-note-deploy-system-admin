/** 연관 로그 "그때 서버 상태"의 자원 칸(순수 — 설정은 options 로, 거부(reject)하지 않는다). 명세 §2.6 "그 로그를 남긴 서비스가 있는 서버의 앞뒤 5분 자원 수치
 * (CPU · 메모리 · 그 서비스 컨테이너의 CPU · 메모리) 구역을 더한다. 값이 없으면(보관 기간 밖 · 수집 전) '기록 없음'" · §10.4 "로그의 service 이름으로 시작하는
 * 컨테이너(front → front-app)가 보인 서버를 고른다. 못 찾으면 그 구역은 '기록 없음'" · §11.5 "GET /metrics/containers?server=&at= 에 시각을 주면 그 시각 앞뒤 5분에
 * 보인 컨테이너만 답한다. 어드민은 로그 시각으로 물어 그때 그 서비스가 있던 서버를 고른다(지금의 위치로 짐작하지 않는다)" · §11.6 · §15.1(5분 평균의 첫 점).
 *
 * 기존 LogTraceView · ServerStateAround 의 꼴은 바꾸지 않는다(server/log-trace.test.ts:140,145 가 칸 이름을 고정한다) — 이 칸은 따로 돌려준다.
 * 클라이언트는 createResourceMetricsClient 그대로(실패 종류 · 비밀값 비노출 · 본문 상한은 그 클라이언트의 것).
 *
 * 기준 시각 T = atMilliseconds(로그 id 의 밀리초). 창 = [T − 5분, T + 5분](TRACE_RESOURCE_WINDOW_MILLISECONDS, 자르지 않는다).
 * 호출(관측 서버, 각 5초):
 * 1. 곧바로(서비스를 기다리지 않는다): latest() → 그 서버 목록(이름순, 앞 TRACE_RESOURCE_SERVER_LIMIT 대)마다 containers(서버, T) 를 한꺼번에.
 *    latest 의 서버는 "수신 없음"이어도 묻는다(그 로그의 시각에는 보냈을 수 있다 — §16 마지막 수신 기록이 있는 서버도 목록에 든다).
 * 2. options.service 가 풀리면: null 이면(고른 로그를 확인하지 못함) 곧바로 null 을 돌려준다(이미 시작한 호출의 결과는 버린다 · 계열 조회 없음).
 *    서비스가 있으면 1 이 끝나기를 기다려 서버를 고르고, 찾았으면 series(host, 창) 와 (그 서비스 컨테이너가 그 서버에 보였으면) series(container, 계열 이름, 창) 를 한꺼번에.
 * 호출 수의 상한: 1 + TRACE_RESOURCE_SERVER_LIMIT + 2 = TRACE_RESOURCE_MAXIMUM_CALLS.
 * 설정(observeUrl 이 http(s) 가 아니거나 observeSecret 이 빔)이 없으면 호출 없이 location 이 not_configured(서비스가 null 이면 null).
 *
 * 서비스 ↔ 컨테이너(계열 이름 — 자리 이름을 뗀 것)의 맞춤:
 * - 그 서비스의 컨테이너: 계열 이름이 서비스와 같거나 `<서비스>-` 로 시작(§10.4 "service 이름으로 시작" — `-` 경계를 둔다: front 는 frontier 를 잡지 않는다).
 *   예외 — 컨테이너 이름이 고정된 서비스(FIXED_SERVICE_CONTAINER_NAMES): 그 이름과 같거나 `<그 이름>-` 로 시작하는 것만. `claude` 는 단일 컨테이너
 *   `claude-runner` 뿐이고, 옛 통로의 중계 `claude-bridge-relay` 는 claude 의 컨테이너가 아니다(잡으면 backend 와 같은 서버가 `[backend, claude]` 로 보인다).
 *   실행 자리를 backend 와 같은 서버에 올리면 그 서버의 서비스가 둘이라 자원 임계값 문제에 조치 링크가 나오지 않는다(정한 규칙의 결과).
 * - 그 서비스 컨테이너(값을 보일 하나): SERVICE_CONTAINER_NAMES[서비스], 표에 없으면 `<서비스>-app`(자리 전환을 하는 앱 컨테이너 — 각 저장소의 docker-compose.yml).
 * 서버 고르기(서비스의 컨테이너가 보인 서버 중):
 *   ① 그 서비스 컨테이너가 보인 서버 ② 서비스의 컨테이너 중 last_seen_at 이 가장 늦은 서버 ③ 서버 이름순 — 첫째를 고르고, 나머지는 alsoSeenOn(이름순).
 * location:
 * - latest 실패 → 그 실패(어느 서버였는지 확인하지 못함). 
 * - 서비스 이름이 latest 의 서버 이름과 같음 → found matchedBy "serverName"(그 서버의 서버 자원 · 컨테이너 칸 없음 — §18 배포 에이전트 · 마스터).
 * - 고른 서버가 있음 → found matchedBy "container"(containers 가 실패한 서버는 uncheckedServers — 이름순).
 * - 못 찾음 + containers 가 하나라도 실패 · 상한 밖이라 묻지 않은 서버가 있음 · 이름을 읽지 못한 서버 줄이 있음 → unknown — "어느 서버였는지 확인하지 못함"(§18).
 * - 못 찾음 + 전부 묻고 전부 답함(서버가 0 대인 것 포함) → none — "기록 없음"(까닭은 단정하지 않는다).
 * found · unknown 에는 skippedServerCount(상한 밖) · unreadableServerNameCount(latest 에서 이름을 읽지 못한 줄)를 싣는다 — 조용히 자르지 않는다.
 * 칸 전체에 TRACE_RESOURCE_TOTAL_TIMEOUT_MILLISECONDS(8초) 상한 — 넘으면 location timeout · host · container null.
 * host · container: 못 찾았으면 둘 다 null(호출 없음). 찾았으면 host 는 계열 결과, container 는 그 서비스 컨테이너가 그 서버에 보였을 때만 계열 결과(아니면 null).
 * 계열 하나(TraceSeriesView): 관측 서버가 고른 step_ms · source 를 그대로(7일보다 오래된 로그는 rollup — 5분 평균). 점이 0 개면 noRecord true("기록 없음").
 * 값(TraceValueView — 아래 순서):
 * - host: CPU(percent · cpu_pct) · 메모리(percent · mem_used ÷ mem_total × 100) · 디스크(percent · disk_used ÷ disk_total × 100).
 * - container: CPU(percent · cpu_pct — 코어 하나 = 100, 100 을 넘을 수 있다) · 메모리(bytes · mem_used).
 * - atLogValue: [at, at + step) 에 T 가 드는 점의 평균(없으면 null). maximumValue: 점마다 `_max`(백분율 값은 used_max ÷ 그 점의 total 평균),
 *   그 점에 `_max` 가 없으면 그 점의 평균을 후보로 한 최대(없으면 null — §18, pointsMaximum). 글자는 formatPercent · formatBytes(없으면 "없음"). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { formatBytes, formatPercent } from "@/features/resources/lib/resource-format";
import {
  createResourceMetricsClient, type ResourceMetricsClient, type ResourceSeries, type ResourceSeriesSource, type SeenContainers, type SeriesPoint,
} from "@/features/resources/lib/resource-metrics-client";
import { byCharacterCode, pointsMaximum, usedPercent } from "@/features/resources/lib/resources-screen";
import { parseIsoUtc } from "@/shared/lib/query-input";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const TRACE_RESOURCE_WINDOW_MILLISECONDS = 5 * 60 * 1000;
export const TRACE_RESOURCE_SERVER_LIMIT = 10;
export const TRACE_RESOURCE_MAXIMUM_CALLS = 1 + TRACE_RESOURCE_SERVER_LIMIT + 2;
/** 자원 칸 전체의 시간 상한(§18) — 넘으면 location 이 timeout, host · container 는 null(기존 구역은 그대로 — 이 칸만). */
export const TRACE_RESOURCE_TOTAL_TIMEOUT_MILLISECONDS = 8_000;

/** 서비스 → 값을 보일 컨테이너의 계열 이름(자리 전환을 하는 앱 컨테이너 — front · backend · alert · observe · admin 은 `<서비스>-app-blue|green`,
 * llm 은 `llm-wrapper-blue|green` — 각 저장소 docker-compose.yml 의 container_name). */
export const SERVICE_CONTAINER_NAMES: Readonly<Record<string, string>> = {
  front: "front-app", backend: "backend-app", llm: "llm-wrapper", alert: "alert-app", observe: "observe-app", admin: "admin-app", claude: "claude-runner",
};

/** 컨테이너 이름이 고정된 서비스 → 그 이름(compose 의 container_name). 이 표의 서비스는 서비스 이름이 아니라 이 이름으로 컨테이너를 가른다.
 * 다른 서비스는 SERVICE_CONTAINER_NAMES 로 가르지 않는다 — 앱 컨테이너 밖의 컨테이너(backend-embedding · observe-postgres 등)도 그 서비스의 것이다. */
const FIXED_SERVICE_CONTAINER_NAMES: Readonly<Record<string, string>> = { claude: "claude-runner" };

export const TRACE_RESOURCE_TEXT = {
  noRecord: "기록 없음",
  unknownServer: "어느 서버였는지 확인하지 못함",
} as const;

export type TraceServerLocation =
  | {
    kind: "found"; server: string;
    /** "container" — 그 서비스의 컨테이너가 보인 서버 · "serverName" — 서비스 이름이 latest 의 서버 이름과 같음(§18 — 컨테이너 칸은 해당 없음) */
    matchedBy: "container" | "serverName";
    serviceContainer: string | null; containers: string[]; alsoSeenOn: string[]; uncheckedServers: string[];
    /** 상한(TRACE_RESOURCE_SERVER_LIMIT) 밖이라 묻지 않은 서버 수(§18) */
    skippedServerCount: number;
    /** latest 에서 이름을 읽지 못한 서버 줄의 수(§18) */
    unreadableServerNameCount: number;
  }
  | { kind: "none" }
  | { kind: "unknown"; failedServers: string[]; skippedServerCount: number; unreadableServerNameCount: number };

export interface TraceValueView {
  label: string;
  unit: "percent" | "bytes";
  atLogValue: number | null;
  atLogText: string;
  maximumValue: number | null;
  maximumText: string;
}

export interface TraceSeriesView {
  source: ResourceSeriesSource | null;
  stepMilliseconds: number;
  pointCount: number;
  noRecord: boolean;
  values: TraceValueView[];
}

export interface TraceResourcesView {
  service: string;
  atMilliseconds: number;
  fromMilliseconds: number;
  toMilliseconds: number;
  location: UpstreamResult<TraceServerLocation>;
  host: UpstreamResult<TraceSeriesView> | null;
  container: UpstreamResult<TraceSeriesView> | null;
}

// ── 화면(TraceResourcesBlock)과 글(문제 화면의 근거 글)이 같이 쓰는 판정 · 문구 ──────────────

const ROLLUP_STEP_MILLISECONDS = 5 * 60 * 1000;
/** readsRollup 일 때 덧붙이는 글. */
export const TRACE_ROLLUP_TEXT = "5분 평균 값(고른 로그가 7일보다 오래됨)";

/** 5분 평균(고른 로그가 7일보다 오래됨)에서 읽은 값인가 — 서버 · 컨테이너 계열 가운데 하나라도 source 가 rollup · mixed 이거나 step 이 5분 이상. */
export function readsRollup(resources: TraceResourcesView): boolean {
  const isRollup = (series: UpstreamResult<TraceSeriesView> | null) => series !== null && series.ok
    && (series.value.source === "rollup" || series.value.source === "mixed" || series.value.stepMilliseconds >= ROLLUP_STEP_MILLISECONDS);
  return isRollup(resources.host) || isRollup(resources.container);
}

/** 묻지 못한 · 묻지 않은(상한 밖) · 이름을 읽지 못한 서버 — 조용히 자르지 않는다(§18). */
function uncheckedServerParts(failedServers: string[], skippedServerCount: number, unreadableServerNameCount: number): string[] {
  return [
    ...(failedServers.length > 0 ? [`서버 ${failedServers.join(" · ")} 에 묻지 못했습니다`] : []),
    ...(skippedServerCount > 0 ? [`확인하지 못한 서버 ${skippedServerCount}대(묻는 서버는 앞 ${TRACE_RESOURCE_SERVER_LIMIT}대까지)`] : []),
    ...(unreadableServerNameCount > 0 ? [`이름을 읽지 못한 서버 ${unreadableServerNameCount}대`] : []),
  ];
}

/** 고른 서버의 덧붙임 줄(끝의 마침표 없이 — 없으면 []): 같은 서비스가 보인 다른 서버 · 확인하지 못한 서버 · 묻지 않은 서버 수 · 이름을 읽지 못한 서버 수. */
export function foundLocationNotes(location: Extract<TraceServerLocation, { kind: "found" }>): string[] {
  const unchecked = uncheckedServerParts(location.uncheckedServers, location.skippedServerCount, location.unreadableServerNameCount);
  return [
    ...(location.alsoSeenOn.length > 0 ? [`같은 서비스가 서버 ${location.alsoSeenOn.join(" · ")} 에도 보였습니다`] : []),
    // 확인하지 못한 서버는 "는 확인하지 못함" 으로 적으므로 "에 묻지 못했습니다" 부분은 뺀다
    ...(location.uncheckedServers.length > 0 ? [`서버 ${location.uncheckedServers.join(" · ")} 는 확인하지 못함`, ...unchecked.slice(1)] : unchecked),
  ];
}

/** 어느 서버였는지 확인하지 못함 — <묻지 못한 · 묻지 않은 · 이름을 읽지 못한 서버>(끝의 마침표 없이). */
export function unknownLocationText(location: Extract<TraceServerLocation, { kind: "unknown" }>): string {
  return `${TRACE_RESOURCE_TEXT.unknownServer} — ${uncheckedServerParts(location.failedServers, location.skippedServerCount, location.unreadableServerNameCount).join(" · ")}`;
}

export interface TraceResourcesOptions {
  observeUrl: string;
  observeSecret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
  atMilliseconds: number;
  /** 고른 로그의 서비스 — 고른 로그를 확인하지 못하면 null 로 풀린다 */
  service: Promise<string | null>;
}

/** 그 서비스의 컨테이너인가(계열 이름 기준). */
export function containerBelongsToService(seriesName: string, service: string): boolean {
  const prefix = Object.hasOwn(FIXED_SERVICE_CONTAINER_NAMES, service) ? FIXED_SERVICE_CONTAINER_NAMES[service] : service;
  return seriesName === prefix || seriesName.startsWith(`${prefix}-`);
}

/** 값을 보일 그 서비스 컨테이너의 계열 이름. */
export function serviceContainerName(service: string): string {
  return Object.hasOwn(SERVICE_CONTAINER_NAMES, service) ? SERVICE_CONTAINER_NAMES[service] : `${service}-app`;
}

/** 1단계의 결과 — latest 실패면 그 실패, 아니면 서버마다 containers(서버, T) 의 결과(이름순)와 묻지 않은 · 읽지 못한 서버 수. */
interface ServerSightingsValue {
  sightings: { server: string; seen: UpstreamResult<SeenContainers> }[];
  /** latest 의 서버 이름 전부(서비스 이름이 서버 이름인 로그를 가리려고 — 상한과 상관없이) */
  serverNames: string[];
  /** 상한(TRACE_RESOURCE_SERVER_LIMIT) 밖이라 묻지 않은 서버 수 */
  skippedServerCount: number;
  unreadableServerNameCount: number;
}
type ServerSightings = UpstreamResult<ServerSightingsValue>;

async function sightingsAt(client: ResourceMetricsClient, atMilliseconds: number): Promise<ServerSightings> {
  const latest = await client.latest();
  if (!latest.ok) return latest;
  // 지금의 컨테이너(latest.containers)는 보지 않는다 — 서버 이름만 쓰고, 그때의 위치는 containers(서버, T) 로 묻는다
  const serverNames = latest.value.servers.map((server) => server.server).sort(byCharacterCode);
  const servers = serverNames.slice(0, TRACE_RESOURCE_SERVER_LIMIT);
  const seen = await Promise.all(servers.map((server) => client.containers(server, atMilliseconds)));
  return { ok: true, value: {
    sightings: servers.map((server, index) => ({ server, seen: seen[index] })), serverNames,
    skippedServerCount: serverNames.length - servers.length, unreadableServerNameCount: latest.value.unreadableServerNameCount,
  } };
}

interface Candidate {
  server: string;
  containers: string[];
  hasServiceContainer: boolean;
  lastSeenMilliseconds: number;
}

function locate(found: ServerSightingsValue, service: string): TraceServerLocation {
  const { sightings, skippedServerCount, unreadableServerNameCount } = found;
  // 서비스 이름이 서버 이름인 로그(배포 에이전트 · 마스터 — §18): 그 서버의 서버 자원(컨테이너 칸은 해당 없음)
  if (found.serverNames.includes(service)) {
    return {
      kind: "found", server: service, matchedBy: "serverName", serviceContainer: null, containers: [], alsoSeenOn: [], uncheckedServers: [],
      skippedServerCount, unreadableServerNameCount,
    };
  }
  const wanted = serviceContainerName(service);
  const failedServers: string[] = [];
  const candidates: Candidate[] = [];
  for (const { server, seen } of sightings) {
    if (!seen.ok) {
      failedServers.push(server);
      continue;
    }
    const matched = seen.value.containers.filter((container) => containerBelongsToService(container.name, service));
    if (matched.length === 0) continue;
    candidates.push({
      server,
      containers: [...new Set(matched.map((container) => container.name))].sort(byCharacterCode),
      hasServiceContainer: matched.some((container) => container.name === wanted),
      lastSeenMilliseconds: Math.max(...matched.map((container) => parseIsoUtc(container.lastSeenAt) as number)),
    });
  }
  failedServers.sort(byCharacterCode);
  // 못 찾음 — 다 물었고 다 읽었을 때만 "기록 없음". 묻지 못한 · 묻지 않은(상한 밖) · 이름을 읽지 못한 서버가 있으면 거기 있었을 수 있다(§18)
  if (candidates.length === 0) {
    return failedServers.length > 0 || skippedServerCount > 0 || unreadableServerNameCount > 0
      ? { kind: "unknown", failedServers, skippedServerCount, unreadableServerNameCount } : { kind: "none" };
  }
  // ① 그 서비스 컨테이너가 보인 서버 ② last_seen_at 이 늦은 서버 ③ 서버 이름순
  candidates.sort((left, right) => Number(right.hasServiceContainer) - Number(left.hasServiceContainer)
    || right.lastSeenMilliseconds - left.lastSeenMilliseconds || byCharacterCode(left.server, right.server));
  const [chosen, ...others] = candidates;
  return {
    kind: "found", server: chosen.server, matchedBy: "container", skippedServerCount, unreadableServerNameCount,
    serviceContainer: chosen.hasServiceContainer ? wanted : null, containers: chosen.containers,
    alsoSeenOn: others.map((candidate) => candidate.server).sort(byCharacterCode), uncheckedServers: failedServers,
  };
}

interface TraceValueSpec {
  label: string;
  unit: TraceValueView["unit"];
  valueName: string;
  /** 있으면 점 값 = 값 ÷ 그 점의 이 값(평균) × 100 */
  totalName: string | null;
}

const HOST_VALUE_SPECS: TraceValueSpec[] = [
  { label: "CPU", unit: "percent", valueName: "cpu_pct", totalName: null },
  { label: "메모리", unit: "percent", valueName: "mem_used", totalName: "mem_total" },
  { label: "디스크", unit: "percent", valueName: "disk_used", totalName: "disk_total" },
];

const CONTAINER_VALUE_SPECS: TraceValueSpec[] = [
  { label: "CPU", unit: "percent", valueName: "cpu_pct", totalName: null },
  { label: "메모리", unit: "bytes", valueName: "mem_used", totalName: null },
];

function pointValue(point: SeriesPoint, spec: TraceValueSpec, role: "average" | "maximum"): number | null {
  const value = point.values[spec.valueName]?.[role] ?? null;
  return spec.totalName === null ? value : usedPercent(value, point.values[spec.totalName]?.average ?? null);
}

function traceValue(series: ResourceSeries, spec: TraceValueSpec, atMilliseconds: number): TraceValueView {
  // 로그 시각이 든 점 — [at, at + step)(5분 평균의 첫 점은 from 보다 앞설 수 있다 — 버리지 않는다)
  const atLogPoint = series.points.find((point) => point.atMilliseconds <= atMilliseconds && atMilliseconds < point.atMilliseconds + series.stepMilliseconds);
  const atLogValue = atLogPoint === undefined ? null : pointValue(atLogPoint, spec, "average");
  const maximumValue = pointsMaximum(series.points.map((point) => ({ average: pointValue(point, spec, "average"), maximum: pointValue(point, spec, "maximum") })));
  const format = spec.unit === "percent" ? formatPercent : formatBytes;
  return { label: spec.label, unit: spec.unit, atLogValue, atLogText: format(atLogValue), maximumValue, maximumText: format(maximumValue) };
}

function traceSeries(result: UpstreamResult<ResourceSeries>, specs: TraceValueSpec[], atMilliseconds: number): UpstreamResult<TraceSeriesView> {
  if (!result.ok) return result;
  try {
    const series = result.value;
    return { ok: true, value: {
      source: series.source, stepMilliseconds: series.stepMilliseconds, pointCount: series.points.length, noRecord: series.points.length === 0,
      values: specs.map((spec) => traceValue(series, spec, atMilliseconds)),
    } };
  } catch {
    return upstreamFailure("unparseable");
  }
}

/** 자원 칸 전체에 TRACE_RESOURCE_TOTAL_TIMEOUT_MILLISECONDS 상한(§18) — 넘으면 이 칸만 location timeout(host · container null).
 * 버려진 호출은 각자의 5초 기한으로 끝나고, 뒤늦게 끝나도 돌려준 값은 바꾸지 않는다(새 값을 만들 뿐 — 돌려준 것과 공유하지 않는다). 타이머는 끝나면 치운다.
 * 서비스가 null 이면 상한과 상관없이 null. 상한에 닿을 때 서비스가 아직 정해지지 않았으면 null(고른 로그를 확인하지 못한 것과 같다). */
export async function collectTraceResources(options: TraceResourcesOptions): Promise<TraceResourcesView | null> {
  let settledService: string | null | undefined;
  const service = options.service.catch(() => null).then((value) => { settledService = value; return value; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<TraceResourcesView | null>((resolve) => {
    timer = setTimeout(() => {
      if (typeof settledService !== "string") { resolve(null); return; }
      resolve({ ...traceWindow(settledService, options.atMilliseconds), location: upstreamFailure("timeout"), host: null, container: null });
    }, TRACE_RESOURCE_TOTAL_TIMEOUT_MILLISECONDS);
  });
  try {
    return await Promise.race([collectWithinCap({ ...options, service }), capped]);
  } finally {
    clearTimeout(timer);
  }
}

function traceWindow(service: string, atMilliseconds: number): Pick<TraceResourcesView, "service" | "atMilliseconds" | "fromMilliseconds" | "toMilliseconds"> {
  return {
    service, atMilliseconds,
    fromMilliseconds: atMilliseconds - TRACE_RESOURCE_WINDOW_MILLISECONDS, toMilliseconds: atMilliseconds + TRACE_RESOURCE_WINDOW_MILLISECONDS,
  };
}

async function collectWithinCap(options: TraceResourcesOptions): Promise<TraceResourcesView | null> {
  const { atMilliseconds } = options;
  const fromMilliseconds = atMilliseconds - TRACE_RESOURCE_WINDOW_MILLISECONDS;
  const toMilliseconds = atMilliseconds + TRACE_RESOURCE_WINDOW_MILLISECONDS;
  // 설정이 없으면 클라이언트가 호출 없이 not_configured 를 돌려준다
  const client = createResourceMetricsClient({ baseUrl: options.observeUrl, secret: options.observeSecret, fetch: options.fetch, timeoutSignal: options.timeoutSignal });
  // 1 — 서비스를 기다리지 않고 곧바로 서버 찾기를 시작한다(거부하지 않게 — 뜻밖의 예외는 unparseable)
  const sightings: Promise<ServerSightings> = sightingsAt(client, atMilliseconds).catch(() => upstreamFailure("unparseable"));
  // 2 — 서비스가 정해지면(null 이면 곧바로 끝 — 이미 시작한 호출의 결과는 버린다)
  const service = await options.service.catch(() => null);
  if (service === null) return null;
  const found = await sightings;
  let location: UpstreamResult<TraceServerLocation>;
  try {
    location = found.ok ? { ok: true, value: locate(found.value, service) } : found;
  } catch {
    location = upstreamFailure("unparseable");
  }
  if (!location.ok || location.value.kind !== "found") {
    return { service, atMilliseconds, fromMilliseconds, toMilliseconds, location, host: null, container: null };
  }
  const { server, serviceContainer } = location.value;
  const window = { fromMilliseconds, toMilliseconds };
  const [hostSeries, containerSeries] = await Promise.all([
    client.series({ server, scope: "host", name: null, ...window }),
    serviceContainer === null ? Promise.resolve(null) : client.series({ server, scope: "container", name: serviceContainer, ...window }),
  ]);
  return {
    service, atMilliseconds, fromMilliseconds, toMilliseconds, location,
    host: traceSeries(hostSeries, HOST_VALUE_SPECS, atMilliseconds),
    container: containerSeries === null ? null : traceSeries(containerSeries, CONTAINER_VALUE_SPECS, atMilliseconds),
  };
}
