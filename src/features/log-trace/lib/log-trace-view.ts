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
 *   - 관측 서버의 limit 상한(LogController.kt:147 MAX_LIMIT 500)이 RELATED_LOG_MAXIMUM_LINES 와 같으므로 이어 보기는 하지 않는다.
 *   - 관측 서버는 최신순으로 주므로 남는 500줄은 창 안의 **최신** 500줄이다. 화면에는 시간순(옛것부터 — 받은 순서를 뒤집는다)으로 낸다.
 *   - **고른 줄은 반드시 목록에 있다**(명세 §11.2 세부 11-23). 첫 응답이 500줄을 채웠는데(nextBefore 가 null 이 아님) 고른 줄(id 글자 같음)이 그 안에 없으면
 *     첫 응답의 확인 호출은 하지 않고, 고른 줄에서 끝나는 500줄을 다시 받는다:
 *       같은 조건에 before = cursorJustAfter(고른 id), from · to = **첫 응답의** from · to, limit 500 → 이 응답을 연관 로그로 쓴다(hasNewer true).
 *     이 응답의 nextBefore 가 null 이 아니면 확인 1회: before = 그 nextBefore, from · to = **이 응답의** from · to, limit 1 → 1줄 이상이면 hasOlder true.
 *     다시 받는 호출 · 그 확인이 실패하면 relatedLogs 는 그 실패(조용히 고른 줄 없는 목록을 내지 않는다). 연관 로그 호출은 최대 3회.
 *   - 어느 경로로 받았든(첫 응답 · 다시 받은 응답, 0줄 포함) 최종 목록에 고른 줄이 없으면(확인 뒤 그 사이 지워짐 등) relatedLogs · requestSummary 는
 *     not_found — 고른 줄 없는 목록을 내지 않고, 확인 호출도 하지 않는다.
 *   - 고른 줄이 첫 응답 안에 있으면 위의 확인 규칙 그대로(추가 호출 없음) — hasNewer false · hasOlder = 확인 결과. 요청 ID 가 없는 로그(scope service)도 같다.
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
import { cursorJustAfter, type LogTraceQuery } from "@/features/log-trace/lib/log-trace-query";
import type { LogClient } from "@/features/logs/lib/log-client";
import { LOG_LEVELS, type LogEntryView, type LogLevel, type LogPage, type LogQuery } from "@/features/logs/lib/log-query";
import { parseIsoUtc } from "@/shared/lib/query-input";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

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
  /** 창 안에 보이는 줄 밖의 줄이 있다(어느 쪽이든) = hasOlder || hasNewer */
  hasMore: boolean;
  /** 보이는 가장 이른 줄보다 앞선 줄이 창 안에 더 있다. */
  hasOlder: boolean;
  /** 보이는 가장 늦은 줄보다 뒤의 줄이 창 안에 더 있다(고른 줄이 최신 500줄 밖이라 고른 줄에서 끝나는 500줄을 보일 때). */
  hasNewer: boolean;
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
  return (LOG_LEVELS as readonly string[]).indexOf(level);
}

/** 시간순 줄(옛것부터)의 요약. 줄이 없으면 null. */
export function summarizeRequest(lines: readonly LogEntryView[], hasMore: boolean): RequestSummary | null {
  if (lines.length === 0) return null;
  const first = lines[0];
  const last = lines[lines.length - 1];
  const services: string[] = [];
  let highestLevel: LogLevel = first.level;
  for (const line of lines) {
    if (!services.includes(line.service)) services.push(line.service);
    if (logLevelSeverity(line.level) > logLevelSeverity(highestLevel)) highestLevel = line.level;
  }
  const firstMilliseconds = parseIsoUtc(first.at);
  const lastMilliseconds = parseIsoUtc(last.at);
  // 읽히지 않는 시각은 buildLogTrace 가 먼저 unparseable 로 거른다 — 여기서 0 으로 숨기지 않고 NaN(화면 "—")
  const durationMilliseconds = firstMilliseconds === null || lastMilliseconds === null ? Number.NaN : lastMilliseconds - firstMilliseconds;
  return {
    services, firstAt: first.at, lastAt: last.at, durationMilliseconds,
    lineCount: lines.length, hasMore, highestLevel, firstMessage: first.message,
  };
}

