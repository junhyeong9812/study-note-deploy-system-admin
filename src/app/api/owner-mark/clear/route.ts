/** POST /api/owner-mark/clear — 주인 표시 지우기(같은 이름 · Domain · Path 에 Max-Age=0). 세션 검증 · 출처 검사 · 설정은 진입 함수가 한다. */
import { ownerMarkClearResponse } from "@/features/owner-mark/server/owner-mark-change";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return ownerMarkClearResponse(request);
}
