/** 연관 로그 조립(순수 — 관측 · master · 알림 클라이언트는 주입, 클라이언트가 null 이면 그 출처의 칸은 not_configured 이고 부르지 않는다). 명세 §11.2.
 * 기준 시각 T = query.selectedAtMilliseconds(로그 id 의 밀리초). 시각 글자는 `new Date(ms).toISOString()`(밀리초 3자리, Z).
 *
 * 1단계 — 다섯 호출을 **한꺼번에** 시작한다(서로 기다리지 않는다):
 *   a. 고른 로그 확인: logs.searchLogs({ from: T, to: T, before: cursorJustAfter(id), limit: 1, 나머지 null })
 *      → 받은 첫 줄의 id 가 selectedLogId 와 글자까지 같으면 그 줄(selected), 줄이 없거나 다르면 { kind: "not_found" }.
 *   b. ±5분 warning 줄: logs.searchLogs({ level: "warning", from: T-5분, to: T+5분, limit: 500 })
 *   c. ±5분 error 줄:   logs.searchLogs({ level: "error",   from: T-5분, to: T+5분, limit: 500 })
 *   d. 배포: deployHistory.listDeployments({ service: null, limit: 200 })
 *   e. 알림: incidents.listIncidents(200)
 *   (b~e 는 a 의 결과와 무관하게 T 로 조회한다 — 고른 로그 확인이 실패해도 4 구역은 값이 있다.)
 * 2단계 — a 가 성공했을 때만, **a 가 끝나는 대로**(b~e 를 기다리지 않는다 — 전체 소요 = max(b~e, a + 2단계)) 연관 로그(관측 서버 1~2회):
 *   - 요청 ID 가 있으면(scope "request"): searchLogs({ requestId, from: T-1시간, to: T+1시간, limit: 500 })
 *   - 없으면(scope "service"): searchLogs({ service: selected.service, from: T-30초, to: T+30초, limit: 500 })
 *   - 첫 응답의 nextBefore 가 null 이 아니면(500줄을 꽉 채움) 확인 1회: 같은 조건에 before = nextBefore, from · to = **첫 응답의** from · to, limit 1
 *     → 1줄 이상이면 hasMore true(501줄 이상), 0줄이면 false(정확히 500줄). 확인이 실패하면 relatedLogs 는 그 실패(조용히 false 로 두지 않는다).
 *   - 관측 서버의 limit 상한(LogController.kt:147 MAX_LIMIT 500)이 RELATED_LOG_MAXIMUM_LINES 와 같으므로 이어 보기는 하지 않는다 — 연관 로그 호출은 최대 2회.
 *   - 관측 서버는 최신순으로 주므로 남는 500줄은 창 안의 **최신** 500줄이다. 화면에는 시간순(옛것부터 — 받은 순서를 뒤집는다)으로 낸다.
 * 칸의 결과:
 *   - selected: a 의 결과(관측 실패면 그 이유).
 *   - relatedLogs: a 가 실패면 a 와 같은 실패, 아니면 2단계 결과.
 *   - requestSummary: 요청 ID 가 없으면 null. a 실패면 a 의 실패, 2단계 실패면 그 실패. 연관 로그가 0줄이면 not_found. 그 밖은 summarizeRequest.
 *   - serverState.levelCounts: b · c 중 하나라도 실패면 그 실패(b 를 먼저 본다). 서비스별 줄 수는 service 이름 오름차순, 줄 수 0 인 서비스는 없다.
 *     warningAtLimit · errorAtLimit = 그 수준의 응답이 500줄을 채움(nextBefore 가 null 이 아님 — "500건 이상").
 *   - serverState.deployments: d 의 목록에서 acceptedAt 또는 finishedAt 이 [T-30분, T+30분](양끝 포함)에 드는 것만, master 순서(최신순) 그대로.
 *     acceptedAt · finishedAt(있을 때)이 parseIsoUtc 로 읽히지 않는 항목이 하나라도 있으면 unparseable.
 *     coversWindow = 목록이 200건 미만이거나 마지막(가장 오래된) 항목의 acceptedAt < T-30분 — 아니면 이력 200건이 창의 앞쪽에 닿지 못했다(false).
 *   - serverState.incidents: e 의 목록에서 at 이 [T-30분, T+30분]에 드는 것만, 알림 서버 순서 그대로.
 *     coversWindow = 목록이 200건 미만이거나 목록에서 가장 이른 at < T-30분.
 *   - 연관 로그 줄의 at 이 parseIsoUtc 로 읽히지 않으면 relatedLogs(와 requestSummary)는 unparseable(시간 차를 잴 수 없다).
 * 거부(reject)하지 않는다 — 클라이언트가 실패를 돌려주면 그 칸만 실패. */
