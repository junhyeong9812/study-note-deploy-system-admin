/** 서버 자원 화면의 데이터(순수 — 설정은 options 로 받는다, 거부(reject)하지 않는다). 명세 §2.6 · §10.3 · §11.5 · §11.6 · §14 · §15 · §15.1 · §16.
 *
 * 호출(전부 관측 서버, 각 5초 — 클라이언트는 createResourceMetricsClient):
 * 1단계 — 한꺼번에 시작: latest() · (고른 컨테이너가 있으면) series({server, scope:"container", name, 기간}).
 * 2단계 — latest 가 성공하면 **끝나는 대로**(고른 컨테이너를 기다리지 않는다) 화면에 남긴 서버마다 host series 1회와
 *   그 서버의 latest.gpus 의 번호마다(앞 RESOURCE_GPU_GRAPH_LIMIT 개) gpu series 1회를 한꺼번에. 전체 소요 ≤ 5초 + 5초.
 *   latest 가 실패하면 2단계는 없다(서버 이름을 모른다) — servers 가 그 실패이고 고른 컨테이너는 그대로 보인다.
 * 설정(observeUrl 이 http(s) 가 아니거나 observeSecret 이 빔)이 없으면 호출 없이 servers · 고른 컨테이너 그래프가 not_configured.
 * 한 호출이 실패하면 그 칸만 실패(UpstreamResult) — 나머지는 그린다. 해석 중 뜻밖의 예외도 그 칸만 unparseable.
 * 실패를 앱 로그로 남길 때의 칸 이름(server/ 진입이 쓴다 — resourcesScreenFailures): `latest` · `host:<서버>` · `gpu:<서버>:<번호>` · `container`.
 *
 * 주소: rangeOptions 는 RESOURCE_RANGES 순서, href = resourcesHref({ range, container: query.container })(고른 컨테이너 유지), selected = 지금 기간.
 *   refreshHref = resourcesHref(query). 컨테이너 줄의 href = resourcesHref({ range: query.range, container: { server, container: seriesName } }),
 *   selected = query.container 의 server · container 가 그 서버 · seriesName 과 같음. 고른 컨테이너의 closeHref = resourcesHref({ range, container: null }).
 *   고른 컨테이너는 latest 에 없는 서버 · 이름이어도 그대로 조회한다(관측 서버가 답을 정한다 — 점이 없으면 "기록 없음").
 * 서버: latest 의 서버를 이름순(글자 코드 순)으로, 앞 RESOURCE_SERVER_LIMIT 대만 남긴다(그 밖은 hiddenServerCount 로 센다 — 조용히 버리지 않는다).
 * 신선도(§2.6 · §15 · §16):
 * - measuredAt 이 null → "never"(수신 없음 — 보일 값이 없다. 마지막 수신부터의 시간이 있으면 ageMilliseconds 에 담는다).
 * - stale 이 null(칸 없음) → "unknown"(확인하지 못함).
 * - stale true → "stale" — label `"<formatAge(age)> 값"`(age 를 모르면 "오래된 값"). 값은 보이되 지금 값처럼 보이지 않게.
 * - stale false → "fresh"(label null). ageMilliseconds 는 음수면 0.
 * 현재 값(MetricReading):
 * - 값이 있으면 state "value". host 가 null 이거나 그 값이 null 이면: 그 서버의 missing 에 "host" 가 있으면 "unread"("읽지 못함"), 아니면 "none"("없음").
 *   never 인 서버는 전부 "none". 값이 0 이면 "value"(0 은 실제 값이다).
 * - 메모리 · 디스크의 value 는 used ÷ total × 100(total 이 0 · null 이면 값 없음), detail 은 `"<used> / <total>"`(formatBytes).
 * 컨테이너: missing 에 "containers" 가 있으면 "unread", containers 가 null 이면 "unknown", 그 밖은 "listed"(빈 목록 포함) —
 *   줄은 seriesName 다음 name 의 글자 코드 순. truncated = missing 에 "containers_truncated". CPU 값은 100 을 넘을 수 있다.
 * GPU: missing 에 "gpus" 가 있으면 "unread"("GPU 값 없음" — §2.5), gpus 가 null 이면 "unknown", [] 이면 "absent"(GPU 없는 서버), 그 밖은 "listed".
 * 지금 울리는 임계값(firing — §2.4 · §14): latest.firing 이 null 이면 firingKnown false(어디에도 붙이지 않는다).
 *   그 서버의 줄은 받은 순서 그대로 server.firing 에 전부. 그리고 그 자리에 붙인다: disk_warning · disk_critical → 디스크(둘이면 critical),
 *   memory → 메모리, cpu → CPU, restarts → 실제 이름(name)이 target 과 같은 컨테이너 줄, silent → 신선도.
 *   화면에 남긴 서버에 없는 firing 은 firingElsewhere 로(버리지 않는다).
 * 그래프(GraphView): 기간의 from · to, 관측 서버가 고른 step_ms · source 를 그대로. 선은 평균(role average)과 `_max`(role maximum).
 *   CPU · 메모리 · 디스크 · GPU 는 percent 축, 네트워크 · 디스크 입출력 · 컨테이너 메모리는 auto, 컨테이너 CPU 는 auto(minimumTop 100).
 *   메모리 · 디스크 · GPU 메모리의 점 값 = used ÷ 그 점의 total(평균) × 100 — 최댓값 선은 used_max ÷ total(평균) × 100.
 *   그래프 표(제목 · 단위 · 축 · 선 — 선은 [key, label, role], 평균 선 다음 최댓값 선, 아래 순서 그대로):
 *   - host  CPU            percent        percent  [cpu_pct, 평균] [cpu_pct_max, 최댓값]
 *   - host  메모리          percent        percent  [mem_used, 평균] [mem_used_max, 최댓값]
 *   - host  디스크          percent        percent  [disk_used, 평균] [disk_used_max, 최댓값]
 *   - host  네트워크        bytesPerSecond auto     [net_rx_bps, 수신] [net_tx_bps, 송신] [net_rx_bps_max, 수신 최댓값] [net_tx_bps_max, 송신 최댓값]
 *   - host  디스크 입출력   bytesPerSecond auto     [io_read_bps, 읽기] [io_write_bps, 쓰기] [io_read_bps_max, 읽기 최댓값] [io_write_bps_max, 쓰기 최댓값]
 *   - gpu   GPU <번호> 사용률 percent      percent  [util_pct, 평균] [util_pct_max, 최댓값]
 *   - gpu   GPU <번호> 메모리 percent      percent  [mem_used, 평균] [mem_used_max, 최댓값]
 *   - container <이름> CPU   percent        auto(minimumTop 100) [cpu_pct, 평균] [cpu_pct_max, 최댓값]
 *   - container <이름> 메모리 bytes         auto     [mem_used, 평균] [mem_used_max, 최댓값]
 *   차트는 buildChartGeometry({ 기간의 from · to, step_ms, 축, RESOURCE_CHART_WIDTH, RESOURCE_CHART_HEIGHT, 선 }) 의 결과 그대로.
 *   글 요약(그림만으로 전하지 않는다): 평균 선마다 latest = 값이 있는 마지막 점의 평균, maximum = 짝인 최댓값 선의 최대(그 선에 값이 없으면 평균 선의 최대),
 *   summary = `"<제목> <기간 이름>: "` + 평균 선마다 `"<선 이름> 최근 <값> · 최댓값 <값>"`(값은 그 단위의 resource-format 글자)을 `" / "` 로 이은 것.
 *   점이 없으면 `"<제목> <기간 이름>: 기록 없음"`(lineSummaries 의 값은 null). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { buildChartGeometry, type ChartAxis, type ChartGeometry, type ChartLineRole } from "@/features/resources/lib/resource-chart";
import { formatAge, formatBytes, formatBytesPerSecond, formatCelsius, formatPercent } from "@/features/resources/lib/resource-format";
import {
  createResourceMetricsClient, type ContainerLatest, type FiringRule, type GpuLatest, type LatestResources, type ResourceMetricsClient,
  type ResourceScope, type ResourceSeries, type ResourceSeriesSource, type ServerLatest,
} from "@/features/resources/lib/resource-metrics-client";
import {
  RESOURCE_RANGES, RESOURCE_RANGE_LABELS, resourcesHref, resourcesWindow, type ContainerSelection, type ResourceRange, type ResourcesQuery, type ResourcesWindow,
} from "@/features/resources/lib/resources-query";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

/** 화면에 남기는 서버 수(이 프로젝트는 세 대 — 응답이 이상하게 커도 호출 수를 묶는다). */
export const RESOURCE_SERVER_LIMIT = 10;
/** 서버마다 그래프를 그리는 GPU 수. */
export const RESOURCE_GPU_GRAPH_LIMIT = 4;
export const RESOURCE_CHART_WIDTH = 600;
export const RESOURCE_CHART_HEIGHT = 160;

