/** 테스트 전용 — 서버 자원 사례의 가짜 관측 서버(지표 조회 셋). 주소 · 비밀값은 upstream-test-fakes 의 명백한 가짜.
 * 응답 꼴은 실제 소스대로(observe metric/MetricController.kt:83-203):
 * - latest: `{success, data:{servers:[{server, at, received_at, age_ms, stale, host, containers:[{name, series_name, id, project, cpu_pct, mem_used, restarts, state}],
 *   gpus:[{index, util_pct, mem_used, mem_total, temp_c}], missing}], firing:[{server, rule, target, severity, since, last_value}]}}`. 시각은 Java Instant 글자.
 * - series: `{server, scope, name(host 는 null), from, to, step_ms, source, points:[{at, <값>, <값>_max, …}]}` — 갈래의 값 이름 전부(없으면 null).
 *   간격은 observe MetricSeries.kt:41-52 의 원본 규칙(기간 ÷ 500 을 30초 단위로 올림, 최소 30초).
 * - containers: `{server, from, to, containers:[{name, last_seen_at}]}`.
 * 일부러 계약 밖 칸(extra · id · project)에 UPSTREAM_RAW_MARKER 를 넣는다 — 결과에 나오면 원문을 흘린 것이다. */
import {
  FAKE_OBSERVE_SECRET, UPSTREAM_RAW_MARKER, headersOf, jsonBody, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 화면의 "지금" — 밀리초가 0 이 아니다. */
export const NOW_MILLISECONDS = Date.UTC(2026, 10, 24, 12, 0, 0, 250);

export const HOST_VALUE_NAMES = ["cpu_pct", "load1", "mem_total", "mem_used", "disk_total", "disk_used", "net_rx_bps", "net_tx_bps", "io_read_bps", "io_write_bps"] as const;
export const CONTAINER_VALUE_NAMES = ["cpu_pct", "mem_used"] as const;
export const GPU_VALUE_NAMES = ["util_pct", "mem_used", "mem_total", "temp_c"] as const;

const VALUE_NAMES: Record<string, readonly string[]> = { host: HOST_VALUE_NAMES, container: CONTAINER_VALUE_NAMES, gpu: GPU_VALUE_NAMES };

/** Java Instant.toString 과 같은 글자(밀리초가 0 이면 소수 없음). */
export function javaInstantText(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString().replace(".000Z", "Z");
}

export function observeHost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cpu_pct: 3.4, load1: 0.11, mem_total: 16_000_000_000, mem_used: 2_100_000_000, disk_total: 500_235_124_736, disk_used: 80_570_650_624,
    net_rx_bps: 1200, net_tx_bps: 3400, io_read_bps: 0, io_write_bps: 52_000, ...overrides,
  };
}

export function observeContainer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "front-app-green", series_name: "front-app", id: "0123456789ab", project: `study-note-deploy-system-front ${UPSTREAM_RAW_MARKER}`,
    cpu_pct: 0.7, mem_used: 119_000_000, restarts: 0, state: "running", ...overrides,
  };
}

export function observeGpu(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { index: 0, util_pct: 12, mem_used: 9_437_184, mem_total: 8_589_934_592, temp_c: 28, ...overrides };
}

/** latest 의 서버 한 줄(값이 있는 서버). */
export function observeLatestServer(server: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server, at: javaInstantText(NOW_MILLISECONDS - 20 * SECOND), received_at: javaInstantText(NOW_MILLISECONDS - 19 * SECOND),
    age_ms: 19_250, stale: false, host: observeHost(), containers: [observeContainer()], gpus: [], missing: [], extra: UPSTREAM_RAW_MARKER,
    ...overrides,
  };
}

/** "수신 없음" 서버(MetricController.kt:128-131 silentServer · §16 — 마지막 수신 시각은 낼 수 있다). */
export function observeSilentServer(server: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server, at: null, received_at: null, age_ms: null, stale: true, host: null, containers: [], gpus: [], missing: [], ...overrides,
  };
}

export function observeFiring(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: "158", rule: "disk_warning", target: null, severity: "warning", since: javaInstantText(NOW_MILLISECONDS - 30 * MINUTE),
    last_value: 86.2, ...overrides,
  };
}

