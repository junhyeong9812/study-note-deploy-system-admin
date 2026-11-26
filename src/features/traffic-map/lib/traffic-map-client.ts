/** 관측 서버 지도 조회 클라이언트 — 뼈대(T8 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * `GET <OBSERVE_URL>/traffic/map?from=&to=` → `{success,data:{from, to, servers[], edges[]}}`(observe traffic/TrafficController.kt:90-113 · 185-218).
 * 헤더 `X-Observe-Secret`, 5초 기한, GET 만, redirect:"manual", no-store(getUpstream). 꼴이 틀리면 unparseable — 모르는 칸은 버린다. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

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

export function createTrafficMapClient(options: TrafficMapClientOptions): TrafficMapClient {
  void options;
  throw new Error("T8: 구현 전");
}
