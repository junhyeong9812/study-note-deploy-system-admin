/** 서버 자원 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 OBSERVE_URL · OBSERVE_SECRET 을 읽는다(명세 §2.3 "어드민은 세션을 확인한 뒤에만 부르고").
 * 네트워크는 부를 때의 전역 fetch, 시계는 Date.now(). resourcesScreenFailures 의 칸마다 upstreamFailureLogLine("resources", <칸 이름>, 결과) 를
 * log("screen-resources", 줄, "warning") 로 1줄씩(주소 · 비밀값 없음).
 * - loadResourcesScreen(searchParams): 세션이 없으면 /login(다른 서버를 한 번도 부르지 않는다). 입력은 parseResourcesQuery(틀린 값은 기본값).
 * - resourcesScreenResponse(request): 세션이 없으면 401, 그 밖은 200 `{success:true,data:ResourcesScreen}`(no-store) — 입력은 요청 주소의 인자. */
import "server-only";
import type { ResourcesScreen } from "@/features/resources/lib/resources-screen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export async function loadResourcesScreen(searchParams: SearchParamsInput): Promise<ResourcesScreen> {
  void searchParams;
  throw new Error("not implemented");
}

export async function resourcesScreenResponse(request: Request): Promise<Response> {
  void request;
  throw new Error("not implemented");
}
