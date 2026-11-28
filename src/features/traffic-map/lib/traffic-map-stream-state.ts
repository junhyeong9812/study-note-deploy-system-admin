/** 통신 지도의 브라우저 쪽 상태(순수 — 브라우저 조각이 쓴다: 서버 모듈 · 설정 · 클라이언트 · fetch 없음).
 * EventSource 의 사건(open · map · error · session — 의존의 사건 dependencies 는 dispatchDependencies 로)을 화면 상태로 접는다 + EventSource 를 잇고 끊는 함수(EventSource 는 주입).
 * - map: 깨진 사건(JSON 아님 · 칸 빠짐 · 형이 다름)은 버리고 brokenEvents 를 센다(앞의 값을 그대로) · sequence 가 마지막 것보다 작거나 같으면 버린다
 *   (같은 사건 두 번 · 늦게 온 옛 사건) · 성공한 지도는 shown 을 갈고 failure 를 지운다 · 실패는 failure 에만(shown 은 그대로 — 낡은 값으로 표시).
 *   진도 · 채움의 값은 사건에 실린 그대로 쓴다(앞의 사건보다 덜 채워져도 — 진도는 뒤로 갈 수 있다).
 * - open: lastSequence 를 비운다(다시 붙으면 전체를 새로 받는다 — 서버가 다시 떴으면 sequence 가 작아진다). 끊긴 뒤의 open 은 "reopened"
 *   (그 연결에서 지도를 받기 전에는 낡은 값이다 — "실시간"이 아니다), 맨 처음의 open 은 "connecting" 그대로. 받아들인 map 사건(실패 포함)이 "open" 으로 바꾼다
 *   (깨진 사건 · 옛 사건은 받은 것이 아니다).
 * - error: "reconnecting"(세션이 끝난 뒤는 그대로). session: "session_ended"(다시 붙지 않는다). */
import type { Scheduler, ScheduledTask } from "@/features/auth/lib/replay-scheduler";
import type { TrafficQuantile, TrafficStatusCounts } from "@/features/traffic-map/lib/traffic-map-client";
import type { TrafficDependencyStreamAction } from "@/features/traffic-map/lib/traffic-dependency-stream";
import type { TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";
import { TRAFFIC_MAP_RANGES, type TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import {
  TRAFFIC_CLASS_NAMES, TRAFFIC_MISSING_PATTERN, TRAFFIC_NAME_PATTERN, TRAFFIC_SERVER_NAME_PATTERN, type EdgeCompleteness, type TrafficMapEdgeView,
  type TrafficMapServerView, type TrafficMapView,
} from "@/features/traffic-map/lib/traffic-map-view";
import { parseIsoUtc } from "@/shared/lib/query-input";
import { MASKED_ADDRESS } from "@/shared/lib/upstream-reason";
import { UPSTREAM_FAILURE_MESSAGES, upstreamFailure, type UpstreamFailure, type UpstreamFailureReason, type UpstreamResult } from "@/shared/lib/upstream-result";

/** EventSource 가 닫힌(CLOSED — 서버가 200 이 아닌 답을 줬을 때 등) 뒤 새로 여는 간격. */
export const TRAFFIC_STREAM_RECONNECT_MILLISECONDS = 5_000;
export const TRAFFIC_STREAM_PATH = "/api/traffic/stream";

export type TrafficStreamConnection = "connecting" | "open" | "reconnecting" | "reopened" | "session_ended";

export interface TrafficMapStreamState {
  connection: TrafficStreamConnection;
  /** 화면이 그리는 지도 — 마지막으로 받은 성공한 사건 */
  shown: TrafficMapEvent | null;
  /** 마지막으로 받은 사건이 실패였으면 그 실패 */
  failure: UpstreamFailure | null;
  lastSequence: number | null;
  /** 마지막으로 받아들인 사건의 fetchedAt */
  lastReceivedAt: string | null;
  brokenEvents: number;
}

export type TrafficMapStreamAction =
  | { type: "open" }
  | { type: "map"; data: string }
  | { type: "error" }
  | { type: "session" };

export function initialTrafficMapStreamState(initial: TrafficMapEvent | null): TrafficMapStreamState {
  return {
    connection: "connecting", shown: initial !== null && initial.map.ok ? initial : null, failure: initial !== null && !initial.map.ok ? initial.map : null,
    lastSequence: initial?.sequence ?? null, lastReceivedAt: initial?.fetchedAt ?? null, brokenEvents: 0,
  };
}

// 사건의 검증 — 화면 모델의 칸을 모두 보고, 아는 칸만으로 다시 만든다(모르는 칸은 버린다). 하나라도 틀리면 null.
const COMPLETENESS: readonly EdgeCompleteness[] = ["settled", "filling", "unknown"];

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isIso = (value: unknown): value is string => typeof value === "string" && parseIsoUtc(value) !== null;
const isName = (value: unknown): value is string => typeof value === "string" && TRAFFIC_NAME_PATTERN.test(value);
/** 화면에 실린 서버 이름 · 읽지 못한 범위는 주소 꼴이 `(주소)` 로 가려져 있다 — 가린 자리를 뺀 나머지가 관측 서버의 꼴이어야 한다. */
const isMasked = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value.split(MASKED_ADDRESS).join("x"));
const isNullable = <Value>(value: unknown, check: (candidate: unknown) => candidate is Value): value is Value | null => value === null || check(value);

function parseQuantile(value: unknown): TrafficQuantile | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || (value.kind !== "at_most" && value.kind !== "over") || !isCount(value.milliseconds)) return undefined;
  return { kind: value.kind, milliseconds: value.milliseconds };
}

