"use client";
/** 통신 지도의 살아 있는 조각 — 이 어드민에서 지도만 브라우저 스크립트를 쓴다(명세 2절).
 * 첫 그림은 서버가 준 initial(통신)과 initialDependencies(의존의 마지막 확인)로, 그 뒤는 EventSource(같은 출처의 `/api/traffic/stream?range=`)의
 * 사건(`map` · `dependencies`)으로 TrafficMapBody 를 다시 그린다. 의존의 낡음(90초)을 가르려고 지금의 시각을 15초마다 새로 읽는다.
 * 화면을 떠나거나 기간이 바뀌면 연결을 닫고 다시 여는 타이머를 거둔다. 서버 모듈 · 클라이언트 · 설정 · fetch 를 가져오지 않는다(소스 검사). */
import { useEffect, useReducer, useState } from "react";
import { unrefScheduler } from "@/features/auth/lib/replay-scheduler";
import type { TrafficDependencyEvent } from "@/features/traffic-map/lib/traffic-dependency-hub";
import { initialTrafficDependencyStreamState, reduceTrafficDependencyStream } from "@/features/traffic-map/lib/traffic-dependency-stream";
import type { TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import {
  TRAFFIC_STREAM_PATH, connectTrafficMapStream, initialTrafficMapStreamState, reduceTrafficMapStream,
} from "@/features/traffic-map/lib/traffic-map-stream-state";
import { TrafficMapBody } from "@/features/traffic-map/ui/TrafficMapBody";

/** 의존의 낡음을 다시 가르는 간격. */
const STALE_CHECK_MILLISECONDS = 15_000;

export interface TrafficMapLiveProps {
  range: TrafficMapRange;
  initial: TrafficMapEvent;
  initialDependencies: TrafficDependencyEvent | null;
}

export function TrafficMapLive({ range, initial, initialDependencies }: TrafficMapLiveProps): React.JSX.Element {
  const [state, dispatch] = useReducer(reduceTrafficMapStream, initial, initialTrafficMapStreamState);
  const [dependencies, dispatchDependencies] = useReducer(reduceTrafficDependencyStream, initialDependencies, initialTrafficDependencyStreamState);
  // 첫 그림(서버)은 시각으로 낡음을 가르지 않는다 — 브라우저에서 붙은 뒤부터 지금의 시각을 쓴다(서버와 브라우저의 그림이 어긋나지 않게)
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => {
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), STALE_CHECK_MILLISECONDS);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => connectTrafficMapStream({
    url: `${TRAFFIC_STREAM_PATH}?${new URLSearchParams({ range }).toString()}`,
    createEventSource: (url) => new EventSource(url),
    dispatch,
    dispatchDependencies,
    scheduler: unrefScheduler,
  }), [range]);
  return <TrafficMapBody range={range} state={state} dependencies={dependencies} now={now} />;
}
