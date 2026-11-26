/** 관측 서버 통신 조회 클라이언트(요청 추적용) — 뼈대(T7 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * - `requestSpans`: `GET <OBSERVE_URL>/traffic/requests?request_id=…` → `{success,data:{request_id, spans[], truncated}}`
 *   (observe traffic/TrafficController.kt:158-179 — 구간 `{server, service, caller, method, path, path_truncated, status, end_at, duration_ms,
 *   upstream_ms, upstream_status, slot, bytes_sent}`, end_ms · 서비스순, 500 개까지).
 * - `serverReceipts`: `GET <OBSERVE_URL>/traffic/map?from=&to=` 의 `servers[]`(TrafficController.kt:200-218) — 수신 상태만 쓴다(edges 는 읽지 않는다).
 * 헤더 `X-Observe-Secret`, 5초 기한, GET 만, redirect:"manual", no-store(getUpstream). 꼴이 틀리면 unparseable(0 · 빈 목록으로 메우지 않는다). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

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

export function createTrafficSpanClient(options: TrafficSpanClientOptions): TrafficSpanClient {
  void options;
  throw new Error("T7: 구현 전");
}