function parseStatus(value: unknown): TrafficStatusCounts | null {
  if (!isRecord(value) || !isCount(value["2xx"]) || !isCount(value["3xx"]) || !isCount(value["4xx"]) || !isCount(value["5xx"]) || !isCount(value.other)) return null;
  return { "2xx": value["2xx"], "3xx": value["3xx"], "4xx": value["4xx"], "5xx": value["5xx"], other: value.other };
}

function parseEdge(value: unknown): TrafficMapEdgeView | null {
  if (!isRecord(value)) return null;
  const { service, caller, trafficClass, count, errorRate, maxMilliseconds, fillingCount, callerKnown, serviceKnown, completeness } = value;
  if (!isName(service) || !isName(caller) || typeof trafficClass !== "string" || !(TRAFFIC_CLASS_NAMES as readonly string[]).includes(trafficClass)) return null;
  if (!isCount(count) || !isCount(fillingCount) || !isNullable(maxMilliseconds, isCount)) return null;
  if (errorRate !== null && !(typeof errorRate === "number" && errorRate >= 0 && errorRate <= 1)) return null;
  if (typeof callerKnown !== "boolean" || typeof serviceKnown !== "boolean") return null;
  if (typeof completeness !== "string" || !(COMPLETENESS as readonly string[]).includes(completeness)) return null;
  const status = parseStatus(value.status);
  const p50 = parseQuantile(value.p50);
  const p95 = parseQuantile(value.p95);
  if (status === null || p50 === undefined || p95 === undefined) return null;
  return {
    service, caller, trafficClass: trafficClass as TrafficMapEdgeView["trafficClass"], count, status, errorRate: errorRate as number | null, p50, p95,
    maxMilliseconds, fillingCount, callerKnown, serviceKnown, completeness: completeness as EdgeCompleteness,
  };
}

function parseServer(value: unknown): TrafficMapServerView | null {
  if (!isRecord(value)) return null;
  const { server, readProgressAt, receiveDelayed, sequenceGaps, lastReceivedAt, missing, requestsDropped, requestsRejected, firstSeqSeen, behind } = value;
  if (!isMasked(server, TRAFFIC_SERVER_NAME_PATTERN) || !isNullable(readProgressAt, isIso) || !isNullable(lastReceivedAt, isIso)) return null;
  if (typeof receiveDelayed !== "boolean" || typeof behind !== "boolean") return null;
  if (!isCount(sequenceGaps) || !isCount(requestsDropped) || !isCount(requestsRejected) || !isNullable(firstSeqSeen, isCount)) return null;
  if (!Array.isArray(missing) || !missing.every((item) => isMasked(item, TRAFFIC_MISSING_PATTERN))) return null;
  return {
    server, readProgressAt, receiveDelayed, sequenceGaps, lastReceivedAt, missing: [...missing] as string[], requestsDropped, requestsRejected, firstSeqSeen, behind,
  };
}

