/** 관측 서버 지도 조회 클라이언트(순수 — 설정을 읽지 않는다).
 * `GET <OBSERVE_URL>/traffic/map?from=&to=` → `{success,data:{from, to, servers[], edges[]}}`(observe traffic/TrafficController.kt:90-113 · 185-218).
 * 헤더 `X-Observe-Secret`, 5초 기한, GET 만, redirect:"manual", no-store(getUpstream). 오류 상태는 failureForHttpStatus(원문 없음).
 * 꼴이 틀리면 전체 unparseable(0 · 빈 목록으로 메우지 않는다) — 모르는 칸은 버린다. 이름의 꼴은 관측 서버가 받는 꼴(traffic-map-view 의 패턴). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import {
  TRAFFIC_CLASS_NAMES, TRAFFIC_MISSING_PATTERN, TRAFFIC_NAME_PATTERN, TRAFFIC_SERVER_NAME_PATTERN,
} from "@/features/traffic-map/lib/traffic-map-view";
import { parseIsoUtc } from "@/shared/lib/query-input";
import { envelopeData, getUpstream, isNonNegativeInteger, isRecord, upstreamUrl } from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export type TrafficClassName = "request" | "health" | "stream";

/** 분위수 — 관측 서버의 `{le_ms}`(그 칸의 위쪽 경계 이하) 또는 `{gt_ms}`(20번째 칸 — 180초 초과). */
export type TrafficQuantile = { kind: "at_most"; milliseconds: number } | { kind: "over"; milliseconds: number };

export interface TrafficStatusCounts {
  "2xx": number;
  "3xx": number;
  "4xx": number;
  "5xx": number;
  other: number;
}

/** 선 하나(관측 서버 `edges[]` — 서버들을 합친 (service, caller, class)). 수치는 채워진 칸만, 채우는 중인 칸의 요청 수는 fillingCount. */
export interface TrafficMapEdge {
  service: string;
  caller: string;
  trafficClass: TrafficClassName;
  count: number;
  status: TrafficStatusCounts;
  /** 5xx ÷ count — count 0 이면 null */
  errorRate: number | null;
  p50: TrafficQuantile | null;
  p95: TrafficQuantile | null;
  maxMilliseconds: number | null;
  fillingCount: number;
}

/** 서버 하나의 수신 상태(관측 서버 `servers[]`). */
export interface TrafficMapServer {
  server: string;
  readProgressAt: string | null;
  receiveDelayed: boolean;
  sequenceGaps: number;
  lastReceivedAt: string | null;
  missing: string[];
  requestsDropped: number;
  requestsRejected: number;
  firstSeqSeen: number | null;
}

export interface TrafficMapSnapshot {
  /** 관측 서버가 실제로 쓴 기간(ISO) */
  from: string;
  to: string;
  servers: TrafficMapServer[];
  edges: TrafficMapEdge[];
}

export interface TrafficMapClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface TrafficMapClient {
  trafficMap(from: string, to: string): Promise<UpstreamResult<TrafficMapSnapshot>>;
}

const STATUS_KEYS = ["2xx", "3xx", "4xx", "5xx", "other"] as const;

function isIsoText(value: unknown): value is string {
  return typeof value === "string" && parseIsoUtc(value) !== null;
}

function isMatching(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

/** 관측 서버의 분위수 — `{le_ms}` 또는 `{gt_ms}` 하나(둘 다 · 둘 다 없음은 틀림) 또는 null. 틀리면 undefined. */
function parseQuantile(value: unknown): TrafficQuantile | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { le_ms: atMost, gt_ms: over } = value;
  if (atMost !== undefined && over === undefined && isNonNegativeInteger(atMost)) return { kind: "at_most", milliseconds: atMost };
  if (over !== undefined && atMost === undefined && isNonNegativeInteger(over)) return { kind: "over", milliseconds: over };
  return undefined;
}

function parseStatus(value: unknown): TrafficStatusCounts | null {
  if (!isRecord(value) || !STATUS_KEYS.every((key) => isNonNegativeInteger(value[key]))) return null;
  return { "2xx": value["2xx"] as number, "3xx": value["3xx"] as number, "4xx": value["4xx"] as number, "5xx": value["5xx"] as number, other: value.other as number };
}