export const RESOURCE_TEXT = {
  none: "없음",
  unread: "읽지 못함",
  unknown: "확인하지 못함",
  never: "수신 없음",
  staleWithoutAge: "오래된 값",
  noRecord: "기록 없음",
  gpuUnread: "GPU 값 없음",
  gpuAbsent: "GPU 없음",
} as const;

/** 규칙 낱말 → 이름(모르는 낱말은 낱말 그대로). */
export const FIRING_RULE_LABELS: Readonly<Record<string, string>> = {
  disk_warning: "디스크 경고",
  disk_critical: "디스크 위험",
  memory: "메모리",
  cpu: "CPU",
  restarts: "컨테이너 재시작 반복",
  silent: "지표 끊김",
};

/** 심각도 낱말 → 이름(모르는 낱말은 낱말 그대로). */
export const FIRING_SEVERITY_LABELS: Readonly<Record<string, string>> = { warning: "경고", critical: "위험" };

export interface FiringView {
  rule: string;
  ruleLabel: string;
  severity: string;
  severityLabel: string;
  target: string | null;
  since: string;
  lastValue: number | null;
}

export interface ElsewhereFiringView extends FiringView {
  server: string;
}

export type ReadingState = "value" | "none" | "unread";

export interface MetricReading {
  state: ReadingState;
  value: number | null;
  /** 화면 글자 — 값이면 단위 글자(resource-format), 아니면 RESOURCE_TEXT.none · unread */
  text: string;
  /** 메모리 · 디스크 · GPU 메모리의 "<사용> / <전체>", 그 밖은 null */
  detail: string | null;
  /** 이 자리에 붙은 울리는 임계값 */
  firing: FiringView | null;
}

