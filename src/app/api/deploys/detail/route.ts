/** GET /api/deploys/detail?service=&selected=&commit= — 배포 상세(master GET /deploys + GitHub). 세션 검증 · 입력 검증 · 다른 서버 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { deployDetailResponse } from "@/features/deploy-detail/server/deploy-detail";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return deployDetailResponse(request);
}
