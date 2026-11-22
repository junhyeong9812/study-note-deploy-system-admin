/** GET /api/logs — 로그 조회(관측 서버 GET /logs). 세션 검증 · 입력 검증 · 다른 서버 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { logSearchResponse } from "@/features/logs/server/log-search";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return logSearchResponse(request);
}
