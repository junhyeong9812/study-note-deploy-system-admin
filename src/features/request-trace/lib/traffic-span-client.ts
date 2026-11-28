/** 관측 서버 통신 조회 클라이언트(요청 추적용, 순수 — 설정을 읽지 않는다).
 * - `requestSpans`: `GET <OBSERVE_URL>/traffic/requests?request_id=…` → `{success,data:{request_id, spans[], truncated}}`
 *   (observe traffic/TrafficController.kt:158-179 — 구간 `{server, service, caller, method, path, path_truncated, status, end_at, duration_ms,
 *   upstream_ms, upstream_status, slot, bytes_sent}`, end_ms · 서비스순, 500 개까지).
 * - `serverReceipts`: `GET <OBSERVE_URL>/traffic/map?from=&to=` 의 `servers[]`(TrafficController.kt:200-218) — 수신 상태만 쓴다(edges 는 읽지 않는다).
 * 헤더 `X-Observe-Secret`, 5초 기한, GET 만, redirect:"manual", no-store(getUpstream). 오류 상태는 failureForHttpStatus(원문 없음).
 * 꼴이 틀리면 전체 unparseable(0 · 빈 목록으로 메우지 않는다). 이름의 꼴은 관측 서버가 받는 꼴(TrafficEntry.kt:167-174)과 같다 —
 * 서버 SERVER_NAME · 서비스와 부른 쪽 NAME · 요청 방법 METHOD · 읽지 못한 범위 MISSING. 받은 응답의 request_id 가 물은 것과 다르면 unparseable.
 * 걸린 시간 · upstream 은 7일 이하(그보다 크면 구간의 시작 시각을 만들 수 없다 — 날짜의 범위를 벗어나 화면이 예외로 깨지지 않게). 보낸 바이트는 상한 없음. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { parseIsoUtc } from "@/shared/lib/query-input";
import { envelopeData, getUpstream, isNonNegativeInteger, isRecord, upstreamUrl, type UpstreamResponse } from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, upstreamFailure, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

/** 구간 하나 — 관측 서버의 칸 그대로(이름만 camelCase). 시각은 관측 서버의 글자(Java Instant), 시간은 정수 ms. */
export interface TrafficSpan {
  server: string;
  service: string;
  caller: string;
  method: string;
  path: string;
  pathTruncated: boolean;
  status: number;
  endAt: string;
  durationMilliseconds: number;
  upstreamMilliseconds: number | null;
  upstreamStatus: string | null;
  slot: string | null;
  bytesSent: number;
}

export interface TrafficSpanPage {
  spans: TrafficSpan[];
  /** 관측 서버가 500 개에서 잘랐다 */
  truncated: boolean;
}

/** 서버 하나의 수신 상태 — `/traffic/map` 의 servers[] 에서 쓰는 칸만. */
export interface TrafficServerReceipt {
  server: string;
  /** 읽기 진도(ISO) — 없으면 null */
  readProgressAt: string | null;
  receiveDelayed: boolean;
  sequenceGaps: number;
  /** 기간 안에 받은 항목의 `<컨테이너>:<이유>` */
  missing: string[];
  requestsDropped: number;
  requestsRejected: number;
}

export interface TrafficSpanClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface TrafficSpanClient {
  requestSpans(requestId: string): Promise<UpstreamResult<TrafficSpanPage>>;
  serverReceipts(from: string, to: string): Promise<UpstreamResult<TrafficServerReceipt[]>>;
}

const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const METHOD_PATTERN = /^[A-Z_-]{0,32}$/;
const MISSING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}:[a-z_]{1,32}$/;
/** 걸린 시간 · upstream 의 상한(포함) — 요청별 줄의 보관 기간 7일. */
const MAXIMUM_SPAN_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

function isSpanMilliseconds(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= MAXIMUM_SPAN_MILLISECONDS;
}

function isIsoText(value: unknown): value is string {
  return typeof value === "string" && parseIsoUtc(value) !== null;
}

