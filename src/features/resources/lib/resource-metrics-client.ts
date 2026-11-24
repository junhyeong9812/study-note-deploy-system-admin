/** 관측 서버 자원 지표 조회 클라이언트(순수 — 설정을 읽지 않는다. 기준 주소 · 비밀값은 부르는 쪽이 준다). 명세 §10.3 · §11.5 · §11.6 · §15 · §15.1.
 *
 * 경로(전부 GET · 머리글 `X-Observe-Secret` · 호출마다 5초 기한(UPSTREAM_TIMEOUT_MILLISECONDS) · 재시도 없음 · redirect:"manual" · 본문 없음):
 * - `GET <base>/metrics/latest`(인자 없음)
 * - `GET <base>/metrics/series?server=&scope=&name=&from=&to=`(이 순서 · host 는 name 을 싣지 않는다 · from/to 는 toISOString 글자)
 * - `GET <base>/metrics/containers?server=[&at=]`(at 이 null 이면 싣지 않는다)
 * 계약(observe MetricController.kt:19-39 · README "조회 API"): 봉투 `{success:true,data:{…}}`, 오류 401 unauthorized · 422 invalid_request ·
 * 503 query_failed · 504 query_timeout.
 *
 * 부르기 전 검사(호출하지 않는다):
 * - 기준 주소가 http(s) 로 해석되지 않거나 비밀값이 비면 → not_configured(세 경로 모두).
 * - series: server 꼴(field "server") · scope 가 셋 밖(field "scope") · name 이 갈래와 맞지 않음(host 는 null 이어야, container 는
 *   RESOURCE_CONTAINER_NAME_PATTERN, gpu 는 숫자 1~3자리 — field "name") · from/to 가 유한한 정수가 아님(field "from" · "to") ·
 *   from > to 이거나 기간이 RESOURCE_SERIES_MAXIMUM_RANGE_MILLISECONDS 초과(field "range") → invalid_input.
 * - containers: server 꼴(field "server") · at 이 null 도 유한한 정수도 아님(field "at") → invalid_input.
 *
 * 응답 상태 → 실패 이유는 failureForHttpStatus 그대로(401 unauthorized · 422 invalid_request · 503 unavailable · 504 server_timeout · 그 밖 bad_status — 3xx 포함).
 * 연결 실패 unreachable · 5초(본문 포함) timeout. 오류 본문 · 예외 문구 · 주소 · 비밀값은 결과에 싣지 않는다(message 는 고정 표의 글자).
 *
 * 본문 상한: 응답 본문은 RESOURCE_RESPONSE_MAXIMUM_BYTES(바이트)까지만 읽는다 — 넘으면 남은 본문을 읽지 않고(취소) unparseable.
 *
 * 응답을 믿지 않는다 — 꼴 규칙(공통: **모르는 칸은 버린다 · 빠진 칸(없음 · null)은 "확인하지 못함"(null) · 있는데 형이 틀리면 전체 unparseable**):
 * - 값(사용률 · 바이트 · 초당 값 · 부하 · 재시작 횟수)은 null 또는 유한한 0 이상의 수. 재시작 횟수 · GPU 번호는 정수. GPU 온도는 유한한 수(음수 허용).
 * - 시각 글자는 parseIsoUtc 로 읽혀야 한다(Java Instant 글자 — 소수 0~9자리).
 * latest:
 * - data.servers 는 배열(필수). 줄마다 server 는 RESOURCE_SERVER_NAME_PATTERN(필수, 같은 이름 두 번이면 unparseable).
 *   at · received_at(시각|null) · age_ms(정수|null — 음수도 받는다, 화면이 0 으로 본다) · stale(참거짓|null) · host(객체|null) ·
 *   containers · gpus(배열|null) · missing(글자 배열|null) — 칸이 없으면 null.
 * - host 의 값 이름은 스트림 body.host 와 같다(cpu_pct · load1 · mem_total · mem_used · disk_total · disk_used · net_rx_bps · net_tx_bps · io_read_bps · io_write_bps).
 * - 컨테이너: name(필수, RESOURCE_CONTAINER_NAME_PATTERN) · series_name(있으면 같은 꼴, 없으면 seriesNameOf(name)) · state(글자|null — 모르는 낱말도 그대로) ·
 *   cpu_pct(코어 하나 = 100 — 100 을 넘을 수 있다) · mem_used · restarts. id · project 는 넘기지 않는다.
 * - GPU: index(필수, 0~999 정수) · util_pct · mem_used · mem_total · temp_c.
 * - data.firing 은 배열|칸 없음(null = 확인하지 못함). 줄마다 server · rule · severity(글자, 필수 — 모르는 낱말도 그대로) · since(시각, 필수) ·
 *   target(글자|null) · last_value(수|null).
 * - 받은 순서를 바꾸지 않는다(관측 서버가 이름순으로 준다 — 정렬은 화면 모델의 몫).
 * series:
 * - server · scope · name(host 는 null) 이 요청과 같아야 한다. from · to 는 시각 글자이고 요청의 밀리초와 같아야 한다.
 *   step_ms 는 양의 정수(필수). source 는 raw · rollup · mixed — 칸이 없거나 그 밖의 글자면 null(형이 글자가 아니면 unparseable).
 * - points 는 배열(필수), RESOURCE_SERIES_MAXIMUM_POINTS 개를 넘으면 unparseable. 점마다 at(시각, 필수) — at 은 엄격히 오름차순.
 *   그 갈래의 값 이름(RESOURCE_SCOPE_VALUE_NAMES)마다 `<값>` → average, `<값>_max` → maximum(없음 · null 이면 null). 그 밖의 칸은 버린다.
 * - 첫 점의 at 은 from 보다 최대 5분 앞설 수 있다(5분 평균의 구간 시작 — §15.1). 이 클라이언트는 그 점을 버리지 않는다.
 * containers: server 가 요청과 같음 · from · to 는 시각 · containers 는 배열, 줄마다 name(꼴) · last_seen_at(시각). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

export const RESOURCE_METRICS_LATEST_PATH = "/metrics/latest";
export const RESOURCE_METRICS_SERIES_PATH = "/metrics/series";
export const RESOURCE_METRICS_CONTAINERS_PATH = "/metrics/containers";

/** 관측 서버의 점 상한(observe MetricSeries.kt:34 MAX_POINTS). */
export const RESOURCE_SERIES_MAXIMUM_POINTS = 500;
/** 관측 서버의 기간 상한(observe MetricController.kt:206 MAX_RANGE — 정확히 31일은 받는다). */
export const RESOURCE_SERIES_MAXIMUM_RANGE_MILLISECONDS = 31 * 24 * 60 * 60 * 1000;
/** 응답 본문 상한(1 MiB) — 서버 셋 · 컨테이너 50개(§10.2) · 점 500개 × 값 20칸이 넉넉히 든다. */
export const RESOURCE_RESPONSE_MAXIMUM_BYTES = 1_048_576;

