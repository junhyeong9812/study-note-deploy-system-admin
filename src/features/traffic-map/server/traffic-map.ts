/** 통신 지도의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 공유 조회(허브)를 쓴다. 허브의 조회가 그때마다 OBSERVE_URL · OBSERVE_SECRET 을 읽고 관측 서버를 부른다.
 * 브라우저는 관측 서버를 직접 부르지 않는다 — 같은 출처의 중계(SSE `GET /api/traffic/stream?range=`)만 연다.
 * 흐름: `retry: 5000` → 허브의 사건마다 `event: map` · `id: <sequence>` · `data: <사건 JSON 한 줄>` · 15초마다 주석 줄 ·
 * 세션이 끝나는 때 `event: session` 을 보내고 닫는다. 클라이언트가 끊거나(abort) 읽는 쪽이 취소하면 구독 · 주석 줄 · 세션 타이머를 모두 거둔다.
 * 실패는 조회마다 앱 로그 1줄(upstreamFailureLogLine("traffic", "map", 결과) — 연결 수만큼이 아니다).
 * 의존의 선(⑬ T9d): 같은 흐름에 의존 허브의 사건마다 `event: dependencies` · `data: <사건 JSON 한 줄>`(id 줄 없음) — 통신 지도의 허브와 따로 돈다.
 * 멈출 때(SIGTERM · SIGINT — instrumentation 의 register() 가 프로세스에 한 번 물린다): 허브를 멈추고 열린 흐름을 모두 닫는다(사건 · 주석 줄 없이 —
 * 브라우저는 끊김을 보고 5초 뒤 새 자리에 다시 붙는다). 열린 흐름이 프로세스를 붙잡아 멈춤이 늦어지지 않게. 그 뒤의 새 흐름은 503 `shutting_down`. */