export type ServerFreshness =
  | { kind: "fresh"; ageMilliseconds: number | null; label: null; firing: FiringView | null }
  | { kind: "stale"; ageMilliseconds: number | null; label: string; firing: FiringView | null }
  | { kind: "never"; ageMilliseconds: number | null; label: string; firing: FiringView | null }
  | { kind: "unknown"; ageMilliseconds: number | null; label: string; firing: FiringView | null };

export interface CurrentHostReadings {
  cpu: MetricReading;
  memory: MetricReading;
  disk: MetricReading;
  networkReceive: MetricReading;
  networkTransmit: MetricReading;
  diskRead: MetricReading;
  diskWrite: MetricReading;
}

export interface ContainerRowView {
  name: string;
  seriesName: string;
  /** 없으면 RESOURCE_TEXT.none */
  stateText: string;
  cpu: MetricReading;
  memory: MetricReading;
  /** 재시작 횟수 — 없으면 null */
  restarts: number | null;
  restartsText: string;
  firing: FiringView | null;
  /** 그 컨테이너의 그래프 주소(resourcesHref — 기간 유지) */
  href: string;
  selected: boolean;
}

export type ContainersView =
  | { state: "listed"; rows: ContainerRowView[]; truncated: boolean }
  | { state: "unread"; rows: []; truncated: boolean }
  | { state: "unknown"; rows: []; truncated: boolean };

export interface GpuRowView {
  index: number;
  utilization: MetricReading;
  memory: MetricReading;
  temperatureText: string;
}

export type GpusView =
  | { state: "listed"; rows: GpuRowView[] }
  | { state: "unread"; rows: [] }
  | { state: "absent"; rows: [] }
  | { state: "unknown"; rows: [] };

export type GraphUnit = "percent" | "bytes" | "bytesPerSecond";

export interface GraphLineSummary {
  label: string;
  /** 마지막 점의 평균 */
  latest: number | null;
  /** 기간의 최댓값 */
  maximum: number | null;
}

