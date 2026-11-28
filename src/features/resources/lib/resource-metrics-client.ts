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
import { RESOURCE_CONTAINER_NAME_PATTERN, RESOURCE_SERVER_NAME_PATTERN } from "@/features/resources/lib/resources-query";
import { withCallerService } from "@/shared/lib/caller-service";
import { withRequestId } from "@/shared/lib/request-scope";
import { parseIsoUtc } from "@/shared/lib/query-input";
import { isHttpBaseUrl, isRecord, upstreamUrl } from "@/shared/lib/upstream-fetch";
import {
  UPSTREAM_TIMEOUT_MILLISECONDS, failureForHttpStatus, invalidInput, upstreamFailure, type UpstreamResult,
} from "@/shared/lib/upstream-result";

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
  /** 이름(server)을 읽지 못해 버린 서버 줄의 수(§18 — 그 줄만 버리고 센다) */
  unreadableServerNameCount: number;
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
  for (const slot of ["-blue", "-green"]) {
    if (actualName.endsWith(slot) && actualName.length > slot.length) return actualName.slice(0, -slot.length);
  }
  return actualName;
}

/** 응답 한 번을 읽은 결과 — 상태 코드와 JSON(해석되지 않으면 parsed:false). */
type BoundedResponse = { status: number; parsed: true; json: unknown } | { status: number; parsed: false };

/** 본문을 maximumBytes 바이트까지만 읽는다 — 넘으면 남은 본문을 취소하고 null. 읽는 중의 실패(기한 끊김 포함)는 던진다.
 * 공용 getUpstream 은 본문을 끝까지 읽어(response.text()) 상한을 둘 수 없어 이 기능 안에 둔다(통신 지도의 의존 상태 읽기도 이것을 쓴다). 기한은 fetch 에 준 신호가 본문 스트림까지 끊는다. */
export async function readBoundedText(response: Response, maximumBytes: number): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** GET 한 번(5초 기한이 본문 읽기까지 덮는다). 거부하지 않는다 — 실패는 고정 이유만(예외 문구 · 본문 원문 없음). */
async function getBounded(url: string, options: ResourceMetricsClientOptions): Promise<UpstreamResult<BoundedResponse>> {
  const signal = options.timeoutSignal ? options.timeoutSignal(UPSTREAM_TIMEOUT_MILLISECONDS) : AbortSignal.timeout(UPSTREAM_TIMEOUT_MILLISECONDS);
  try {
    const response = await options.fetch(url, {
      method: "GET",
      headers: withRequestId(withCallerService({ Accept: "application/json", "X-Observe-Secret": options.secret })),
      signal,
      redirect: "manual",
      cache: "no-store",
    });
    if (response.status < 200 || response.status >= 300) {
      response.body?.cancel().catch(() => undefined);   // 오류 본문은 읽지 않는다
      return { ok: true, value: { status: response.status, parsed: false } };
    }
    const text = await readBoundedText(response, RESOURCE_RESPONSE_MAXIMUM_BYTES);
    if (text === null) return upstreamFailure("unparseable");
    try {
      return { ok: true, value: { status: response.status, parsed: true, json: JSON.parse(text) as unknown } };
    } catch {
      return { ok: true, value: { status: response.status, parsed: false } };
    }
  } catch {
    return upstreamFailure(signal.aborted ? "timeout" : "unreachable");
  }
}

/** 칸 해석의 실패 — 꼴이 계약과 다르다(전체 unparseable). */
class MalformedResponse extends Error {}

function malformed(): never {
  throw new MalformedResponse();
}

