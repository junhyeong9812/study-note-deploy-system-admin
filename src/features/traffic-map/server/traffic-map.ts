/** 통신 지도의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 공유 조회(허브)를 쓴다. 허브의 조회가 그때마다 OBSERVE_URL · OBSERVE_SECRET 을 읽고 관측 서버를 부른다.
 * 브라우저는 관측 서버를 직접 부르지 않는다 — 같은 출처의 중계(SSE `GET /api/traffic/stream?range=`)만 연다.
 * 흐름: `retry: 5000` → 허브의 사건마다 `event: map` · `id: <sequence>` · `data: <사건 JSON 한 줄>` · 15초마다 주석 줄 ·
 * 세션이 끝나는 때 `event: session` 을 보내고 닫는다. 클라이언트가 끊거나(abort) 읽는 쪽이 취소하면 구독 · 주석 줄 · 세션 타이머를 모두 거둔다.
 * 실패는 조회마다 앱 로그 1줄(upstreamFailureLogLine("traffic", "map", 결과) — 연결 수만큼이 아니다). */
import "server-only";
import { SESSION_LIFETIME_MILLISECONDS } from "@/features/auth/lib/session";
import { unrefScheduler, type Scheduler, type ScheduledTask } from "@/features/auth/lib/replay-scheduler";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createTrafficMapClient } from "@/features/traffic-map/lib/traffic-map-client";
import { createTrafficMapHub, type TrafficMapEvent, type TrafficMapHub } from "@/features/traffic-map/lib/traffic-map-hub";
import { parseTrafficMapRange, trafficMapWindow, type TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import { buildTrafficMapView, type TrafficMapView } from "@/features/traffic-map/lib/traffic-map-view";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
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
}

export interface TrafficStreamOptions {
  hub?: TrafficMapHub;
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

const GLOBAL_KEY = "__studyNoteTrafficMapHub";
type GlobalHolder = { [GLOBAL_KEY]?: TrafficMapHub };

/** 프로세스에 하나인 허브(관측 서버 조회 · unrefScheduler · Date.now) — globalThis 에 둔다(개발 모드의 모듈 재로딩 · 라우트별 묶음에서도 같은 인스턴스). */
export function defaultTrafficMapHub(): TrafficMapHub {
  const holder = globalThis as unknown as GlobalHolder;
  holder[GLOBAL_KEY] ??= createTrafficMapHub({ load: loadTrafficMap, scheduler: unrefScheduler, now: Date.now });
  return holder[GLOBAL_KEY];
}

/** 화면용 — 세션이 없으면 /login(관측 서버를 부르지 않는다). range 가 틀리면 기본값. */
export async function loadTrafficMapScreen(searchParams: SearchParamsInput, hub: TrafficMapHub = defaultTrafficMapHub()): Promise<TrafficMapScreen> {
  await requireSession();
  const range = parseTrafficMapRange(searchParams);
  return { range, initial: await hub.snapshot(range) };
}

/** GET /api/traffic/stream?range= — 세션이 없으면 401(JSON). 그 밖 200 text/event-stream. */
export async function trafficStreamResponse(request: Request, options: TrafficStreamOptions = {}): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  const range = parseTrafficMapRange(searchParamsInputFromUrl(new URL(request.url)));
  const hub = options.hub ?? defaultTrafficMapHub();
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
      const write = (block: string) => { if (!stopped) controller.enqueue(encoder.encode(`${block}\n\n`)); };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        unsubscribe?.();
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
      heartbeat = scheduler(beat, TRAFFIC_STREAM_HEARTBEAT_MILLISECONDS);
      sessionEnd = scheduler(() => {
        write("event: session\ndata: {\"reason\":\"expired\"}");
        closeStream();
      }, Math.max(0, session.issuedAt + SESSION_LIFETIME_MILLISECONDS - now()));
      if (request.signal.aborted) closeStream();
      else request.signal.addEventListener("abort", closeStream);
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
