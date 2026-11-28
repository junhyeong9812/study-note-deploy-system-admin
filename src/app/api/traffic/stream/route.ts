/** GET /api/traffic/stream?range= — 통신 지도의 갱신(SSE). 세션 검증 · 관측 서버 조회(공유 허브)는 진입 함수가 한다. */
import { trafficStreamResponse } from "@/features/traffic-map/server/traffic-map";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return trafficStreamResponse(request);
}
