/** GET /api/deploys/redeploy — 재배포 확인(지금 버전 → 고른 버전 · 방향 · 사이의 커밋). 읽기만 한다. 세션 검증 · 입력 검증 · 다른 서버 호출은 진입 함수가 한다(요청마다 실행, no-store). */
import { redeployAcceptResponse } from "@/features/deploy-redeploy/server/redeploy-accept";
import { redeployPreviewResponse } from "@/features/deploy-redeploy/server/redeploy-preview";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return redeployPreviewResponse(request);
}

/** POST /api/deploys/redeploy — 재배포 접수(6-4). 뼈대: 구현 워커가 채운다. */
export function POST(request: Request) {
  return redeployAcceptResponse(request);
}
