/** GET /api/trace?request_id=<요청 ID> — 요청 추적(관측 서버 GET /logs). 세션 검증 · 입력 검증 · 다른 서버 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { requestTraceResponse } from "@/features/request-trace/server/request-trace";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return requestTraceResponse(request);
}
