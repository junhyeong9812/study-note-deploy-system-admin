/** GET /api/resources — 서버 자원 화면의 데이터. 세션 검증 · 입력 해석 · 관측 서버 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { resourcesScreenResponse } from "@/features/resources/server/resources-screen";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return resourcesScreenResponse(request);
}