export interface GraphView {
  title: string;
  unit: GraphUnit;
  rangeLabel: string;
  fromMilliseconds: number;
  toMilliseconds: number;
  stepMilliseconds: number;
  source: ResourceSeriesSource | null;
  pointCount: number;
  chart: ChartGeometry;
  lineSummaries: GraphLineSummary[];
  summary: string;
}

export interface HostGraphs {
  cpu: GraphView;
  memory: GraphView;
  disk: GraphView;
  network: GraphView;
  diskIo: GraphView;
}

export interface GpuGraphs {
  index: number;
  graphs: UpstreamResult<{ utilization: GraphView; memory: GraphView }>;
}

export interface ServerResourceView {
  server: string;
  measuredAt: string | null;
  freshness: ServerFreshness;
  missing: string[] | null;
  current: CurrentHostReadings;
  containers: ContainersView;
  gpus: GpusView;
  firing: FiringView[];
  hostGraphs: UpstreamResult<HostGraphs>;
  gpuGraphs: GpuGraphs[];
  /** GPU 가 RESOURCE_GPU_GRAPH_LIMIT 를 넘어 그래프를 그리지 않은 수 */
  omittedGpuGraphCount: number;
}

export interface SelectedContainerView extends ContainerSelection {
  graphs: UpstreamResult<{ cpu: GraphView; memory: GraphView }>;
  /** 고른 컨테이너를 닫는 주소(기간 유지) */
  closeHref: string;
}

export interface RangeOptionView {
  range: ResourceRange;
  label: string;
  href: string;
  selected: boolean;
}

export interface ResourcesScreen {
  window: ResourcesWindow;
  rangeOptions: RangeOptionView[];
  /** 지금 주소 그대로(자동 갱신 없음 — §2.6) */
  refreshHref: string;
  servers: UpstreamResult<ServerResourceView[]>;
  hiddenServerCount: number;
  /** latest 에서 이름을 읽지 못해 버린 서버 줄의 수(§18) — latest 가 실패하면 0 */
  unreadableServerNameCount: number;
  firingKnown: boolean;
  firingElsewhere: ElsewhereFiringView[];
  selectedContainer: SelectedContainerView | null;
}

export interface ResourcesScreenOptions {
  observeUrl: string;
  observeSecret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
  nowMilliseconds: number;
  query: ResourcesQuery;
}

export type { FiringRule };

/** 화면 모델 안의 실패 칸 — [칸 이름, 실패]. 순서: latest → 서버(이름순)마다 host 다음 gpu(번호순) → container. 성공한 칸은 없다. */
export function resourcesScreenFailures(screen: ResourcesScreen): [string, UpstreamResult<unknown>][] {
  const failures: [string, UpstreamResult<unknown>][] = [];
  if (!screen.servers.ok) failures.push(["latest", screen.servers]);
  else {
    for (const server of screen.servers.value) {
      if (!server.hostGraphs.ok) failures.push([`host:${server.server}`, server.hostGraphs]);
      for (const gpu of server.gpuGraphs) if (!gpu.graphs.ok) failures.push([`gpu:${server.server}:${gpu.index}`, gpu.graphs]);
    }
  }
  if (screen.selectedContainer !== null && !screen.selectedContainer.graphs.ok) failures.push(["container", screen.selectedContainer.graphs]);
  return failures;
}

