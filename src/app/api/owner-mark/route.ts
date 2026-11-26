/** GET /api/owner-mark — 주인 표시 화면의 데이터(설정 · 이 브라우저의 판정). POST /api/owner-mark — 이 브라우저를 주인으로 표시(쿠키를 심는다).
 * 세션 검증 · 출처 검사 · 설정은 진입 함수가 한다(요청마다 실행, no-store). */
import { ownerMarkSetResponse } from "@/features/owner-mark/server/owner-mark-change";
import { ownerMarkScreenResponse } from "@/features/owner-mark/server/owner-mark-screen";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return ownerMarkScreenResponse(request);
}

export function POST(request: Request) {
  return ownerMarkSetResponse(request);
}
