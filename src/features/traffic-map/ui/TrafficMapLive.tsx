"use client";
/** 통신 지도의 살아 있는 조각 — 이 어드민에서 지도만 브라우저 스크립트를 쓴다(명세 2절).
 * 첫 그림은 서버가 준 initial 로, 그 뒤는 EventSource(같은 출처의 `/api/traffic/stream?range=`)의 사건으로 TrafficMapBody 를 다시 그린다.
 * 화면을 떠나거나 기간이 바뀌면 연결을 닫고 다시 여는 타이머를 거둔다. 서버 모듈 · 클라이언트 · 설정 · fetch 를 가져오지 않는다(소스 검사). */
import { useEffect, useReducer } from "react";
import { unrefScheduler } from "@/features/auth/lib/replay-scheduler";
import type { TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import {
  TRAFFIC_STREAM_PATH, connectTrafficMapStream, initialTrafficMapStreamState, reduceTrafficMapStream,
} from "@/features/traffic-map/lib/traffic-map-stream-state";
import { TrafficMapBody } from "@/features/traffic-map/ui/TrafficMapBody";

export interface TrafficMapLiveProps {
  range: TrafficMapRange;
  initial: TrafficMapEvent;
}

export function TrafficMapLive({ range, initial }: TrafficMapLiveProps): React.JSX.Element {
  const [state, dispatch] = useReducer(reduceTrafficMapStream, initial, initialTrafficMapStreamState);
  useEffect(() => connectTrafficMapStream({
    url: `${TRAFFIC_STREAM_PATH}?${new URLSearchParams({ range }).toString()}`,
    createEventSource: (url) => new EventSource(url),
    dispatch,
    scheduler: unrefScheduler,
  }), [range]);
  return <TrafficMapBody range={range} state={state} />;
}