/** 글자 코드 순(localeCompare 가 아니다). */
export function byCharacterCode(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function labelOf(labels: Readonly<Record<string, string>>, word: string): string {
  return Object.hasOwn(labels, word) ? labels[word] : word;
}

export function firingView(rule: FiringRule): FiringView {
  return {
    rule: rule.rule, ruleLabel: labelOf(FIRING_RULE_LABELS, rule.rule), severity: rule.severity, severityLabel: labelOf(FIRING_SEVERITY_LABELS, rule.severity),
    target: rule.target, since: rule.since, lastValue: rule.lastValue,
  };
}

/** 값이 없을 때의 상태 — "none"(없음) 또는 "unread"(읽지 못함). */
type Unavailable = Exclude<ReadingState, "value">;

function reading(value: number | null, format: (value: number) => string, unavailable: Unavailable, firing: FiringView | null, detail: string | null = null): MetricReading {
  if (value === null) return { state: unavailable, value: null, text: RESOURCE_TEXT[unavailable], detail: null, firing };
  return { state: "value", value, text: format(value), detail, firing };
}

/** used ÷ total × 100 — total 이 0 · null 이면 값 없음(0 으로 나누지 않는다). */
export function usedPercent(used: number | null, total: number | null): number | null {
  return used !== null && total !== null && total > 0 ? used / total * 100 : null;
}

function usageReading(used: number | null, total: number | null, unavailable: Unavailable, firing: FiringView | null): MetricReading {
  return reading(usedPercent(used, total), formatPercent, unavailable, firing, `${formatBytes(used)} / ${formatBytes(total)}`);
}

export function freshnessOf(server: ServerLatest, firing: FiringView | null): ServerFreshness {
  const ageMilliseconds = server.ageMilliseconds === null ? null : Math.max(0, server.ageMilliseconds);
  if (server.measuredAt === null) return { kind: "never", ageMilliseconds, label: RESOURCE_TEXT.never, firing };
  if (server.stale === null) return { kind: "unknown", ageMilliseconds, label: RESOURCE_TEXT.unknown, firing };
  if (server.stale) {
    const label = ageMilliseconds === null ? RESOURCE_TEXT.staleWithoutAge : `${formatAge(ageMilliseconds)} 값`;
    return { kind: "stale", ageMilliseconds, label, firing };
  }
  return { kind: "fresh", ageMilliseconds, label: null, firing };
}

export interface ServerFiring {
  all: FiringView[];
  disk: FiringView | null;
  memory: FiringView | null;
  cpu: FiringView | null;
  silent: FiringView | null;
  restartsByTarget: Map<string, FiringView>;
}

export function serverFiringOf(rules: FiringRule[]): ServerFiring {
  const all = rules.map(firingView);
  const first = (rule: string) => all.find((view) => view.rule === rule) ?? null;
  const restartsByTarget = new Map<string, FiringView>();
  for (const view of all) if (view.rule === "restarts" && view.target !== null && !restartsByTarget.has(view.target)) restartsByTarget.set(view.target, view);
  return {
    all, disk: first("disk_critical") ?? first("disk_warning"), memory: first("memory"), cpu: first("cpu"), silent: first("silent"), restartsByTarget,
  };
}

export function currentReadings(server: ServerLatest, firing: ServerFiring): CurrentHostReadings {
  const host = server.host;
  const unavailable: Unavailable = server.measuredAt !== null && server.missing?.includes("host") ? "unread" : "none";
  const value = (pick: (values: NonNullable<ServerLatest["host"]>) => number | null) => (server.measuredAt === null || host === null ? null : pick(host));
  return {
    cpu: reading(value((values) => values.cpuPct), formatPercent, unavailable, firing.cpu),
    memory: usageReading(value((values) => values.memUsed), value((values) => values.memTotal), unavailable, firing.memory),
    disk: usageReading(value((values) => values.diskUsed), value((values) => values.diskTotal), unavailable, firing.disk),
    networkReceive: reading(value((values) => values.netRxBps), formatBytesPerSecond, unavailable, null),
    networkTransmit: reading(value((values) => values.netTxBps), formatBytesPerSecond, unavailable, null),
    diskRead: reading(value((values) => values.ioReadBps), formatBytesPerSecond, unavailable, null),
    diskWrite: reading(value((values) => values.ioWriteBps), formatBytesPerSecond, unavailable, null),
  };
}

function containersView(server: ServerLatest, firing: ServerFiring, query: ResourcesQuery): ContainersView {
  const truncated = server.missing?.includes("containers_truncated") ?? false;
  if (server.missing?.includes("containers")) return { state: "unread", rows: [], truncated };
  if (server.containers === null) return { state: "unknown", rows: [], truncated };
  const sorted = [...server.containers].sort((left, right) => byCharacterCode(left.seriesName, right.seriesName) || byCharacterCode(left.name, right.name));
  const rows = sorted.map((container: ContainerLatest): ContainerRowView => {
    const selection: ContainerSelection = { server: server.server, container: container.seriesName };
    return {
      name: container.name, seriesName: container.seriesName, stateText: container.state ?? RESOURCE_TEXT.none,
      cpu: reading(container.cpuPct, formatPercent, "none", null), memory: reading(container.memUsed, formatBytes, "none", null),
      restarts: container.restarts, restartsText: container.restarts === null ? RESOURCE_TEXT.none : String(container.restarts),
      firing: firing.restartsByTarget.get(container.name) ?? null,
      href: resourcesHref({ range: query.range, container: selection }),
      selected: query.container !== null && query.container.server === selection.server && query.container.container === selection.container,
    };
  });
  return { state: "listed", rows, truncated };
}

/** GPU 줄은 번호순. */
function sortedGpus(server: ServerLatest): GpuLatest[] {
  return [...(server.gpus ?? [])].sort((left, right) => left.index - right.index);
}

function gpusView(server: ServerLatest): GpusView {
  if (server.missing?.includes("gpus")) return { state: "unread", rows: [] };
  if (server.gpus === null) return { state: "unknown", rows: [] };
  if (server.gpus.length === 0) return { state: "absent", rows: [] };
  return {
    state: "listed",
    rows: sortedGpus(server).map((gpu) => ({
      index: gpu.index, utilization: reading(gpu.utilPct, formatPercent, "none", null),
      memory: usageReading(gpu.memUsed, gpu.memTotal, "none", null), temperatureText: formatCelsius(gpu.tempC),
    })),
  };
}

// ── 그래프 ──

interface GraphLineSpec {
  key: string;
  label: string;
  role: ChartLineRole;
  /** 점에서 읽을 값 이름 */
  valueName: string;
}

interface GraphSpec {
  title: string;
  unit: GraphUnit;
  axis: ChartAxis;
  /** 있으면 점 값 = 값 ÷ 그 점의 이 값(평균) × 100 */
  totalName: string | null;
  lines: GraphLineSpec[];
}

const PERCENT_AXIS: ChartAxis = { kind: "percent" };
const AUTO_AXIS: ChartAxis = { kind: "auto" };

/** [값, 평균] [값_max, 최댓값] 두 선. */
function averageAndMaximum(valueName: string): GraphLineSpec[] {
  return [
    { key: valueName, label: "평균", role: "average", valueName },
    { key: `${valueName}_max`, label: "최댓값", role: "maximum", valueName },
  ];
}

/** 두 값의 평균 선 둘 다음 최댓값 선 둘. */
function pairedLines(first: [string, string], second: [string, string]): GraphLineSpec[] {
  return [
    { key: first[0], label: first[1], role: "average", valueName: first[0] },
    { key: second[0], label: second[1], role: "average", valueName: second[0] },
    { key: `${first[0]}_max`, label: `${first[1]} 최댓값`, role: "maximum", valueName: first[0] },
    { key: `${second[0]}_max`, label: `${second[1]} 최댓값`, role: "maximum", valueName: second[0] },
  ];
}

const HOST_GRAPH_SPECS: Readonly<Record<keyof HostGraphs, GraphSpec>> = {
  cpu: { title: "CPU", unit: "percent", axis: PERCENT_AXIS, totalName: null, lines: averageAndMaximum("cpu_pct") },
  memory: { title: "메모리", unit: "percent", axis: PERCENT_AXIS, totalName: "mem_total", lines: averageAndMaximum("mem_used") },
  disk: { title: "디스크", unit: "percent", axis: PERCENT_AXIS, totalName: "disk_total", lines: averageAndMaximum("disk_used") },
  network: { title: "네트워크", unit: "bytesPerSecond", axis: AUTO_AXIS, totalName: null, lines: pairedLines(["net_rx_bps", "수신"], ["net_tx_bps", "송신"]) },
  diskIo: { title: "디스크 입출력", unit: "bytesPerSecond", axis: AUTO_AXIS, totalName: null, lines: pairedLines(["io_read_bps", "읽기"], ["io_write_bps", "쓰기"]) },
};

function gpuGraphSpecs(index: number): { utilization: GraphSpec; memory: GraphSpec } {
  return {
    utilization: { title: `GPU ${index} 사용률`, unit: "percent", axis: PERCENT_AXIS, totalName: null, lines: averageAndMaximum("util_pct") },
    memory: { title: `GPU ${index} 메모리`, unit: "percent", axis: PERCENT_AXIS, totalName: "mem_total", lines: averageAndMaximum("mem_used") },
  };
}

function containerGraphSpecs(name: string): { cpu: GraphSpec; memory: GraphSpec } {
  return {
    cpu: { title: `${name} CPU`, unit: "percent", axis: { kind: "auto", minimumTop: 100 }, totalName: null, lines: averageAndMaximum("cpu_pct") },
    memory: { title: `${name} 메모리`, unit: "bytes", axis: AUTO_AXIS, totalName: null, lines: averageAndMaximum("mem_used") },
  };
}

const UNIT_FORMATS: Readonly<Record<GraphUnit, (value: number | null) => string>> = {
  percent: formatPercent, bytes: formatBytes, bytesPerSecond: formatBytesPerSecond,
};

function largest(values: (number | null)[]): number | null {
  return values.reduce<number | null>((maximum, value) => (value !== null && (maximum === null || value > maximum) ? value : maximum), null);
}

function graphView(spec: GraphSpec, series: ResourceSeries, window: ResourcesWindow): GraphView {
  const lines = spec.lines.map((line) => ({
    key: line.key, label: line.label, role: line.role,
    points: series.points.map((point) => {
      const value = point.values[line.valueName]?.[line.role] ?? null;
      const total = spec.totalName === null ? null : point.values[spec.totalName]?.average ?? null;
      return { atMilliseconds: point.atMilliseconds, value: spec.totalName === null ? value : usedPercent(value, total) };
    }),
  }));
  const lineSummaries = lines.filter((line) => line.role === "average").map((line): GraphLineSummary => {
    const values = line.points.map((point) => point.value);
    const pairedMaximum = largest(lines.find((candidate) => candidate.key === `${line.key}_max`)?.points.map((point) => point.value) ?? []);
    return { label: line.label, latest: values.filter((value) => value !== null).at(-1) ?? null, maximum: pairedMaximum ?? largest(values) };
  });
  const format = UNIT_FORMATS[spec.unit];
  const summary = series.points.length === 0
    ? `${spec.title} ${window.label}: ${RESOURCE_TEXT.noRecord}`
    : `${spec.title} ${window.label}: ${lineSummaries.map((line) => `${line.label} 최근 ${format(line.latest)} · 최댓값 ${format(line.maximum)}`).join(" / ")}`;
  return {
    title: spec.title, unit: spec.unit, rangeLabel: window.label, fromMilliseconds: window.fromMilliseconds, toMilliseconds: window.toMilliseconds,
    stepMilliseconds: series.stepMilliseconds, source: series.source, pointCount: series.points.length,
    chart: buildChartGeometry({
      fromMilliseconds: window.fromMilliseconds, toMilliseconds: window.toMilliseconds, stepMilliseconds: series.stepMilliseconds, axis: spec.axis,
      width: RESOURCE_CHART_WIDTH, height: RESOURCE_CHART_HEIGHT, lines,
    }),
    lineSummaries, summary,
  };
}

/** 한 계열의 그래프들 — 조회가 실패하면 그 실패, 해석 중 뜻밖의 예외는 unparseable(그 칸만). */
function graphsOf<Key extends string>(result: UpstreamResult<ResourceSeries>, specs: Record<Key, GraphSpec>, window: ResourcesWindow): UpstreamResult<Record<Key, GraphView>> {
  if (!result.ok) return result;
  try {
    const graphs = {} as Record<Key, GraphView>;
    for (const key of Object.keys(specs) as Key[]) graphs[key] = graphView(specs[key], result.value, window);
    return { ok: true, value: graphs };
  } catch {
    return upstreamFailure("unparseable");
  }
}

// ── 모으기 ──

interface ServersPart {
  servers: UpstreamResult<ServerResourceView[]>;
  hiddenServerCount: number;
  firingKnown: boolean;
  firingElsewhere: ElsewhereFiringView[];
}

function seriesFetcher(client: ResourceMetricsClient, window: ResourcesWindow) {
  return (server: string, scope: ResourceScope, name: string | null) =>
    client.series({ server, scope, name, fromMilliseconds: window.fromMilliseconds, toMilliseconds: window.toMilliseconds });
}

/** 2단계 — 화면에 남긴 서버마다 host · GPU 계열을 한꺼번에 시작하고, 현재 값 · 표를 만든다. */
async function collectServers(latest: LatestResources, client: ResourceMetricsClient, window: ResourcesWindow, query: ResourcesQuery): Promise<ServersPart> {
  const fetchSeries = seriesFetcher(client, window);
  const sorted = [...latest.servers].sort((left, right) => byCharacterCode(left.server, right.server));
  const shown = sorted.slice(0, RESOURCE_SERVER_LIMIT);
  const pending = shown.map((server) => {
    const gpuView = gpusView(server);
    return {
      server, gpuView,
      host: fetchSeries(server.server, "host", null),
      gpus: gpuView.rows.slice(0, RESOURCE_GPU_GRAPH_LIMIT).map((gpu) => ({ index: gpu.index, series: fetchSeries(server.server, "gpu", String(gpu.index)) })),
    };
  });
  const shownNames = new Set(shown.map((server) => server.server));
  const firing = latest.firing ?? [];
  const views = await Promise.all(pending.map(async ({ server, gpuView, host, gpus }): Promise<ServerResourceView> => {
    const serverFiring = serverFiringOf(firing.filter((rule) => rule.server === server.server));
    const gpuGraphs = await Promise.all(gpus.map(async (gpu) => ({ index: gpu.index, graphs: graphsOf(await gpu.series, gpuGraphSpecs(gpu.index), window) })));
    return {
      server: server.server, measuredAt: server.measuredAt, freshness: freshnessOf(server, serverFiring.silent), missing: server.missing,
      current: currentReadings(server, serverFiring), containers: containersView(server, serverFiring, query), gpus: gpuView,
      firing: serverFiring.all, hostGraphs: graphsOf(await host, HOST_GRAPH_SPECS, window), gpuGraphs,
      omittedGpuGraphCount: Math.max(0, gpuView.rows.length - RESOURCE_GPU_GRAPH_LIMIT),
    };
  }));
  return {
    servers: { ok: true, value: views }, hiddenServerCount: sorted.length - shown.length, firingKnown: latest.firing !== null,
    firingElsewhere: firing.filter((rule) => !shownNames.has(rule.server)).map((rule) => ({ ...firingView(rule), server: rule.server })),
  };
}

export async function collectResourcesScreen(options: ResourcesScreenOptions): Promise<ResourcesScreen> {
  const { query } = options;
  const window = resourcesWindow(query.range, options.nowMilliseconds);
  // 설정이 없으면 클라이언트가 호출 없이 not_configured 를 돌려준다
  const client = createResourceMetricsClient({ baseUrl: options.observeUrl, secret: options.observeSecret, fetch: options.fetch, timeoutSignal: options.timeoutSignal });

  // 1단계 — latest 와 고른 컨테이너를 한꺼번에. 2단계는 latest 가 끝나는 대로(고른 컨테이너를 기다리지 않는다).
  const serversPart = client.latest().then(async (latest): Promise<ServersPart> => {
    if (!latest.ok) return { servers: latest, hiddenServerCount: 0, firingKnown: false, firingElsewhere: [] };
    try {
      return await collectServers(latest.value, client, window, query);
    } catch {
      return { servers: upstreamFailure("unparseable"), hiddenServerCount: 0, firingKnown: false, firingElsewhere: [] };
    }
  });
  const selectedContainer = query.container === null ? Promise.resolve(null) : (async (selection: ContainerSelection): Promise<SelectedContainerView> => {
    const series = await seriesFetcher(client, window)(selection.server, "container", selection.container);
    return {
      server: selection.server, container: selection.container, graphs: graphsOf(series, containerGraphSpecs(selection.container), window),
      closeHref: resourcesHref({ range: query.range, container: null }),
    };
  })(query.container);

  const [servers, selected] = await Promise.all([serversPart, selectedContainer]);
  return {
    window,
    rangeOptions: RESOURCE_RANGES.map((range: ResourceRange) => ({
      range, label: RESOURCE_RANGE_LABELS[range], href: resourcesHref({ range, container: query.container }), selected: range === query.range,
    })),
    refreshHref: resourcesHref(query),
    ...servers,
    unreadableServerNameCount: 0,   // 뼈대 — §18 구현 전
    selectedContainer: selected,
  };
}