/** 빠진 칸(없음 · null) → null, 있으면 check 를 통과한 값, 아니면 꼴 오류. */
function optional<Value>(value: unknown, check: (candidate: unknown) => candidate is Value): Value | null {
  if (value === undefined || value === null) return null;
  return check(value) ? value : malformed();
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isTimeText(value: unknown): value is string {
  return typeof value === "string" && parseIsoUtc(value) !== null;
}

function isContainerName(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_CONTAINER_NAME_PATTERN.test(value);
}

function isServerName(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_SERVER_NAME_PATTERN.test(value);
}

function required<Value>(value: unknown, check: (candidate: unknown) => candidate is Value): Value {
  return check(value) ? value : malformed();
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : malformed();
}

/** 배열 칸 — 빠지면 null, 배열이 아니면 꼴 오류. */
function optionalArray<Value>(value: unknown, parseRow: (row: unknown) => Value): Value[] | null {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value.map(parseRow) : malformed();
}

function timeMilliseconds(value: unknown): number {
  return parseIsoUtc(required(value, isTimeText)) as number;
}

function parseHost(value: unknown): HostValues | null {
  if (value === undefined || value === null) return null;
  const host = record(value);
  const read = (name: string) => optional(host[name], isNonNegativeNumber);
  return {
    cpuPct: read("cpu_pct"), load1: read("load1"), memTotal: read("mem_total"), memUsed: read("mem_used"),
    diskTotal: read("disk_total"), diskUsed: read("disk_used"), netRxBps: read("net_rx_bps"), netTxBps: read("net_tx_bps"),
    ioReadBps: read("io_read_bps"), ioWriteBps: read("io_write_bps"),
  };
}

function parseContainer(value: unknown): ContainerLatest {
  const row = record(value);   // id · project 는 읽지 않는다
  const name = required(row.name, isContainerName);
  return {
    name, seriesName: optional(row.series_name, isContainerName) ?? seriesNameOf(name), state: optional(row.state, isString),
    cpuPct: optional(row.cpu_pct, isNonNegativeNumber), memUsed: optional(row.mem_used, isNonNegativeNumber), restarts: optional(row.restarts, isNonNegativeInteger),
  };
}

function isGpuIndex(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 999;
}

function parseGpu(value: unknown): GpuLatest {
  const row = record(value);
  return {
    index: required(row.index, isGpuIndex), utilPct: optional(row.util_pct, isNonNegativeNumber), memUsed: optional(row.mem_used, isNonNegativeNumber),
    memTotal: optional(row.mem_total, isNonNegativeNumber), tempC: optional(row.temp_c, isFiniteNumber),
  };
}

function parseMissing(value: unknown): string {
  return required(value, isString);
}

function parseServer(value: unknown): ServerLatest {
  const row = record(value);
  return {
    server: required(row.server, isServerName), measuredAt: optional(row.at, isTimeText), receivedAt: optional(row.received_at, isTimeText),
    ageMilliseconds: optional(row.age_ms, isInteger), stale: optional(row.stale, isBoolean), host: parseHost(row.host),
    containers: optionalArray(row.containers, parseContainer), gpus: optionalArray(row.gpus, parseGpu), missing: optionalArray(row.missing, parseMissing),
  };
}

function parseFiring(value: unknown): FiringRule {
  const row = record(value);
  return {
    server: required(row.server, isString), rule: required(row.rule, isString), target: optional(row.target, isString),
    severity: required(row.severity, isString), since: required(row.since, isTimeText), lastValue: optional(row.last_value, isFiniteNumber),
  };
}

function parseLatest(data: Record<string, unknown>): LatestResources {
  if (!Array.isArray(data.servers)) malformed();
  // 이름(server)의 꼴이 틀린 줄은 그 줄만 버리고 센다(§18 — 관측 서버의 기대 서버 설정 하나가 틀려도 나머지 서버는 보인다).
  // 줄이 객체가 아니거나, 이름은 맞는데 다른 칸의 형이 틀리면 지금처럼 전체 unparseable.
  const rows = (data.servers as unknown[]).map(record);
  const readable = rows.filter((row) => isServerName(row.server));
  const servers = readable.map(parseServer);
  if (new Set(servers.map((server) => server.server)).size !== servers.length) malformed();   // 같은 서버 두 번
  return { servers, unreadableServerNameCount: rows.length - readable.length, firing: optionalArray(data.firing, parseFiring) };
}

/** 갈래마다 값의 꼴 — GPU 온도만 음수를 받는다. */
function seriesValueCheck(scope: ResourceScope, name: string): (candidate: unknown) => candidate is number {
  return scope === "gpu" && name === "temp_c" ? isFiniteNumber : isNonNegativeNumber;
}

function parseSeries(data: Record<string, unknown>, request: SeriesRequest): ResourceSeries {
  if (data.server !== request.server || data.scope !== request.scope || (data.name ?? null) !== request.name) malformed();
  if (timeMilliseconds(data.from) !== request.fromMilliseconds || timeMilliseconds(data.to) !== request.toMilliseconds) malformed();
  const stepMilliseconds = required(data.step_ms, isNonNegativeInteger);
  if (stepMilliseconds === 0) malformed();
  const sourceText = optional(data.source, isString);
  const source = sourceText !== null && (RESOURCE_SERIES_SOURCES as readonly string[]).includes(sourceText) ? sourceText as ResourceSeriesSource : null;
  if (!Array.isArray(data.points) || data.points.length > RESOURCE_SERIES_MAXIMUM_POINTS) malformed();
  const valueNames = RESOURCE_SCOPE_VALUE_NAMES[request.scope];
  let previousAt = Number.NEGATIVE_INFINITY;
  const points = (data.points as unknown[]).map((value): SeriesPoint => {
    const row = record(value);
    const at = required(row.at, isTimeText);
    const atMilliseconds = parseIsoUtc(at) as number;
    if (atMilliseconds <= previousAt) malformed();   // 시각은 엄격히 오름차순
    previousAt = atMilliseconds;
    const values: Record<string, SeriesValue> = {};
    for (const name of valueNames) {
      const check = seriesValueCheck(request.scope, name);
      values[name] = { average: optional(row[name], check), maximum: optional(row[`${name}_max`], check) };
    }
    return { at, atMilliseconds, values };
  });
  return {
    server: request.server, scope: request.scope, name: request.name, fromMilliseconds: request.fromMilliseconds, toMilliseconds: request.toMilliseconds,
    stepMilliseconds, source, points,
  };
}

function parseSeenContainer(value: unknown): SeenContainer {
  const row = record(value);
  return { name: required(row.name, isContainerName), lastSeenAt: required(row.last_seen_at, isTimeText) };
}

function parseContainers(data: Record<string, unknown>, server: string): SeenContainers {
  if (data.server !== server) malformed();
  if (!Array.isArray(data.containers)) malformed();
  return {
    server, fromMilliseconds: timeMilliseconds(data.from), toMilliseconds: timeMilliseconds(data.to),
    containers: (data.containers as unknown[]).map(parseSeenContainer),
  };
}

/** 시각 인자 — 유한한 정수이고 Date 로 글자가 되는 값. */
function isTimeArgument(value: number): boolean {
  return Number.isInteger(value) && !Number.isNaN(new Date(value).getTime());
}

function seriesInputFailure(request: SeriesRequest): UpstreamResult<never> | null {
  if (!isServerName(request.server)) return invalidInput("server");
  if (!(RESOURCE_SCOPES as readonly string[]).includes(request.scope)) return invalidInput("scope");
  const nameMatches = request.scope === "host" ? request.name === null
    : request.scope === "container" ? isContainerName(request.name)
    : typeof request.name === "string" && /^\d{1,3}$/.test(request.name);
  if (!nameMatches) return invalidInput("name");
  if (!isTimeArgument(request.fromMilliseconds)) return invalidInput("from");
  if (!isTimeArgument(request.toMilliseconds)) return invalidInput("to");
  const range = request.toMilliseconds - request.fromMilliseconds;
  if (range < 0 || range > RESOURCE_SERIES_MAXIMUM_RANGE_MILLISECONDS) return invalidInput("range");
  return null;
}

export function createResourceMetricsClient(options: ResourceMetricsClientOptions): ResourceMetricsClient {
  const configured = isHttpBaseUrl(options.baseUrl) && options.secret.length > 0;

  /** 부르고 봉투의 data 를 해석한다 — 2xx 가 아니면 상태의 실패, 꼴이 다르면(해석 중 뜻밖의 예외 포함) unparseable. */
  const call = async <Value>(path: string, parameters: [string, string | null][], interpret: (data: Record<string, unknown>) => Value): Promise<UpstreamResult<Value>> => {
    const result = await getBounded(upstreamUrl(options.baseUrl, path, parameters), options);
    if (!result.ok) return result;
    const response = result.value;
    if (response.status < 200 || response.status >= 300) return failureForHttpStatus(response.status);
    if (!response.parsed || !isRecord(response.json) || response.json.success !== true || !isRecord(response.json.data)) return upstreamFailure("unparseable");
    try {
      return { ok: true, value: interpret(response.json.data) };
    } catch {
      return upstreamFailure("unparseable");
    }
  };

  return {
    async latest() {
      if (!configured) return upstreamFailure("not_configured");
      return call(RESOURCE_METRICS_LATEST_PATH, [], parseLatest);
    },
    async series(request) {
      if (!configured) return upstreamFailure("not_configured");
      const failure = seriesInputFailure(request);
      if (failure !== null) return failure;
      return call(RESOURCE_METRICS_SERIES_PATH, [
        ["server", request.server], ["scope", request.scope], ["name", request.name],
        ["from", new Date(request.fromMilliseconds).toISOString()], ["to", new Date(request.toMilliseconds).toISOString()],
      ], (data) => parseSeries(data, request));
    },
    async containers(server, atMilliseconds) {
      if (!configured) return upstreamFailure("not_configured");
      if (!isServerName(server)) return invalidInput("server");
      if (atMilliseconds !== null && !isTimeArgument(atMilliseconds)) return invalidInput("at");
      return call(RESOURCE_METRICS_CONTAINERS_PATH, [["server", server], ["at", atMilliseconds === null ? null : new Date(atMilliseconds).toISOString()]],
        (data) => parseContainers(data, server));
    },
  };
}