/** 한 줄이라도 틀리면 null. */
function parseList<Item>(value: unknown, parse: (row: unknown) => Item | null): Item[] | null {
  if (!Array.isArray(value)) return null;
  const items: Item[] = [];
  for (const row of value) {
    const item = parse(row);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

function parseView(value: unknown): TrafficMapView | null {
  if (!isRecord(value) || !isIso(value.from) || !isIso(value.to)) return null;
  const { edgeTotal, edgesTruncated, hasFilling } = value;
  if (!isCount(edgeTotal) || typeof edgesTruncated !== "boolean" || typeof hasFilling !== "boolean") return null;
  const servers = parseList(value.servers, parseServer);
  const edges = parseList(value.edges, parseEdge);
  const nodes = parseList(value.nodes, (row) => (isName(row) ? row : null));
  const delayedServers = parseList(value.delayedServers, (row) => (isMasked(row, TRAFFIC_SERVER_NAME_PATTERN) ? row : null));
  const gapServers = parseList(value.gapServers, (row) => (isRecord(row) && isMasked(row.server, TRAFFIC_SERVER_NAME_PATTERN) && isCount(row.sequenceGaps)
    ? { server: row.server, sequenceGaps: row.sequenceGaps } : null));
  if (servers === null || edges === null || nodes === null || delayedServers === null || gapServers === null) return null;
  return { from: value.from, to: value.to, servers, edges, edgeTotal, edgesTruncated, nodes, delayedServers, gapServers, hasFilling };
}

/** 실패 — 받은 글은 버리고 이유 · 상태로 고정 표의 글자를 다시 만든다. */
function parseFailure(value: UnknownRecord): UpstreamFailure | null {
  const { reason, status } = value;
  if (typeof reason !== "string" || !Object.hasOwn(UPSTREAM_FAILURE_MESSAGES, reason)) return null;
  if (status !== undefined && !(Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599)) return null;
  return upstreamFailure(reason as UpstreamFailureReason, status === undefined ? {} : { status: status as number });
}

/** 사건의 data — 꼴이 틀리면 null. */
export function parseTrafficMapEvent(data: string): TrafficMapEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(event) || !isCount(event.sequence) || !isIso(event.fetchedAt)) return null;
  if (typeof event.range !== "string" || !(TRAFFIC_MAP_RANGES as readonly string[]).includes(event.range) || !isRecord(event.map)) return null;
  let map: UpstreamResult<TrafficMapView> | null = null;
  if (event.map.ok === true) {
    const view = parseView(event.map.value);
    map = view === null ? null : { ok: true, value: view };
  } else if (event.map.ok === false) {
    map = parseFailure(event.map);
  }
  return map === null ? null : { sequence: event.sequence, fetchedAt: event.fetchedAt, range: event.range as TrafficMapRange, map };
}

export function reduceTrafficMapStream(state: TrafficMapStreamState, action: TrafficMapStreamAction): TrafficMapStreamState {
  switch (action.type) {
    case "open": {
      if (state.connection === "session_ended") return state;
      const connection = state.connection === "reconnecting" || state.connection === "reopened" ? "reopened" : state.connection;
      return { ...state, connection, lastSequence: null };
    }
    case "error":
      return state.connection === "session_ended" ? state : { ...state, connection: "reconnecting" };
    case "session":
      return { ...state, connection: "session_ended" };
    case "map": {
      const event = parseTrafficMapEvent(action.data);
      if (event === null) return { ...state, brokenEvents: state.brokenEvents + 1 };
      if (state.lastSequence !== null && event.sequence <= state.lastSequence) return state;
      const received: TrafficMapStreamState = {
        ...state, connection: state.connection === "session_ended" ? "session_ended" : "open", lastSequence: event.sequence, lastReceivedAt: event.fetchedAt,
      };
      return event.map.ok ? { ...received, shown: event, failure: null } : { ...received, failure: event.map };
    }
  }
}

/** 브라우저의 EventSource 가운데 쓰는 것만. readyState: 0 CONNECTING · 1 OPEN · 2 CLOSED. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export interface TrafficMapStreamConnectOptions {
  url: string;
  createEventSource: (url: string) => EventSourceLike;
  dispatch: (action: TrafficMapStreamAction) => void;
  /** 의존의 선(⑬ T9d) — `open` 마다 {type:"open"}, `dependencies` 사건마다 {type:"dependencies", data}(살아 있는 연결의 것만). */
  dispatchDependencies?: (action: TrafficDependencyStreamAction) => void;
  scheduler: Scheduler;
}

/** 잇는다 — 돌려주는 함수를 부르면 닫고 다시 여는 타이머를 거둔다(그 뒤로는 dispatch 하지 않는다).
 * 끊김에서 브라우저가 스스로 다시 붙는 동안(CONNECTING)은 기다리고, 닫혔으면(CLOSED — 401 · 502 등) 5초 뒤 새로 연다. 세션 끝 사건이면 닫고 다시 열지 않는다. */
export function connectTrafficMapStream(options: TrafficMapStreamConnectOptions): () => void {
  let stopped = false;
  let current: EventSourceLike | null = null;
  let reopen: ScheduledTask | null = null;

  function open() {
    reopen = null;
    const source = options.createEventSource(options.url);
    current = source;
    const live = () => !stopped && current === source;
    source.addEventListener("open", () => {
      if (!live()) return;
      options.dispatch({ type: "open" });
      options.dispatchDependencies?.({ type: "open" });
    });
    source.addEventListener("dependencies", (event) => {
      if (live()) options.dispatchDependencies?.({ type: "dependencies", data: typeof event.data === "string" ? event.data : "" });
    });
    source.addEventListener("map", (event) => {
      if (live()) options.dispatch({ type: "map", data: typeof event.data === "string" ? event.data : "" });
    });
    source.addEventListener("session", () => {
      if (!live()) return;
      stopped = true;
      source.close();
      options.dispatch({ type: "session" });
    });
    source.addEventListener("error", () => {
      if (!live()) return;
      options.dispatch({ type: "error" });
      if (source.readyState === 2) {
        source.close();
        reopen = options.scheduler(open, TRAFFIC_STREAM_RECONNECT_MILLISECONDS);
      }
    });
  }

  open();
  return () => {
    stopped = true;
    current?.close();
    reopen?.cancel();
    reopen = null;
  };
}
