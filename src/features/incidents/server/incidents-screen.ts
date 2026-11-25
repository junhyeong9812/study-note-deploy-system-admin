/** 문제 화면의 서버 쪽 진입 — 세션 검증을 **직접** 부른 뒤에만 입력을 해석하고 설정(ALERT_URL · ALERT_SECRET · OBSERVE_URL · OBSERVE_SECRET ·
 * DEPLOY_MASTER_URL · DEPLOY_SECRET)을 읽고 다른 서버를 부른다. 네트워크 = 부를 때의 전역 fetch, 시계 = Date.now.
 * 실패한 칸은 앱 로그 1줄씩(upstreamFailureLogLine("incidents", <칸>, 결과) → log("screen-incidents", 줄, "warning") — 이유 낱말 · 상태 코드만).
 * - loadIncidentsScreen(input): 세션이 없으면 /login(다른 서버를 한 번도 부르지 않는다). 입력이 틀리면 { kind: "invalid_input" }(호출 없음).
 * - incidentsScreenResponse(request): 세션 없음 401 · 입력 거절 422 `{success:false,error:{code:"invalid_input",field:"incident"}}`(호출 없음) ·
 *   그 밖 200 `{success:true,data:IncidentsScreenData}`(다른 서버의 실패는 칸의 결과로). 언제나 no-store. */
import "server-only";
import type { IncidentsScreenData } from "@/features/incidents/lib/incidents-screen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export type IncidentsScreenOutcome =
  | { kind: "screen"; data: IncidentsScreenData }
  | { kind: "invalid_input"; field: string };

export async function loadIncidentsScreen(input: SearchParamsInput): Promise<IncidentsScreenOutcome> {
  void input;
  throw new Error("not implemented");
}

export async function incidentsScreenResponse(request: Request): Promise<Response> {
  void request;
  throw new Error("not implemented");
}