const EMPTY_LOG_QUERY: LogQuery = { from: null, to: null, service: null, level: null, requestId: null, text: null, before: null, limit: 1 };

function isoText(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}

/** 고른 로그 확인 — 받은 첫 줄의 id 가 글자까지 같을 때만 그 줄. 줄이 없거나 다르면 "not_found". */
async function locateSelected(logs: LogClient, query: LogTraceQuery): Promise<UpstreamResult<LogEntryView> | "not_found"> {
  const moment = isoText(query.selectedAtMilliseconds);
  const page = await logs.searchLogs({ ...EMPTY_LOG_QUERY, from: moment, to: moment, before: cursorJustAfter(query.selectedLogId), limit: 1 });
  if (!page.ok) return page;
  const [found] = page.value.logs;
  return found !== undefined && found.id === query.selectedLogId ? { ok: true, value: found } : "not_found";
}

/** 꽉 찬 응답(nextBefore 가 null 이 아님) 뒤에 줄이 더 있는지 확인 1회(limit 1, from · to = 그 응답의 값). 꽉 차지 않았으면 false. */
export async function hasLinesBefore(logs: LogClient, relatedQuery: LogQuery, page: LogPage): Promise<UpstreamResult<boolean>> {
  if (page.nextBefore === null) return { ok: true, value: false };
  const probe = await logs.searchLogs({ ...relatedQuery, before: page.nextBefore, from: page.from, to: page.to, limit: 1 });
  if (!probe.ok) return probe;   // 조용히 false 로 두지 않는다
  return { ok: true, value: probe.value.logs.length > 0 };
}

/** 2단계 — 같은 요청 ID(±1시간) 또는 같은 서비스(±30초)의 최신 500줄. 고른 줄이 그 안에 없으면 고른 줄에서 끝나는 500줄을 다시 받는다. */
async function loadRelatedLogs(logs: LogClient, selected: LogEntryView, at: number): Promise<UpstreamResult<RelatedLogs>> {
  const scope: RelatedLogs["scope"] = selected.requestId !== "" ? "request" : "service";
  const window = scope === "request" ? RELATED_LOG_WINDOW_MILLISECONDS : SERVICE_LOG_WINDOW_MILLISECONDS;
  const from = isoText(at - window);
  const to = isoText(at + window);
  const relatedQuery: LogQuery = {
    ...EMPTY_LOG_QUERY, from, to, limit: RELATED_LOG_MAXIMUM_LINES,
    requestId: scope === "request" ? selected.requestId : null,
    service: scope === "service" ? selected.service : null,
  };
  const first = await logs.searchLogs(relatedQuery);
  if (!first.ok) return first;
  let shown: LogPage = first.value;
  let hasNewer = false;
  if (first.value.nextBefore !== null && !first.value.logs.some((entry) => entry.id === selected.id)) {
    // 고른 줄이 최신 500줄 밖 — 고른 줄(포함)에서 끝나는 500줄
    const endingAtSelected = await logs.searchLogs({
      ...relatedQuery, before: cursorJustAfter(selected.id), from: first.value.from, to: first.value.to,
    });
    if (!endingAtSelected.ok) return endingAtSelected;
    shown = endingAtSelected.value;
    hasNewer = true;
  }
  // 어느 경로로 받았든 고른 줄이 없으면(확인 뒤 그 사이 지워짐 등 — 0줄 포함) 고른 줄 없는 목록을 내지 않는다
  if (!shown.logs.some((entry) => entry.id === selected.id)) return upstreamFailure("not_found");
  const older = await hasLinesBefore(logs, relatedQuery, shown);
  if (!older.ok) return older;
  const hasOlder = older.value;
  const lines: TraceLine[] = [];
  let previousMilliseconds: number | null = null;
  for (const entry of [...shown.logs].reverse()) {   // 관측 서버는 최신순 — 화면은 옛것부터
    const entryMilliseconds = parseIsoUtc(entry.at);
    if (entryMilliseconds === null) return upstreamFailure("unparseable");
    lines.push({ ...entry, selected: entry.id === selected.id, gapMilliseconds: previousMilliseconds === null ? null : entryMilliseconds - previousMilliseconds });
    previousMilliseconds = entryMilliseconds;
  }
  return { ok: true, value: { scope, from, to, lines, hasMore: hasOlder || hasNewer, hasOlder, hasNewer } };
}

