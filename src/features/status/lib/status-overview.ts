/** 상태 한눈에 — 다섯 호출을 **병렬**로, 각각 5초(명세 ② 세부). 하나가 멈추거나 오류 · 깨진 본문을 줘도 그 칸만 실패로 두고 나머지는 그린다.
 * 각 칸은 상태 낱말 · 숫자와 **가린 사유**만 넘긴다 — 정상 응답 안의 사유 글자(alert monitors 의 reason, backend 의 detail, observe 헬스의 failure)는
 * 전부 maskUpstreamReason(src/shared/lib/upstream-reason.ts)을 거친 값이다(판정 11-22 7번). 오류 응답 본문 · 호출 주소 · 헤더는 넘기지 않는다.
 * 비밀값은 그 값이 필요한 호출(alert `/monitors` 의 X-Alert-Secret)에만 싣는다 — 헬스 호출에는 싣지 않는다. 전부 GET, redirect:"manual".
 *
 * 각 서버의 계약(실파일):
 * - alert `GET /monitors`(alert AlertController.kt:85-94, X-Alert-Secret): `{success:true,data:{monitors:[{name,status:"UP"|"DOWN"|"UNKNOWN",down_since(""=없음),reason}],last_round_at(""=없음),undelivered}}`
 *   (status 열거 = monitor/MonitorTracker.kt:14).
 * - alert `GET /health`(AlertController.kt:49-63, 인증 없음, 봉투 없음): `{status:"ok"|"starting"|"standby"|"stalled", last_round_at, active}` — stalled 만 503.
 * - observe `GET /health`(observe api/LogController.kt:140-144, collect/CollectorHealth.kt:48-72, 인증 없음, 봉투 없음):
 *   `{status:"ok"|"unreachable"|"failing"|"starting"|"stalled", failure, lag(-1=모름), last_stored_at(""=없음), …}` — 200 은 ok 하나뿐, 나머지는 503.
 * - backend `GET /api/health/dependencies`(backend shared/api/DependencyHealthController.kt:29-45, 인증 없음, 봉투 없음, 항상 200):
 *   `{status:"UP"|"DOWN", components:{<이름>:{status:"UP"|"DOWN", detail?}}}`.
 * - master `GET /health`(ci-cd cmd/server/main.go:19-21, 인증 없음): `{success:true,data:{mode}}`.
 * 헬스 둘(alert · observe)은 503 이어도 본문이 계약 꼴이면 실패가 아니라 그 상태 낱말(healthy:false)로 넘긴다. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { maskUpstreamReason } from "@/shared/lib/upstream-reason";
import {
  envelopeData, getUpstream, isHttpBaseUrl, isNonNegativeInteger, isRecord, upstreamUrl, type UpstreamGetOptions, type UpstreamResponse,
} from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, upstreamFailure, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const STATUS_CHECK_NAMES = ["alertMonitors", "alertHealth", "observeHealth", "backendDependencies", "deployMasterHealth"] as const;
export type StatusCheckName = (typeof STATUS_CHECK_NAMES)[number];

export const ALERT_HEALTH_STATUSES = ["ok", "starting", "standby", "stalled"] as const;
export const OBSERVE_HEALTH_STATUSES = ["ok", "unreachable", "failing", "starting", "stalled"] as const;
export const MONITOR_STATUSES = ["UP", "DOWN", "UNKNOWN"] as const;

/** 헬스 한 칸 — 상태 낱말과 정상 여부(status === "ok"). master 는 봉투가 success:true 이면 "ok". */
export interface ServiceHealthView {
  status: string;
  healthy: boolean;
  /** observe 헬스의 failure 를 가린 값("" · 없음 = null). alert · master 는 언제나 null. */
  failure: string | null;
}

/** 관측 서버 헬스 한 칸 — 상태 낱말 · 가린 사유에 더해 밀린 건수와 최근 로그 시각(observe collect/CollectorHealth.kt:60,63).
 * 두 칸은 판정에 쓰지 않는다(관측 서버도 판정에 넣지 않는다 — 밀림은 진행 상황). 상태 낱말과 무관하게 본문에 있다.
 * 칸이 없으면(구버전 관측 서버) null. 칸이 있는데 형이 틀리면 칸 전체가 실패 — 200 은 unparseable, 503 은 unavailable(503). */
export interface ObserveHealthView extends ServiceHealthView {
  /** `lag` — 그룹에 아직 전달되지 않은 밀린 건수. -1(관측 서버가 셀 수 없음) · 칸 없음 = null, 0 은 실제 값. -1 이상의 정수만 받는다. */
  backlog: number | null;
  /** `last_stored_at` — DB 의 가장 최근 로그 시각(받은 글자 그대로). ""(없음 · 닿지 못함) · 칸 없음 = null. Date.parse 가 NaN 이면 틀린 형. */
  lastLogAt: string | null;
}

