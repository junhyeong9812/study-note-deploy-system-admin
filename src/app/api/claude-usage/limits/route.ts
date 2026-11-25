/** POST /api/claude-usage/limits — 상한 · 켬/끔 바꾸기(폼). 출처 · 세션 · 입력 · 비밀번호 재확인 · 실행 자리 호출은 진입 함수가 한다. */
import { claudeLimitsChangeResponse } from "@/features/claude-usage/server/claude-limits-change";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return claudeLimitsChangeResponse(request);
}
