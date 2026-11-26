/** 방문 기록 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 OBSERVE_URL · OBSERVE_SECRET · SITE_ORIGIN 을 읽는다(명세 §2 "어드민 조회는 로그인 뒤에만").
 * 네트워크는 부를 때의 전역 fetch. visitsScreenFailures 의 칸마다 upstreamFailureLogLine("visits", <칸 이름>, 결과) 를
 * log("screen-visits", 줄, "warning") 로 1줄씩(주소 · 비밀값 없음).
 * - loadVisitsScreen(searchParams): 세션이 없으면 /login(다른 서버를 한 번도 부르지 않는다). 입력은 parseVisitsQuery(틀린 값은 기본값 7).
 * - visitsScreenResponse(request): 세션이 없으면 401, 그 밖은 200 `{success:true,data:VisitsScreen}`(no-store) — 입력은 요청 주소의 인자. */
import "server-only";
import type { VisitsScreen } from "@/features/visits/lib/visits-screen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export async function loadVisitsScreen(searchParams: SearchParamsInput): Promise<VisitsScreen> {
  void searchParams;
  throw new Error("구현 전");
}

export async function visitsScreenResponse(request: Request): Promise<Response> {
  void request;
  throw new Error("구현 전");
}
