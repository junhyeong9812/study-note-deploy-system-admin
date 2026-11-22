/** GET /api/login-attempts — 로그인 시도 기록(관측 서버 GET /auth/attempts · /auth/lock). 세션 검증 · 입력 검증 · 다른 서버 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { loginAttemptsResponse } from "@/features/login-attempts/server/login-attempts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return loginAttemptsResponse(request);
}