function parseEdge(row: unknown): TrafficMapEdge | null {
  if (!isRecord(row)) return null;
  const { service, caller, class: trafficClass, count, error_rate: errorRate, max_ms: maxMilliseconds, filling_count: fillingCount } = row;
  if (!isMatching(service, TRAFFIC_NAME_PATTERN) || !isMatching(caller, TRAFFIC_NAME_PATTERN)) return null;
  if (typeof trafficClass !== "string" || !(TRAFFIC_CLASS_NAMES as readonly string[]).includes(trafficClass)) return null;
  if (!isNonNegativeInteger(count) || !isNonNegativeInteger(fillingCount)) return null;
  if (errorRate !== null && !(typeof errorRate === "number" && errorRate >= 0 && errorRate <= 1)) return null;
  if (maxMilliseconds !== null && !isNonNegativeInteger(maxMilliseconds)) return null;
  const status = parseStatus(row.status);
  const p50 = parseQuantile(row.p50);
  const p95 = parseQuantile(row.p95);
  if (status === null || p50 === undefined || p95 === undefined) return null;
  return {
    service, caller, trafficClass: trafficClass as TrafficClassName, count, status, errorRate: errorRate as number | null, p50, p95,
    maxMilliseconds: maxMilliseconds as number | null, fillingCount,
  };
}

function parseServer(row: unknown): TrafficMapServer | null {
  if (!isRecord(row)) return null;
  const {
    server, read_progress_at: readProgressAt, receive_delayed: receiveDelayed, sequence_gaps: sequenceGaps, last_received_at: lastReceivedAt,
    missing, requests_dropped: requestsDropped, requests_rejected: requestsRejected, first_seq_seen: firstSeqSeen,
  } = row;
  if (!isMatching(server, TRAFFIC_SERVER_NAME_PATTERN) || typeof receiveDelayed !== "boolean") return null;
  if ((readProgressAt !== null && !isIsoText(readProgressAt)) || (lastReceivedAt !== null && !isIsoText(lastReceivedAt))) return null;
  if (!isNonNegativeInteger(sequenceGaps) || !isNonNegativeInteger(requestsDropped) || !isNonNegativeInteger(requestsRejected)) return null;
  if (firstSeqSeen !== null && !isNonNegativeInteger(firstSeqSeen)) return null;
  if (!Array.isArray(missing) || !missing.every((item) => isMatching(item, TRAFFIC_MISSING_PATTERN))) return null;
  return {
    server, readProgressAt: readProgressAt as string | null, receiveDelayed, sequenceGaps, lastReceivedAt: lastReceivedAt as string | null,
    missing: [...missing] as string[], requestsDropped, requestsRejected, firstSeqSeen: firstSeqSeen as number | null,
  };
}

/** 한 줄이라도 꼴이 틀리면 null(전체 unparseable). */
function parseAll<Item>(rows: unknown[], parse: (row: unknown) => Item | null): Item[] | null {
  const items: Item[] = [];
  for (const row of rows) {
    const item = parse(row);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

export function createTrafficMapClient(options: TrafficMapClientOptions): TrafficMapClient {
  return {
    async trafficMap(from, to) {
      const url = upstreamUrl(options.baseUrl, "/traffic/map", [["from", from], ["to", to]]);
      const response = await getUpstream(url, { fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers: { "X-Observe-Secret": options.secret } });
      if (!response.ok) return response;
      if (response.status < 200 || response.status >= 300) return failureForHttpStatus(response.status);
      const data = envelopeData(response);
      if (data === undefined || !isIsoText(data.from) || !isIsoText(data.to) || !Array.isArray(data.servers) || !Array.isArray(data.edges)) {
        return upstreamFailure("unparseable");
      }
      const servers = parseAll(data.servers, parseServer);
      const edges = parseAll(data.edges, parseEdge);
      if (servers === null || edges === null) return upstreamFailure("unparseable");
      return { ok: true, value: { from: data.from, to: data.to, servers, edges } };
    },
  };
}