export interface AlertMonitorView {
  name: string;
  status: (typeof MONITOR_STATUSES)[number];
  /** "" 이면 null */
  downSince: string | null;
  /** 마지막 확인의 사유를 가린 값(maskUpstreamReason). 사유가 없으면 "" */
  reason: string;
}

export interface AlertMonitorsView {
  monitors: AlertMonitorView[];
  lastRoundAt: string | null;
  undelivered: number;
}

export interface BackendDependencyView {
  name: string;
  status: "UP" | "DOWN";
  /** detail 을 가린 값(maskUpstreamReason). detail 이 없으면 null */
  detail: string | null;
}

export interface BackendDependenciesView {
  status: "UP" | "DOWN";
  /** 응답의 components 순서대로 */
  components: BackendDependencyView[];
}

export interface StatusOverview {
  alertMonitors: UpstreamResult<AlertMonitorsView>;
  alertHealth: UpstreamResult<ServiceHealthView>;
  observeHealth: UpstreamResult<ObserveHealthView>;
  backendDependencies: UpstreamResult<BackendDependenciesView>;
  deployMasterHealth: UpstreamResult<ServiceHealthView>;
}

/** 칸마다 필요한 설정: alertMonitors = alertUrl + alertSecret · alertHealth = alertUrl · observeHealth = observeUrl
 * · backendDependencies = backendUrl · deployMasterHealth = deployMasterUrl. 비었거나 http(s) 로 해석되지 않으면 그 칸만 not_configured(호출 없음). */
export interface StatusOverviewOptions {
  alertUrl: string;
  alertSecret: string;
  observeUrl: string;
  backendUrl: string;
  deployMasterUrl: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;   // 호출마다 5000 으로 부른다
}

