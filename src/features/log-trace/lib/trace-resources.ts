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
import type { ResourceSeriesSource } from "@/features/resources/lib/resource-metrics-client";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

export const TRACE_RESOURCE_WINDOW_MILLISECONDS = 5 * 60 * 1000;
export const TRACE_RESOURCE_SERVER_LIMIT = 10;
export const TRACE_RESOURCE_MAXIMUM_CALLS = 1 + TRACE_RESOURCE_SERVER_LIMIT + 2;

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
  | { kind: "found"; server: string; serviceContainer: string | null; containers: string[]; alsoSeenOn: string[]; uncheckedServers: string[] }
  | { kind: "none" }
  | { kind: "unknown"; failedServers: string[] };

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
  void seriesName; void service;
  throw new Error("not implemented");
}

/** 값을 보일 그 서비스 컨테이너의 계열 이름. */
export function serviceContainerName(service: string): string {
  void service;
  throw new Error("not implemented");
}

export function collectTraceResources(options: TraceResourcesOptions): Promise<TraceResourcesView | null> {
  void options;
  throw new Error("not implemented");
}
