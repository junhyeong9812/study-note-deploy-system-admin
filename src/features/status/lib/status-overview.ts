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
 *   `{status:"ok"|"unreachable"|"failing"|"starting"|"stalled", …}` — 200 은 ok 하나뿐, 나머지는 503.
 * - backend `GET /api/health/dependencies`(backend shared/api/DependencyHealthController.kt:29-45, 인증 없음, 봉투 없음, 항상 200):
 *   `{status:"UP"|"DOWN", components:{<이름>:{status:"UP"|"DOWN", detail?}}}`.
 * - master `GET /health`(ci-cd cmd/server/main.go:19-21, 인증 없음): `{success:true,data:{mode}}`.
 * 헬스 둘(alert · observe)은 503 이어도 본문이 계약 꼴이면 실패가 아니라 그 상태 낱말(healthy:false)로 넘긴다. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

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
  observeHealth: UpstreamResult<ServiceHealthView>;
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
export function collectStatusOverview(options: StatusOverviewOptions): Promise<StatusOverview> {
  void options;
  throw new Error("not implemented");
}
