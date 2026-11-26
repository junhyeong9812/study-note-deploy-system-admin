/** 통신 지도의 서버 쪽 진입 — 뼈대(T8 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * 세션 검증을 직접 부른 뒤에만 OBSERVE_URL · OBSERVE_SECRET 을 읽고 공유 조회(허브)를 쓴다. 브라우저는 관측 서버를 직접 부르지 않는다. */
import "server-only";
import type { Scheduler } from "@/features/auth/lib/replay-scheduler";
import type { TrafficMapEvent, TrafficMapHub } from "@/features/traffic-map/lib/traffic-map-hub";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

/** 연결마다 주석 줄(`: keep-alive`)을 보내는 간격 — 어드민 nginx 의 읽기 시간 제한 30초보다 짧게(규약 3.3). */
export const TRAFFIC_STREAM_HEARTBEAT_MILLISECONDS = 15_000;

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

/** 프로세스에 하나인 허브(관측 서버 조회 · unrefScheduler · Date.now). */
export function defaultTrafficMapHub(): TrafficMapHub {
  throw new Error("T8: 구현 전");
}

/** 화면용 — 세션이 없으면 /login(관측 서버를 부르지 않는다). range 가 틀리면 기본값. */
export async function loadTrafficMapScreen(searchParams: SearchParamsInput, hub?: TrafficMapHub): Promise<TrafficMapScreen> {
  void searchParams; void hub;
  throw new Error("T8: 구현 전");
}

/** GET /api/traffic/stream?range= — 세션이 없으면 401(JSON). 그 밖 200 text/event-stream. */
export async function trafficStreamResponse(request: Request, options: TrafficStreamOptions = {}): Promise<Response> {
  void request; void options;
  throw new Error("T8: 구현 전");
}
