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
 * - 그 서비스 컨테이너(값을 보일 하나): SERVICE_CONTAINER_NAMES[서비스], 표에 없으면 `<서비스>-app`(자리 전환을 하는 앱 컨테이너 — 각 저장소의 docker-compose.yml).
 * 서버 고르기(서비스의 컨테이너가 보인 서버 중):
 *   ① 그 서비스 컨테이너가 보인 서버 ② 서비스의 컨테이너 중 last_seen_at 이 가장 늦은 서버 ③ 서버 이름순 — 첫째를 고르고, 나머지는 alsoSeenOn(이름순).
 * location:
 * - latest 실패 → 그 실패(어느 서버였는지 확인하지 못함). 
 * - 고른 서버가 있음 → found(containers 가 실패한 서버는 uncheckedServers — 이름순).
 * - 못 찾음 + containers 가 하나라도 실패 → unknown(failedServers — 이름순) — "어느 서버였는지 확인하지 못함".
 * - 못 찾음 + 전부 답함(서버가 0 대인 것 포함) → none — "기록 없음"(보관 기간 밖 · 수집 전).
 * host · container: 못 찾았으면 둘 다 null(호출 없음). 찾았으면 host 는 계열 결과, container 는 그 서비스 컨테이너가 그 서버에 보였을 때만 계열 결과(아니면 null).
 * 계열 하나(TraceSeriesView): 관측 서버가 고른 step_ms · source 를 그대로(7일보다 오래된 로그는 rollup — 5분 평균). 점이 0 개면 noRecord true("기록 없음").
 * 값(TraceValueView — 아래 순서):
 * - host: CPU(percent · cpu_pct) · 메모리(percent · mem_used ÷ mem_total × 100) · 디스크(percent · disk_used ÷ disk_total × 100).
 * - container: CPU(percent · cpu_pct — 코어 하나 = 100, 100 을 넘을 수 있다) · 메모리(bytes · mem_used).
 * - atLogValue: [at, at + step) 에 T 가 드는 점의 평균(없으면 null). maximumValue: 점들의 `_max`(백분율 값은 used_max ÷ 그 점의 total 평균) 중 최대,
 *   `_max` 가 하나도 없으면 평균의 최대(없으면 null). 글자는 formatPercent · formatBytes(없으면 "없음"). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { formatBytes, formatPercent } from "@/features/resources/lib/resource-format";
import {
  createResourceMetricsClient, type ResourceMetricsClient, type ResourceSeries, type ResourceSeriesSource, type SeenContainers, type SeriesPoint,
} from "@/features/resources/lib/resource-metrics-client";
import { byCharacterCode, usedPercent } from "@/features/resources/lib/resources-screen";
import { parseIsoUtc } from "@/shared/lib/query-input";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const TRACE_RESOURCE_WINDOW_MILLISECONDS = 5 * 60 * 1000;
export const TRACE_RESOURCE_SERVER_LIMIT = 10;
export const TRACE_RESOURCE_MAXIMUM_CALLS = 1 + TRACE_RESOURCE_SERVER_LIMIT + 2;
/** 자원 칸 전체의 시간 상한(§18) — 넘으면 location 이 timeout, host · container 는 null. 뼈대 — §18 구현 전(아직 쓰지 않는다). */
export const TRACE_RESOURCE_TOTAL_TIMEOUT_MILLISECONDS = 8_000;

/** 서비스 → 값을 보일 컨테이너의 계열 이름(자리 전환을 하는 앱 컨테이너 — front · backend · alert · observe · admin 은 `<서비스>-app-blue|green`,
 * llm 은 `llm-wrapper-blue|green` — 각 저장소 docker-compose.yml 의 container_name). */
export const SERVICE_CONTAINER_NAMES: Readonly<Record<string, string>> = {
  front: "front-app", backend: "backend-app", llm: "llm-wrapper", alert: "alert-app", observe: "observe-app", admin: "admin-app",
};

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
  return seriesName === service || seriesName.startsWith(`${service}-`);
}

/** 값을 보일 그 서비스 컨테이너의 계열 이름. */
export function serviceContainerName(service: string): string {
  return Object.hasOwn(SERVICE_CONTAINER_NAMES, service) ? SERVICE_CONTAINER_NAMES[service] : `${service}-app`;
}

/** 1단계의 결과 — latest 실패면 그 실패, 아니면 서버마다 containers(서버, T) 의 결과(이름순). */
type ServerSightings = UpstreamResult<{ server: string; seen: UpstreamResult<SeenContainers> }[]>;

async function sightingsAt(client: ResourceMetricsClient, atMilliseconds: number): Promise<ServerSightings> {
  const latest = await client.latest();
  if (!latest.ok) return latest;
  // 지금의 컨테이너(latest.containers)는 보지 않는다 — 서버 이름만 쓰고, 그때의 위치는 containers(서버, T) 로 묻는다
  const servers = latest.value.servers.map((server) => server.server).sort(byCharacterCode).slice(0, TRACE_RESOURCE_SERVER_LIMIT);
  const seen = await Promise.all(servers.map((server) => client.containers(server, atMilliseconds)));
  return { ok: true, value: servers.map((server, index) => ({ server, seen: seen[index] })) };
}

interface Candidate {
  server: string;
  containers: string[];
  hasServiceContainer: boolean;
  lastSeenMilliseconds: number;
}

function locate(sightings: { server: string; seen: UpstreamResult<SeenContainers> }[], service: string): TraceServerLocation {
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
  if (candidates.length === 0) return failedServers.length > 0 ? { kind: "unknown", failedServers, skippedServerCount: 0, unreadableServerNameCount: 0 } : { kind: "none" };   // 뼈대 — §18 구현 전
  // ① 그 서비스 컨테이너가 보인 서버 ② last_seen_at 이 늦은 서버 ③ 서버 이름순
  candidates.sort((left, right) => Number(right.hasServiceContainer) - Number(left.hasServiceContainer)
    || right.lastSeenMilliseconds - left.lastSeenMilliseconds || byCharacterCode(left.server, right.server));
  const [chosen, ...others] = candidates;
  return {
    kind: "found", server: chosen.server, matchedBy: "container", skippedServerCount: 0, unreadableServerNameCount: 0,   // 뼈대 — §18 구현 전
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

function maximumOf(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

function traceValue(series: ResourceSeries, spec: TraceValueSpec, atMilliseconds: number): TraceValueView {
  // 로그 시각이 든 점 — [at, at + step)(5분 평균의 첫 점은 from 보다 앞설 수 있다 — 버리지 않는다)
  const atLogPoint = series.points.find((point) => point.atMilliseconds <= atMilliseconds && atMilliseconds < point.atMilliseconds + series.stepMilliseconds);
  const atLogValue = atLogPoint === undefined ? null : pointValue(atLogPoint, spec, "average");
  const maximumValue = maximumOf(series.points.map((point) => pointValue(point, spec, "maximum")))
    ?? maximumOf(series.points.map((point) => pointValue(point, spec, "average")));
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

export async function collectTraceResources(options: TraceResourcesOptions): Promise<TraceResourcesView | null> {
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