function countLevels(warnings: UpstreamResult<LogPage>, errors: UpstreamResult<LogPage>, at: number): UpstreamResult<LevelCounts> {
  if (!warnings.ok) return warnings;
  if (!errors.ok) return errors;
  const counts = new Map<string, ServiceLevelCount>();
  const countOf = (service: string) => {
    let count = counts.get(service);
    if (count === undefined) { count = { service, warning: 0, error: 0 }; counts.set(service, count); }
    return count;
  };
  for (const entry of warnings.value.logs) countOf(entry.service).warning += 1;
  for (const entry of errors.value.logs) countOf(entry.service).error += 1;
  const services = [...counts.values()].sort((left, right) => (left.service < right.service ? -1 : left.service > right.service ? 1 : 0));
  return {
    ok: true,
    value: {
      from: isoText(at - LEVEL_COUNT_WINDOW_MILLISECONDS), to: isoText(at + LEVEL_COUNT_WINDOW_MILLISECONDS), services,
      warningAtLimit: warnings.value.nextBefore !== null, errorAtLimit: errors.value.nextBefore !== null,
    },
  };
}

function deploymentsAround(listed: UpstreamResult<DeploymentSummary[]>, at: number): UpstreamResult<DeploymentsAround> {
  if (!listed.ok) return listed;
  const windowStart = at - CHANGE_WINDOW_MILLISECONDS;
  const windowEnd = at + CHANGE_WINDOW_MILLISECONDS;
  const inWindow = (milliseconds: number | null) => milliseconds !== null && milliseconds >= windowStart && milliseconds <= windowEnd;
  const deployments: DeploymentSummary[] = [];
  let oldestAcceptedMilliseconds: number | null = null;
  for (const deployment of listed.value) {
    const acceptedMilliseconds = parseIsoUtc(deployment.acceptedAt);
    const finishedMilliseconds = deployment.finishedAt === null ? null : parseIsoUtc(deployment.finishedAt);
    if (acceptedMilliseconds === null || (deployment.finishedAt !== null && finishedMilliseconds === null)) return upstreamFailure("unparseable");
    if (inWindow(acceptedMilliseconds) || inWindow(finishedMilliseconds)) deployments.push(deployment);
    oldestAcceptedMilliseconds = acceptedMilliseconds;   // master 는 최신순 — 마지막 항목이 가장 오래된 것
  }
  const coversWindow = listed.value.length < DEPLOYMENT_LOOKUP_LIMIT || (oldestAcceptedMilliseconds !== null && oldestAcceptedMilliseconds < windowStart);
  return { ok: true, value: { from: isoText(windowStart), to: isoText(windowEnd), deployments, coversWindow } };
}

function incidentsAround(listed: UpstreamResult<IncidentSummary[]>, at: number): UpstreamResult<IncidentsAround> {
  if (!listed.ok) return listed;
  const windowStart = at - CHANGE_WINDOW_MILLISECONDS;
  const windowEnd = at + CHANGE_WINDOW_MILLISECONDS;
  const incidents: IncidentSummary[] = [];
  let earliestMilliseconds = Number.POSITIVE_INFINITY;
  for (const incident of listed.value) {
    const incidentMilliseconds = parseIsoUtc(incident.at);
    if (incidentMilliseconds === null) return upstreamFailure("unparseable");
    if (incidentMilliseconds >= windowStart && incidentMilliseconds <= windowEnd) incidents.push(incident);
    earliestMilliseconds = Math.min(earliestMilliseconds, incidentMilliseconds);
  }
  const coversWindow = listed.value.length < INCIDENT_LOOKUP_LIMIT || earliestMilliseconds < windowStart;
  return { ok: true, value: { from: isoText(windowStart), to: isoText(windowEnd), incidents, coversWindow } };
}

