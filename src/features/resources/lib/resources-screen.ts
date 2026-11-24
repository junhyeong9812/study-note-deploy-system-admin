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
import type { ChartGeometry } from "@/features/resources/lib/resource-chart";
import type { FiringRule, ResourceSeriesSource } from "@/features/resources/lib/resource-metrics-client";
import type { ContainerSelection, ResourceRange, ResourcesQuery, ResourcesWindow } from "@/features/resources/lib/resources-query";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

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
  void screen;
  throw new Error("not implemented");
}

export function collectResourcesScreen(options: ResourcesScreenOptions): Promise<ResourcesScreen> {
  void options;
  throw new Error("not implemented");
}
