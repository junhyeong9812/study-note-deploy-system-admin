/** 연관 로그 + 그때 서버 자원의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 입력을 해석하고 설정을 읽는다(기존 loadLogTrace 와 같은 경계).
 * 기존 loadLogTrace · logTraceResponse 는 그대로 둔다(호출 수 · 응답 칸 그대로). 화면이 자원 칸을 함께 보이려면 이 진입을 쓴다.
 * 순서: 입력 거절이면 아무것도 부르지 않는다. 아니면 buildLogTrace(기존 그대로)와 collectTraceResources(atMilliseconds = query.selectedAtMilliseconds)를
 *   한꺼번에 시작한다 — service 는 고른 로그가 확인되는 대로(view.selected 가 성공이면 그 service, 실패 · not_found 면 null) 풀린다.
 *   (고른 로그 확인은 buildLogTrace 의 1단계 a 다 — 구현은 buildLogTrace 에 선택 인자로 그 결과를 알리는 길을 더해도 된다. 기존 호출 · 테스트의 꼴은 그대로.)
 * 설정: 기존 셋 + 같은 OBSERVE_URL · OBSERVE_SECRET(자원). 자원 칸의 실패는 upstreamFailureLogLine("log-trace", "resources:<location|host|container>", 결과) 1줄씩.
 * - loadLogTraceWithResources(searchParams): 세션이 없으면 /login. { outcome, resources }(outcome 은 loadLogTrace 와 같은 값, view 가 아니면 resources 는 null).
 * - logTraceWithResourcesResponse(request): 401 · 422 · 404 는 logTraceResponse 와 같은 본문, 그 밖은 200 `{success:true,data:{trace:LogTraceView, resources:TraceResourcesView|null}}`. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import type { TraceResourcesView } from "@/features/log-trace/lib/trace-resources";
import type { LogTraceOutcome } from "@/features/log-trace/lib/log-trace-view";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export interface LogTraceWithResources {
  outcome: LogTraceOutcome;
  resources: TraceResourcesView | null;
}

export async function loadLogTraceWithResources(searchParams: SearchParamsInput): Promise<LogTraceWithResources> {
  void searchParams;
  await requireSession();
  throw new Error("not implemented");
}

export async function logTraceWithResourcesResponse(request: Request): Promise<Response> {
  void request;
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  throw new Error("not implemented");
}
