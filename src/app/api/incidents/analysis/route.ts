/** POST /api/incidents/analysis — 미리본 글을 보낸다(폼). 출처 · 세션 · 입력 · 서명 · 저장소 · 실행 자리 호출은 진입 함수가 한다. GET 은 없다(Next 가 405). */
import { incidentAnalysisStartResponse } from "@/features/incident-analysis/server/incident-analysis";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return incidentAnalysisStartResponse(request);
}
