/** GET /api/status — 상태 한눈에(다섯 헬스 · 감시 결과를 병렬로). 세션 검증 · 입력 검증 · 다른 서버 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { statusOverviewResponse } from "@/features/status/server/status-overview";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return statusOverviewResponse(request);
}