import "server-only";
import { SESSION_LIFETIME_MILLISECONDS } from "@/features/auth/lib/session";
import { unrefScheduler, type Scheduler, type ScheduledTask } from "@/features/auth/lib/replay-scheduler";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createTrafficMapClient } from "@/features/traffic-map/lib/traffic-map-client";
import { createDependencyClient } from "@/features/traffic-map/lib/dependency-client";
import type { DependencyLine } from "@/features/traffic-map/lib/dependency-lines";
import { createTrafficDependencyHub, type TrafficDependencyEvent, type TrafficDependencyHub } from "@/features/traffic-map/lib/traffic-dependency-hub";
import { createTrafficMapHub, type TrafficMapEvent, type TrafficMapHub } from "@/features/traffic-map/lib/traffic-map-hub";
import { createTrafficStreamRegistry, type TrafficStreamRegistry } from "@/features/traffic-map/lib/traffic-stream-registry";
import { parseTrafficMapRange, trafficMapWindow, type TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import { buildTrafficMapView, type TrafficMapView } from "@/features/traffic-map/lib/traffic-map-view";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { errorResponse } from "@/shared/lib/responses";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import { upstreamFailure, type SearchParamsInput, type UpstreamResult } from "@/shared/lib/upstream-result";

/** 연결마다 주석 줄(`: keep-alive`)을 보내는 간격 — 어드민 nginx 의 읽기 시간 제한 30초보다 짧게(규약 3.3). */
export const TRAFFIC_STREAM_HEARTBEAT_MILLISECONDS = 15_000;
/** EventSource 가 끊긴 뒤 다시 붙기까지(브라우저가 쓰는 값 — 흐름의 첫 줄). */
const STREAM_RETRY_MILLISECONDS = 5_000;

export interface TrafficMapScreen {
  range: TrafficMapRange;
  /** 첫 그림 — 허브의 snapshot */
  initial: TrafficMapEvent;
  /** 의존의 선의 첫 그림 — 의존 허브의 snapshot(마지막 확인 · 없으면 null — 기다리지 않는다). */
  initialDependencies: TrafficDependencyEvent | null;
}

export interface TrafficStreamOptions {
  hub?: TrafficMapHub;
  /** 의존의 선의 허브 — 기본 defaultTrafficDependencyHub()(⑬ T9d). 흐름은 그 사건마다 `event: dependencies` · `data: <사건 JSON 한 줄>`(id 줄 없음). */
  dependencyHub?: TrafficDependencyHub;
  /** 열린 흐름의 목록 — 기본 defaultTrafficStreamRegistry()(T8 리뷰 1) */
  streams?: TrafficStreamRegistry;
  /** 연결마다의 타이머(주석 줄 · 세션 끝) — 기본 unrefScheduler */
  scheduler?: Scheduler;
  now?: () => number;
}

/** 허브의 조회 한 번 — 설정을 그때 읽는다(비었거나 주소가 http(s) 가 아니면 not_configured · 부르지 않는다). 실패는 앱 로그 1줄. */
async function loadTrafficMap(range: TrafficMapRange): Promise<UpstreamResult<TrafficMapView>> {
  const config = readServerConfig();
  let result: UpstreamResult<TrafficMapView>;
  if (!isHttpBaseUrl(config.observeUrl) || config.observeSecret.length === 0) {
    result = upstreamFailure("not_configured");
  } else {
    const client = createTrafficMapClient({ baseUrl: config.observeUrl, secret: config.observeSecret, fetch: (input, init) => fetch(input, init) });
    const window = trafficMapWindow(range, Date.now());
    const snapshot = await client.trafficMap(window.from, window.to);
    result = snapshot.ok ? { ok: true, value: buildTrafficMapView(snapshot.value) } : snapshot;
  }
  const failureLogLine = upstreamFailureLogLine("traffic", "map", result);
  if (failureLogLine !== null) void log("screen-traffic", failureLogLine, "warning");
  return result;
}

// 프로세스에 하나씩 — globalThis 에 둔다(개발 모드의 모듈 재로딩 · 라우트별 묶음 · instrumentation 의 묶음에서도 같은 인스턴스)
const GLOBAL_KEY = "__studyNoteTrafficMapHub";
const DEPENDENCY_HUB_KEY = "__studyNoteTrafficDependencyHub";
const STREAMS_KEY = "__studyNoteTrafficStreams";
const SHUTDOWN_REGISTERED_KEY = "__studyNoteTrafficMapShutdownRegistered";
type GlobalHolder = {
  [GLOBAL_KEY]?: TrafficMapHub; [DEPENDENCY_HUB_KEY]?: TrafficDependencyHub; [STREAMS_KEY]?: TrafficStreamRegistry; [SHUTDOWN_REGISTERED_KEY]?: boolean;
};

/** 프로세스에 하나인 허브(관측 서버 조회 · unrefScheduler · Date.now) — globalThis 에 둔다(개발 모드의 모듈 재로딩 · 라우트별 묶음에서도 같은 인스턴스). */
export function defaultTrafficMapHub(): TrafficMapHub {
  const holder = globalThis as unknown as GlobalHolder;
  holder[GLOBAL_KEY] ??= createTrafficMapHub({ load: loadTrafficMap, scheduler: unrefScheduler, now: Date.now });
  return holder[GLOBAL_KEY];
}

/** 프로세스에 하나인 의존의 선의 허브(⑬ T9d) — 조회는 그때마다 BACKEND_URL · LLM_URL · OBSERVE_URL 을 읽어 세 경로를 부른다(loadTrafficDependencies) ·
 * 통신 지도의 허브와 따로(한쪽이 붙잡혀도 다른 쪽은 제때). globalThis 에 둔다. */
export function defaultTrafficDependencyHub(): TrafficDependencyHub {
  const holder = globalThis as unknown as GlobalHolder;
  holder[DEPENDENCY_HUB_KEY] ??= createTrafficDependencyHub({ load: loadTrafficDependencies, scheduler: unrefScheduler, now: Date.now });
  return holder[DEPENDENCY_HUB_KEY];
}

/** 의존 허브의 조회 한 번 — 설정을 그때 읽는다(BACKEND_URL · LLM_URL · OBSERVE_URL — 비었거나 http(s) 가 아니면 그 서비스는 not_configured · 부르지 않는다).
 * 모름인 서비스마다 앱 로그 1줄 `screen:traffic cell=dependencies:<서비스> upstream=<까닭>`(log("screen-traffic", …, "warning")) — 끊김(DOWN) · 알리지 않음(not_reported)은
 * 로그가 아니다. 줄에는 서비스 이름과 까닭의 낱말만(주소 · 비밀값 · 서비스가 준 detail 없음). */
export async function loadTrafficDependencies(): Promise<DependencyLine[]> {
  const config = readServerConfig();
  const client = createDependencyClient({
    backendUrl: config.backendUrl, llmUrl: config.llmUrl, observeUrl: config.observeUrl, fetch: (input, init) => fetch(input, init),
  });
  const lines = await client.readDependencies();
  const failedServices = new Map<string, string>();
  for (const line of lines) {
    if (line.state === "unknown" && line.reason !== "not_reported" && !failedServices.has(line.service)) failedServices.set(line.service, line.reason ?? "unknown");
  }
  for (const [service, reason] of failedServices) void log("screen-traffic", `screen:traffic cell=dependencies:${service} upstream=${reason}`, "warning");
  return lines;
}

/** 멈춤 신호를 물리는 이음매 — 기본은 process.once(signal, handler). 테스트는 가짜를 준다. */
export type ShutdownSignal = "SIGTERM" | "SIGINT";
export type ShutdownSignalRegistrar = (signal: ShutdownSignal, handler: () => void) => void;

/** 프로세스에 하나인 열린 흐름의 목록. */
export function defaultTrafficStreamRegistry(): TrafficStreamRegistry {
  const holder = globalThis as unknown as GlobalHolder;
  holder[STREAMS_KEY] ??= createTrafficStreamRegistry();
  return holder[STREAMS_KEY];
}

/** 멈춘다 — 두 허브(통신 · 의존)를 멈추고(타이머 · 조회) 열린 흐름을 모두 닫는다(닫기 전에 사건을 보내지 않는다). 그 뒤의 새 흐름은 503. 두 번 불러도 같다. */
export function shutdownTrafficMap(hub: TrafficMapHub = defaultTrafficMapHub(), streams: TrafficStreamRegistry = defaultTrafficStreamRegistry(),
                                   dependencyHub: TrafficDependencyHub = defaultTrafficDependencyHub()): void {
  hub.stop();
  dependencyHub.stop();
  streams.closeAll();
}

/** SIGTERM · SIGINT 에 shutdownTrafficMap 을 하나씩 물린다 — 프로세스에 한 번(두 번째부터는 아무것도 하지 않는다 · 흐름마다 물리지 않는다).
 * 종료 자체는 Next 서버의 신호 처리기가 한다(연결이 다 닫히면 끝난다) — 여기서는 열린 흐름이 그것을 붙잡지 않게 닫기만 한다. */
export function registerTrafficMapShutdown(registrar: ShutdownSignalRegistrar = (signal, handler) => { process.once(signal, handler); }): void {
  const holder = globalThis as unknown as GlobalHolder;
  if (holder[SHUTDOWN_REGISTERED_KEY]) return;
  holder[SHUTDOWN_REGISTERED_KEY] = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) registrar(signal, () => shutdownTrafficMap());
}

