/** GET /api/incidents — 문제 화면의 데이터 경로(목록 · `?incident=` 이면 그 근거 묶음). 세션 검증 · 입력 검증 · 다른 서버 호출은 진입 함수가 한다(no-store). */
import { incidentsScreenResponse } from "@/features/incidents/server/incidents-screen";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return incidentsScreenResponse(request);
}