interface LocatedWithRelated {
  located: UpstreamResult<LogEntryView> | "not_found";
  related: UpstreamResult<RelatedLogs> | null;
}

/** onSelectedService(선택): 고른 로그 확인(1단계 a)이 끝나는 대로 한 번 — 확인되면 그 줄의 service, 확인하지 못함 · not_found · 관측 서버 설정 없음이면 null.
 * (연관 로그의 자원 칸이 전체를 기다리지 않고 서비스를 알게 — server/log-trace-resources.ts.) 호출 · 결과는 이 인자와 무관하게 그대로다. */
export async function buildLogTrace(
  dependencies: LogTraceDependencies, query: LogTraceQuery, onSelectedService?: (service: string | null) => void,
): Promise<LogTraceOutcome> {
  const at = query.selectedAtMilliseconds;
  const notConfigured = upstreamFailure("not_configured");
  const { logs, deployHistory, incidents } = dependencies;

  // 1단계 — 다섯 호출을 한꺼번에. 2단계(연관 로그)는 고른 로그 확인이 끝나는 대로 이어 붙인다(b~e 를 기다리지 않는다).
  if (logs === null) onSelectedService?.(null);
  const locatedWithRelated: Promise<LocatedWithRelated> = logs === null
    ? Promise.resolve({ located: notConfigured, related: null })
    : locateSelected(logs, query).then(async (located) => {
      onSelectedService?.(located !== "not_found" && located.ok ? located.value.service : null);
      return { located, related: located !== "not_found" && located.ok ? await loadRelatedLogs(logs, located.value, at) : null };
    });
  const levelWindow = { from: isoText(at - LEVEL_COUNT_WINDOW_MILLISECONDS), to: isoText(at + LEVEL_COUNT_WINDOW_MILLISECONDS), limit: LEVEL_COUNT_LIMIT };
  const warningsPromise: Promise<UpstreamResult<LogPage>> = logs === null
    ? Promise.resolve(notConfigured) : logs.searchLogs({ ...EMPTY_LOG_QUERY, ...levelWindow, level: "warning" });
  const errorsPromise: Promise<UpstreamResult<LogPage>> = logs === null
    ? Promise.resolve(notConfigured) : logs.searchLogs({ ...EMPTY_LOG_QUERY, ...levelWindow, level: "error" });
  const deploymentsPromise: Promise<UpstreamResult<DeploymentSummary[]>> = deployHistory === null
    ? Promise.resolve(notConfigured) : deployHistory.listDeployments({ service: null, limit: DEPLOYMENT_LOOKUP_LIMIT });
  const incidentsPromise: Promise<UpstreamResult<IncidentSummary[]>> = incidents === null
    ? Promise.resolve(notConfigured) : incidents.listIncidents(INCIDENT_LOOKUP_LIMIT);

  const [{ located, related }, warnings, errors, listedDeployments, listedIncidents] = await Promise.all([
    locatedWithRelated, warningsPromise, errorsPromise, deploymentsPromise, incidentsPromise,
  ]);
  if (located === "not_found") return { kind: "not_found" };

  const serverState: ServerStateAround = {
    levelCounts: countLevels(warnings, errors, at),
    deployments: deploymentsAround(listedDeployments, at),
    incidents: incidentsAround(listedIncidents, at),
  };
  if (!located.ok) {
    return { kind: "view", view: { query, selected: located, requestSummary: located, relatedLogs: located, serverState } };
  }
  const relatedLogs = related as UpstreamResult<RelatedLogs>;   // 고른 로그를 찾았으면 언제나 2단계를 돈다
  let requestSummary: UpstreamResult<RequestSummary> | null = null;
  if (located.value.requestId !== "") {
    if (!relatedLogs.ok) requestSummary = relatedLogs;
    else {
      const summary = summarizeRequest(relatedLogs.value.lines, relatedLogs.value.hasMore);
      requestSummary = summary === null ? upstreamFailure("not_found") : { ok: true, value: summary };
    }
  }
  return { kind: "view", view: { query, selected: located, requestSummary, relatedLogs, serverState } };
}