/** 화면용 — 세션이 없으면 /login(관측 서버를 부르지 않는다). range 가 틀리면 기본값. */
/* 의존의 선의 첫 그림은 의존 허브의 snapshot()(마지막 확인 — 부르지 않고 기다리지 않는다). */
export async function loadTrafficMapScreen(searchParams: SearchParamsInput, hub: TrafficMapHub = defaultTrafficMapHub(),
                                           dependencyHub: TrafficDependencyHub = defaultTrafficDependencyHub()): Promise<TrafficMapScreen> {
  await requireSession();
  const range = parseTrafficMapRange(searchParams);
  return { range, initial: await hub.snapshot(range), initialDependencies: dependencyHub.snapshot() };
}

/** GET /api/traffic/stream?range= — 세션이 없으면 401(JSON). 그 밖 200 text/event-stream. */
export async function trafficStreamResponse(request: Request, options: TrafficStreamOptions = {}): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  const streams = options.streams ?? defaultTrafficStreamRegistry();
  if (streams.closed) return errorResponse(503, "shutting_down", {}, { "Retry-After": "5" });
  const range = parseTrafficMapRange(searchParamsInputFromUrl(new URL(request.url)));
  const hub = options.hub ?? defaultTrafficMapHub();
  const dependencyHub = options.dependencyHub ?? defaultTrafficDependencyHub();
  const scheduler = options.scheduler ?? unrefScheduler;
  const now = options.now ?? Date.now;
  const encoder = new TextEncoder();
  let stopStream = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let stopped = false;
      let heartbeat: ScheduledTask | null = null;
      let sessionEnd: ScheduledTask | null = null;
      let unsubscribe: (() => void) | null = null;
      let unsubscribeDependencies: (() => void) | null = null;
      let leaveStreams: (() => void) | null = null;
      const write = (block: string) => { if (!stopped) controller.enqueue(encoder.encode(`${block}\n\n`)); };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        unsubscribe?.();
        unsubscribeDependencies?.();
        leaveStreams?.();
        heartbeat?.cancel();
        sessionEnd?.cancel();
        request.signal.removeEventListener("abort", closeStream);
      };
      function closeStream() {
        stop();
        try { controller.close(); } catch { /* 이미 닫혔다(읽는 쪽이 취소) */ }
      }
      const beat = () => {
        write(": keep-alive");
        heartbeat = scheduler(beat, TRAFFIC_STREAM_HEARTBEAT_MILLISECONDS);
      };
      stopStream = stop;
      // retry 줄을 먼저 — subscribe 가 같은 틱에 마지막 지도를 줄 수 있다
      write(`retry: ${STREAM_RETRY_MILLISECONDS}`);
      unsubscribe = hub.subscribe(range, (event) => write(`event: map\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}`));
      // 의존의 사건은 id 줄을 두지 않는다 — Last-Event-ID 는 통신 지도의 sequence 만 가리킨다
      unsubscribeDependencies = dependencyHub.subscribe((event) => write(`event: dependencies\ndata: ${JSON.stringify(event)}`));
      heartbeat = scheduler(beat, TRAFFIC_STREAM_HEARTBEAT_MILLISECONDS);
      sessionEnd = scheduler(() => {
        write("event: session\ndata: {\"reason\":\"expired\"}");
        closeStream();
      }, Math.max(0, session.issuedAt + SESSION_LIFETIME_MILLISECONDS - now()));
      if (request.signal.aborted) closeStream();
      else request.signal.addEventListener("abort", closeStream);
      // 멈출 때 닫히도록 목록에 넣는다(평소에 끊기면 stop 이 뺀다) — 신호 리스너는 흐름마다 더하지 않는다
      if (!stopped) leaveStreams = streams.add(closeStream);
    },
    cancel() {
      stopStream();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}
