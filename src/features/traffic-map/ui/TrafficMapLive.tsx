"use client";
/** 통신 지도의 살아 있는 조각 — 이 어드민에서 지도만 브라우저 스크립트를 쓴다(명세 2절). 뼈대(T8 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * 첫 그림은 서버가 준 initial 로, 그 뒤는 EventSource(`/api/traffic/stream?range=`)의 사건으로 TrafficMapBody 를 다시 그린다. */
import type { TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";

export interface TrafficMapLiveProps {
  range: TrafficMapRange;
  initial: TrafficMapEvent;
}

export function TrafficMapLive(props: TrafficMapLiveProps): React.JSX.Element {
  void props;
  throw new Error("T8: 구현 전");
}