import type { DeployHistoryClient, DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import type { IncidentClient, IncidentSummary } from "@/features/log-trace/lib/incident-client";
import type { LogTraceQuery } from "@/features/log-trace/lib/log-trace-query";
import type { LogClient } from "@/features/logs/lib/log-client";
import type { LogEntryView, LogLevel } from "@/features/logs/lib/log-query";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

export const RELATED_LOG_WINDOW_MILLISECONDS = 60 * 60 * 1000;
export const SERVICE_LOG_WINDOW_MILLISECONDS = 30 * 1000;
export const LEVEL_COUNT_WINDOW_MILLISECONDS = 5 * 60 * 1000;
/** 배포 · 알림 기록의 창(앞뒤 30분). */
export const CHANGE_WINDOW_MILLISECONDS = 30 * 60 * 1000;
export const RELATED_LOG_MAXIMUM_LINES = 500;
export const LEVEL_COUNT_LIMIT = 500;
/** master 의 상한(master.go:342). */
export const DEPLOYMENT_LOOKUP_LIMIT = 200;
/** 알림 서버의 상한(AlertController.kt:101). */
export const INCIDENT_LOOKUP_LIMIT = 200;

/** 연관 로그 한 줄 — 로그의 칸 그대로 + 고른 줄 표시 + 앞줄과의 시간 차(첫 줄은 null). */
export interface TraceLine extends LogEntryView {
  selected: boolean;
  /** 이 줄의 at − 앞줄의 at(밀리초). 첫 줄은 null */
  gapMilliseconds: number | null;
}

export interface RelatedLogs {
  /** request = 같은 요청 ID(±1시간) · service = 요청 ID 가 없어 같은 서비스의 ±30초 */
  scope: "request" | "service";
  /** 조회한 창(T−창 · T+창의 ISO 글자) */
  from: string;
  to: string;
  /** 시간순(옛것부터), 최대 500줄 */
  lines: TraceLine[];
  /** 창 안에 500줄보다 많다(남긴 것은 최신 500줄) */
  hasMore: boolean;
}

export interface RequestSummary {
  /** 거친 서비스 — 처음 등장 순, 중복 없음 */
  services: string[];
  firstAt: string;
  lastAt: string;
  /** lastAt − firstAt(밀리초) */
  durationMilliseconds: number;
  /** 연관 로그의 줄 수(남긴 줄 기준 — hasMore 면 그 이상) */
  lineCount: number;
  hasMore: boolean;
  /** error > warning > info > debug */
  highestLevel: LogLevel;
  /** 가장 이른 줄의 메시지(글자 그대로) */
  firstMessage: string;
}

export interface ServiceLevelCount {
  service: string;
  warning: number;
  error: number;
}

export interface LevelCounts {
  from: string;
  to: string;
  /** service 이름 오름차순 */
  services: ServiceLevelCount[];
  warningAtLimit: boolean;
  errorAtLimit: boolean;
}

export interface DeploymentsAround {
  from: string;
  to: string;
  deployments: DeploymentSummary[];
  coversWindow: boolean;
}

export interface IncidentsAround {
  from: string;
  to: string;
  incidents: IncidentSummary[];
  coversWindow: boolean;
}

export interface ServerStateAround {
  levelCounts: UpstreamResult<LevelCounts>;
  deployments: UpstreamResult<DeploymentsAround>;
  incidents: UpstreamResult<IncidentsAround>;
}

export interface LogTraceView {
  query: LogTraceQuery;
  selected: UpstreamResult<LogEntryView>;
  /** 요청 ID 가 없는 로그면 null */
  requestSummary: UpstreamResult<RequestSummary> | null;
  relatedLogs: UpstreamResult<RelatedLogs>;
  serverState: ServerStateAround;
}

export type LogTraceOutcome =
  | { kind: "view"; view: LogTraceView }
  | { kind: "not_found" }
  | { kind: "invalid_input"; field: string };

export interface LogTraceDependencies {
  /** null = 관측 서버 설정 없음(selected · requestSummary · relatedLogs · levelCounts = not_configured, 호출 없음 — not_found 가 될 수 없다) */
  logs: LogClient | null;
  /** null = master 설정 없음(deployments = not_configured) */
  deployHistory: DeployHistoryClient | null;
  /** null = 알림 서버 설정 없음(incidents = not_configured) */
  incidents: IncidentClient | null;
}

/** 수준의 높낮이 — debug 0 · info 1 · warning 2 · error 3, 그 밖의 값은 −1(가장 낮다). */
export function logLevelSeverity(level: string): number {
  void level;
  throw new Error("not implemented");
}

/** 시간순 줄(옛것부터)의 요약. 줄이 없으면 null. */
export function summarizeRequest(lines: readonly LogEntryView[], hasMore: boolean): RequestSummary | null {
  void lines;
  void hasMore;
  throw new Error("not implemented");
}

export async function buildLogTrace(dependencies: LogTraceDependencies, query: LogTraceQuery): Promise<LogTraceOutcome> {
  void dependencies;
  void query;
  throw new Error("not implemented");
}
