/** GET /api/logs/trace?selected=<로그 id> — 연관 로그(관측 서버 GET /logs + master GET /deploys + 알림 서버 GET /incidents). 세션 검증 · 입력 검증 · 다른 서버 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { logTraceResponse } from "@/features/log-trace/server/log-trace";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return logTraceResponse(request);
}