export function observeLatestBody(servers: Record<string, unknown>[], firing: Record<string, unknown>[] | undefined = []): Response {
  const data: Record<string, unknown> = { servers, extra: UPSTREAM_RAW_MARKER };
  if (firing !== undefined) data.firing = firing;
  return jsonBody({ success: true, data });
}

/** 점 하나 — values 는 값 이름 → [평균, 최댓값]. 갈래의 다른 값 이름은 null. */
export function observePoint(scope: string, atMilliseconds: number, values: Record<string, [number | null, number | null]> = {}): Record<string, unknown> {
  const point: Record<string, unknown> = { at: javaInstantText(atMilliseconds) };
  for (const name of VALUE_NAMES[scope]) {
    const [average, maximum] = values[name] ?? [null, null];
    point[name] = average;
    point[`${name}_max`] = maximum;
  }
  return point;
}

/** 관측 서버의 원본 간격 규칙(MetricSeries.kt:41-52, source raw). */
export function rawStepMilliseconds(fromMilliseconds: number, toMilliseconds: number): number {
  const perPoint = Math.ceil(Math.max(0, toMilliseconds - fromMilliseconds) / 500);
  return Math.max(1, Math.ceil(perPoint / 30_000)) * 30_000;
}

export interface SeriesAnswer {
  points?: Record<string, unknown>[];
  stepMilliseconds?: number;
  source?: string;
  /** 그대로 돌려줄 응답(꼴 · 상태 사례) */
  response?: () => Response | Promise<Response>;
}

export interface FakeObserveMetrics {
  handler: RoutedFetchHandler;
  /** 받은 요청의 경로와 인자 */
  calls: { path: string; parameters: Record<string, string> }[];
  latest: () => Response | Promise<Response>;
  /** `${server}|${scope}|${name ?? ""}` → 답. 없으면 점 없는 정상 응답 */
  series: Map<string, SeriesAnswer>;
}

export function seriesKey(server: string, scope: string, name: string | null): string {
  return `${server}|${scope}|${name ?? ""}`;
}

/** 가짜 관측 서버 — 비밀값이 틀리면 401. series 는 받은 인자를 되돌려 적는다(실제 컨트롤러처럼 from · to 를 Instant 글자로). */
export function createFakeObserveMetrics(latest: () => Response | Promise<Response>): FakeObserveMetrics {
  const fake: FakeObserveMetrics = { handler: () => jsonBody({}), calls: [], latest, series: new Map() };
  fake.handler = (url, init) => {
    const parameters = Object.fromEntries(url.searchParams);
    fake.calls.push({ path: url.pathname, parameters });
    if (headersOf(init).get("X-Observe-Secret") !== FAKE_OBSERVE_SECRET) return jsonBody({ success: false, error: { code: "unauthorized" } }, 401);
    if (url.pathname === "/metrics/latest") return fake.latest();
    if (url.pathname === "/metrics/series") {
      const name = parameters.name ?? null;
      const answer = fake.series.get(seriesKey(parameters.server, parameters.scope, name)) ?? {};
      if (answer.response) return answer.response();
      const fromMilliseconds = Date.parse(parameters.from);
      const toMilliseconds = Date.parse(parameters.to);
      return jsonBody({ success: true, data: {
        server: parameters.server, scope: parameters.scope, name, from: javaInstantText(fromMilliseconds), to: javaInstantText(toMilliseconds),
        step_ms: answer.stepMilliseconds ?? rawStepMilliseconds(fromMilliseconds, toMilliseconds), source: answer.source ?? "raw",
        points: answer.points ?? [], extra: UPSTREAM_RAW_MARKER,
      } });
    }
    return jsonBody({ success: false, error: { code: "not_found" } }, 404);
  };
  return fake;
}

/** 시각 from 부터 step 간격으로 count 개의 점(값은 makeValues(i)). */
export function evenlySpacedPoints(scope: string, fromMilliseconds: number, stepMilliseconds: number, count: number,
                                   makeValues: (index: number) => Record<string, [number | null, number | null]>): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => observePoint(scope, fromMilliseconds + index * stepMilliseconds, makeValues(index)));
}
