/** GET /api/claude-usage — Claude 사용량 화면의 데이터(헬스 · 사용량 · 상한). 세션 검증 · 실행 자리 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { claudeUsageScreenResponse } from "@/features/claude-usage/server/claude-usage-screen";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return claudeUsageScreenResponse(request);
}