function isNameMatching(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function parseSpan(row: unknown): TrafficSpan | null {
  if (!isRecord(row)) return null;
  const {
    server, service, caller, method, path, path_truncated: pathTruncated, status, end_at: endAt, duration_ms: durationMilliseconds,
    upstream_ms: upstreamMilliseconds, upstream_status: upstreamStatus, slot, bytes_sent: bytesSent,
  } = row;
  if (!isNameMatching(server, SERVER_NAME_PATTERN) || !isNameMatching(service, SERVICE_NAME_PATTERN) || !isNameMatching(caller, SERVICE_NAME_PATTERN)) return null;
  if (!isNameMatching(method, METHOD_PATTERN) || typeof path !== "string" || typeof pathTruncated !== "boolean") return null;
  if (!isNonNegativeInteger(status) || !isIsoText(endAt) || !isSpanMilliseconds(durationMilliseconds) || !isNonNegativeInteger(bytesSent)) return null;
  if (upstreamMilliseconds !== null && !isSpanMilliseconds(upstreamMilliseconds)) return null;
  if ((upstreamStatus !== null && typeof upstreamStatus !== "string") || (slot !== null && typeof slot !== "string")) return null;
  return {
    server, service, caller, method, path, pathTruncated, status, endAt, durationMilliseconds,
    upstreamMilliseconds: upstreamMilliseconds as number | null, upstreamStatus: upstreamStatus as string | null, slot: slot as string | null, bytesSent,
  };
}

function parseServerReceipt(row: unknown): TrafficServerReceipt | null {
  if (!isRecord(row)) return null;
  const {
    server, read_progress_at: readProgressAt, receive_delayed: receiveDelayed, sequence_gaps: sequenceGaps, missing,
    requests_dropped: requestsDropped, requests_rejected: requestsRejected,
  } = row;
  if (!isNameMatching(server, SERVER_NAME_PATTERN) || (readProgressAt !== null && !isIsoText(readProgressAt)) || typeof receiveDelayed !== "boolean") return null;
  if (!isNonNegativeInteger(sequenceGaps) || !isNonNegativeInteger(requestsDropped) || !isNonNegativeInteger(requestsRejected)) return null;
  if (!Array.isArray(missing) || !missing.every((item) => isNameMatching(item, MISSING_PATTERN))) return null;
  return { server, readProgressAt: readProgressAt as string | null, receiveDelayed, sequenceGaps, missing: [...missing] as string[], requestsDropped, requestsRejected };
}

/** 응답 → 봉투의 data(2xx 가 아니면 그 상태의 실패, 봉투가 틀리면 unparseable). */
function dataOf(response: UpstreamResponse | UpstreamFailure): UpstreamResult<Record<string, unknown>> {
  if (!response.ok) return response;
  if (response.status < 200 || response.status >= 300) return failureForHttpStatus(response.status);
  const data = envelopeData(response);
  return data === undefined ? upstreamFailure("unparseable") : { ok: true, value: data };
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

export function createTrafficSpanClient(options: TrafficSpanClientOptions): TrafficSpanClient {
  const get = (path: string, parameters: [string, string][]) => getUpstream(upstreamUrl(options.baseUrl, path, parameters), {
    fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers: { "X-Observe-Secret": options.secret },
  });
  return {
    async requestSpans(requestId) {
      const data = dataOf(await get("/traffic/requests", [["request_id", requestId]]));
      if (!data.ok) return data;
      const { request_id: answeredRequestId, spans: rows, truncated } = data.value;
      if (answeredRequestId !== requestId || !Array.isArray(rows) || typeof truncated !== "boolean") return upstreamFailure("unparseable");
      const spans = parseAll(rows, parseSpan);
      return spans === null ? upstreamFailure("unparseable") : { ok: true, value: { spans, truncated } };
    },
    async serverReceipts(from, to) {
      const data = dataOf(await get("/traffic/map", [["from", from], ["to", to]]));
      if (!data.ok) return data;
      const rows = data.value.servers;
      if (!Array.isArray(rows)) return upstreamFailure("unparseable");
      const receipts = parseAll(rows, parseServerReceipt);
      return receipts === null ? upstreamFailure("unparseable") : { ok: true, value: receipts };
    },
  };
}