/** 다섯 호출을 동시에 시작하고 전부 끝나면(각자 5초 안) 돌려준다 — 전체 소요는 가장 느린 한 호출에 묶인다. 거부(reject)하지 않는다. */
/** 사유 글자 → 가린 값. 빈 글자는 null. */
function maskedOrNull(text: string): string | null {
  return text.length === 0 ? null : maskUpstreamReason(text);
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** 2xx 만 받는 칸 — 2xx 면 parse(해석 불가면 unparseable), 아니면 상태 코드의 실패. */
function successOnly<Value>(response: UpstreamResponse, parse: (response: UpstreamResponse) => Value | null): UpstreamResult<Value> {
  if (!isSuccessStatus(response.status)) return failureForHttpStatus(response.status);
  const value = parse(response);
  return value === null ? upstreamFailure("unparseable") : { ok: true, value };
}

/** 헬스 본문이 계약 꼴이 아닐 때 — 503 이면 unavailable(503), 그 밖(2xx)은 unparseable. */
function malformedHealth(response: UpstreamResponse): UpstreamFailure {
  return response.status === 503 ? failureForHttpStatus(503) : upstreamFailure("unparseable");
}

/** 헬스 두 칸(alert · observe) — 200 과 503 은 본문의 상태 낱말로 판정한다. 503 인데 계약 꼴이 아니면 unavailable. */
function healthCell(response: UpstreamResponse, statuses: readonly string[], readFailure: boolean): UpstreamResult<ServiceHealthView> {
  if (!isSuccessStatus(response.status) && response.status !== 503) return failureForHttpStatus(response.status);
  const body = response.parsed && isRecord(response.json) ? response.json : null;
  const status = body?.status;
  let failure: string | null | undefined = null;
  if (readFailure && body !== null && body.failure !== undefined) failure = typeof body.failure === "string" ? maskedOrNull(body.failure) : undefined;
  if (body === null || typeof status !== "string" || !statuses.includes(status) || failure === undefined) return malformedHealth(response);
  return { ok: true, value: { status, healthy: status === "ok", failure } };
}

/** `lag` → 밀린 건수. 칸 없음 · -1 = null, -1 이상의 정수가 아니면 undefined(틀린 형). */
function readBacklog(lag: unknown): number | null | undefined {
  if (lag === undefined) return null;
  if (typeof lag !== "number" || !Number.isInteger(lag) || lag < -1) return undefined;
  return lag === -1 ? null : lag;
}

/** `last_stored_at` → 최근 로그 시각(받은 글자 그대로). 칸 없음 · "" = null, 글자가 아니거나 시각으로 읽히지 않으면 undefined(틀린 형). */
function readLastLogAt(lastStoredAt: unknown): string | null | undefined {
  if (lastStoredAt === undefined || lastStoredAt === "") return null;
  if (typeof lastStoredAt !== "string" || Number.isNaN(Date.parse(lastStoredAt))) return undefined;
  return lastStoredAt;
}

/** 관측 서버 헬스 칸 — 상태 낱말 판정(healthCell)에 밀린 건수 · 최근 로그 시각을 더한다. 두 칸의 형이 틀리면 칸 전체가 계약 꼴이 아니다. */
function observeHealthCell(response: UpstreamResponse): UpstreamResult<ObserveHealthView> {
  const cell = healthCell(response, OBSERVE_HEALTH_STATUSES, true);
  if (!cell.ok) return cell;
  const body = response.parsed && isRecord(response.json) ? response.json : {};   // healthCell 이 성공했으면 본문은 객체다(형 좁히기용)
  const backlog = readBacklog(body.lag);
  const lastLogAt = readLastLogAt(body.last_stored_at);
  if (backlog === undefined || lastLogAt === undefined) return malformedHealth(response);
  return { ok: true, value: { ...cell.value, backlog, lastLogAt } };
}

export function parseMonitors(response: UpstreamResponse): AlertMonitorsView | null {
  const data = envelopeData(response);
  if (data === undefined || !Array.isArray(data.monitors)) return null;
  const { last_round_at: lastRoundAt, undelivered } = data;
  if (typeof lastRoundAt !== "string" || !isNonNegativeInteger(undelivered)) return null;
  const monitors: AlertMonitorView[] = [];
  for (const row of data.monitors) {
    if (!isRecord(row)) return null;
    const { name, status, down_since: downSince, reason } = row;
    if (typeof name !== "string" || typeof downSince !== "string" || typeof reason !== "string") return null;
    if (typeof status !== "string" || !(MONITOR_STATUSES as readonly string[]).includes(status)) return null;
    monitors.push({ name, status: status as AlertMonitorView["status"], downSince: downSince === "" ? null : downSince, reason: maskUpstreamReason(reason) });
  }
  return { monitors, lastRoundAt: lastRoundAt === "" ? null : lastRoundAt, undelivered };
}

const DEPENDENCY_STATUSES = ["UP", "DOWN"] as const;

function isDependencyStatus(value: unknown): value is "UP" | "DOWN" {
  return typeof value === "string" && (DEPENDENCY_STATUSES as readonly string[]).includes(value);
}

function parseDependencies(response: UpstreamResponse): BackendDependenciesView | null {
  if (!response.parsed || !isRecord(response.json)) return null;
  const { status, components } = response.json;
  if (!isDependencyStatus(status) || !isRecord(components)) return null;
  const parsed: BackendDependencyView[] = [];
  for (const [name, component] of Object.entries(components)) {
    if (!isRecord(component) || !isDependencyStatus(component.status)) return null;
    const detail = component.detail;
    if (detail !== undefined && detail !== null && typeof detail !== "string") return null;
    parsed.push({ name, status: component.status, detail: typeof detail === "string" ? maskedOrNull(detail) : null });
  }
  return { status, components: parsed };
}

function parseMasterHealth(response: UpstreamResponse): ServiceHealthView | null {
  return envelopeData(response) === undefined ? null : { status: "ok", healthy: true, failure: null };
}

export function collectStatusOverview(options: StatusOverviewOptions): Promise<StatusOverview> {
  const call = async <Value>(baseUrl: string, path: string, headers: Record<string, string> | null,
                             interpret: (response: UpstreamResponse) => UpstreamResult<Value>): Promise<UpstreamResult<Value>> => {
    if (!isHttpBaseUrl(baseUrl) || headers === null) return upstreamFailure("not_configured");
    try {
      const getOptions: UpstreamGetOptions = { fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers };
      const response = await getUpstream(upstreamUrl(baseUrl, path), getOptions);
      return response.ok ? interpret(response) : response;
    } catch {
      return upstreamFailure("unparseable");   // 해석 중의 뜻밖의 예외 — 그 칸만 실패(거부하지 않는다)
    }
  };
  const alertSecretHeaders = options.alertSecret.length > 0 ? { "X-Alert-Secret": options.alertSecret } : null;
  // 다섯 호출을 한꺼번에 시작한다(각자 5초)
  const alertMonitors = call(options.alertUrl, "/monitors", alertSecretHeaders, (response) => successOnly(response, parseMonitors));
  const alertHealth = call(options.alertUrl, "/health", {}, (response) => healthCell(response, ALERT_HEALTH_STATUSES, false));
  const observeHealth = call(options.observeUrl, "/health", {}, observeHealthCell);
  const backendDependencies = call(options.backendUrl, "/api/health/dependencies", {}, (response) => successOnly(response, parseDependencies));
  const deployMasterHealth = call(options.deployMasterUrl, "/health", {}, (response) => successOnly(response, parseMasterHealth));
  return Promise.all([alertMonitors, alertHealth, observeHealth, backendDependencies, deployMasterHealth])
    .then(([alertMonitorsResult, alertHealthResult, observeHealthResult, backendDependenciesResult, deployMasterHealthResult]) => ({
      alertMonitors: alertMonitorsResult,
      alertHealth: alertHealthResult,
      observeHealth: observeHealthResult,
      backendDependencies: backendDependenciesResult,
      deployMasterHealth: deployMasterHealthResult,
    }));
}
