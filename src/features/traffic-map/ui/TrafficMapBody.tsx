/** 통신 지도의 본문(상태 → 그림 · 표 · 알림) — 뼈대(T8 테스트가 컴파일되게 하는 꼴만, 구현 전). 서버에서도 브라우저에서도 그린다(훅 없음). */
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import type { TrafficMapStreamState } from "@/features/traffic-map/lib/traffic-map-stream-state";

export interface TrafficMapBodyProps {
  range: TrafficMapRange;
  state: TrafficMapStreamState;
}

export function TrafficMapBody(props: TrafficMapBodyProps): React.JSX.Element {
  void props;
  throw new Error("T8: 구현 전");
}