export const RESOURCE_SCOPES = ["host", "container", "gpu"] as const;
export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

/** 갈래마다의 값 이름(observe MetricEntry.kt:22-25 MetricScope.values). */
export const RESOURCE_SCOPE_VALUE_NAMES: Readonly<Record<ResourceScope, readonly string[]>> = {
  host: ["cpu_pct", "load1", "mem_total", "mem_used", "disk_total", "disk_used", "net_rx_bps", "net_tx_bps", "io_read_bps", "io_write_bps"],
  container: ["cpu_pct", "mem_used"],
  gpu: ["util_pct", "mem_used", "mem_total", "temp_c"],
};

export const RESOURCE_SERIES_SOURCES = ["raw", "rollup", "mixed"] as const;
export type ResourceSeriesSource = (typeof RESOURCE_SERIES_SOURCES)[number];

/** 서버 전체 값 — 값이 없으면 null(0 으로 채우지 않는다). */
export interface HostValues {
  cpuPct: number | null;
  load1: number | null;
  memTotal: number | null;
  memUsed: number | null;
  diskTotal: number | null;
  diskUsed: number | null;
  netRxBps: number | null;
  netTxBps: number | null;
  ioReadBps: number | null;
  ioWriteBps: number | null;
}

export interface ContainerLatest {
  /** 실제 이름(`front-app-green`) */
  name: string;
  /** 자리 이름을 뗀 이름(`front-app`) */
  seriesName: string;
  state: string | null;
  /** 코어 하나 = 100 */
  cpuPct: number | null;
  memUsed: number | null;
  restarts: number | null;
}

