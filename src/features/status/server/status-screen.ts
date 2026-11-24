/** 상태 한눈에 + 서버 자원 요약의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 설정을 읽는다(기존 loadStatusOverview 와 같은 경계).
 * 기존 loadStatusOverview · statusOverviewResponse 는 그대로 둔다(다섯 주소만). 화면이 자원 요약을 함께 보이려면 이 진입을 쓴다.
 * 설정: 기존 다섯 칸의 것 + OBSERVE_SECRET(자원 요약). 네트워크 = 부를 때의 전역 fetch.
 * 실패한 칸은 앱 로그 1줄씩 — 다섯 칸은 upstreamFailureLogLine("status", <칸>, 결과), 자원 요약은 upstreamFailureLogLine("status", "resources", 결과)
 *   를 log("screen-status", 줄, "warning") 로.
 * - loadStatusScreen(): 세션이 없으면 /login(다른 서버를 한 번도 부르지 않는다). StatusScreenData.
 * - statusScreenResponse(request): 세션이 없으면 401, 그 밖은 200 `{success:true,data:StatusScreenData}`(no-store). */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import type { StatusScreenData } from "@/features/status/lib/status-resources";

export async function loadStatusScreen(): Promise<StatusScreenData> {
  await requireSession();
  throw new Error("not implemented");
}

export async function statusScreenResponse(request: Request): Promise<Response> {
  void request;
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  throw new Error("not implemented");
}
