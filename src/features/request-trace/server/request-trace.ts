/** 요청 추적의 서버 쪽 진입 — 뼈대(구현 전). */
import "server-only";
import type { RequestTraceView } from "@/features/request-trace/lib/request-trace-view";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

/** 화면용 — 세션이 없으면 /login(관측 서버를 부르지 않는다). */
export async function loadRequestTrace(searchParams: SearchParamsInput): Promise<RequestTraceView> {
  void searchParams;
  throw new Error("구현 전");
}

/** 데이터 경로용 — 세션이 없으면 401 · 입력이 없거나 틀리면 422 · 그 밖 200 {success:true,data:RequestTraceView}. */
export async function requestTraceResponse(request: Request): Promise<Response> {
  void request;
  throw new Error("구현 전");
}
