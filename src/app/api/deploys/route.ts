/** GET /api/deploys — 배포 이력(master GET /deploys). 세션 검증 · 입력 검증 · 다른 서버 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { deployHistoryResponse } from "@/features/deploys/server/deploy-history";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return deployHistoryResponse(request);
}