export interface GpuLatest {
  index: number;
  utilPct: number | null;
  memUsed: number | null;
  memTotal: number | null;
  tempC: number | null;
}

export interface ServerLatest {
  server: string;
  /** `at` — 측정 시각(받은 글자). "수신 없음"이면 null */
  measuredAt: string | null;
  receivedAt: string | null;
  /** `age_ms` — 마지막 수신부터(관측 서버의 시계) */
  ageMilliseconds: number | null;
  /** `stale` — 3분 초과. 칸이 없으면 null */
  stale: boolean | null;
  host: HostValues | null;
  /** 칸이 없으면 null(확인하지 못함) · [] 는 정말 없음 */
  containers: ContainerLatest[] | null;
  gpus: GpuLatest[] | null;
  missing: string[] | null;
}

export interface FiringRule {
  server: string;
  /** disk_warning · disk_critical · memory · cpu · restarts · silent(모르는 낱말도 그대로) */
  rule: string;
  /** 재시작 규칙의 컨테이너 실제 이름, 그 밖은 null */
  target: string | null;
  /** warning · critical(모르는 낱말도 그대로) */
  severity: string;
  since: string;
  lastValue: number | null;
}

export interface LatestResources {
  servers: ServerLatest[];
  /** 칸이 없으면 null(확인하지 못함) */
  firing: FiringRule[] | null;
}

export interface SeriesRequest {
  server: string;
  scope: ResourceScope;
  /** host 는 null · container 는 자리 이름을 뗀 이름 · gpu 는 번호 글자 */
  name: string | null;
  fromMilliseconds: number;
  toMilliseconds: number;
}

export interface SeriesValue {
  average: number | null;
  maximum: number | null;
}

export interface SeriesPoint {
  /** 받은 글자 그대로 */
  at: string;
  atMilliseconds: number;
  /** 그 갈래의 값 이름(RESOURCE_SCOPE_VALUE_NAMES) 전부 — 다른 이름은 없다 */
  values: Readonly<Record<string, SeriesValue>>;
}

export interface ResourceSeries {
  server: string;
  scope: ResourceScope;
  name: string | null;
  fromMilliseconds: number;
  toMilliseconds: number;
  /** 관측 서버가 고른 간격 */
  stepMilliseconds: number;
  /** 칸이 없거나 모르는 글자면 null */
  source: ResourceSeriesSource | null;
  /** 시각 오름차순, 최대 500개 */
  points: SeriesPoint[];
}

export interface SeenContainer {
  name: string;
  lastSeenAt: string;
}

export interface SeenContainers {
  server: string;
  fromMilliseconds: number;
  toMilliseconds: number;
  containers: SeenContainer[];
}

export interface ResourceMetricsClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;   // 호출마다 5000 으로 부른다
}

export interface ResourceMetricsClient {
  latest(): Promise<UpstreamResult<LatestResources>>;
  series(request: SeriesRequest): Promise<UpstreamResult<ResourceSeries>>;
  /** atMilliseconds 가 null 이면 최근 24시간, 있으면 그 시각 앞뒤 5분(§11.5) */
  containers(server: string, atMilliseconds: number | null): Promise<UpstreamResult<SeenContainers>>;
}

/** 자리 이름 떼기(observe MetricEntry.kt:284-292 ContainerName.seriesName 과 같은 규칙) — 끝의 `-blue` · `-green` 하나만,
 * 떼면 빈 이름이 되거나 그 꼴로 끝나지 않으면 그대로. */
export function seriesNameOf(actualName: string): string {
  void actualName;
  throw new Error("not implemented");
}

export function createResourceMetricsClient(options: ResourceMetricsClientOptions): ResourceMetricsClient {
  void options;
  throw new Error("not implemented");
}
