/** GET /api/deploys/versions — 서비스별 버전 목록(master GET /deploys · git 조회). 세션 검증 · 입력 검증 · 다른 서버 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { deployVersionsResponse } from "@/features/deploy-versions/server/deploy-versions";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return deployVersionsResponse(request);
}
