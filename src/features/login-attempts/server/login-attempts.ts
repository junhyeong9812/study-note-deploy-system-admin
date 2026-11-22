/** 로그인 시도 기록 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 OBSERVE_URL · OBSERVE_SECRET 을 읽는다.
 * 목록과 잠금 상태를 **병렬**로 부르고 각각 5초 — 하나가 실패해도 다른 하나는 보인다. */
import "server-only";
import type { LockStatusView, LoginAttemptsPage, LoginAttemptsQuery } from "@/features/login-attempts/lib/login-attempts-query";
import type { SearchParamsInput, UpstreamResult } from "@/shared/lib/upstream-result";

export interface LoginAttemptsScreenView {
  /** 입력이 틀렸으면 null — attempts 는 invalid_input(목록은 부르지 않는다). 잠금 상태는 입력과 무관하게 부른다. */
  query: LoginAttemptsQuery | null;
  attempts: UpstreamResult<LoginAttemptsPage>;
  lock: UpstreamResult<LockStatusView>;
  nextPageQuery: LoginAttemptsQuery | null;
}

/** 화면용 — 세션이 없으면 /login(다른 서버를 부르지 않는다). */
export async function loadLoginAttempts(searchParams: SearchParamsInput): Promise<LoginAttemptsScreenView> {
  void searchParams;
  throw new Error("not implemented");
}

/** 데이터 경로용 — 세션이 없으면 401. 입력이 틀리면 422 `{success:false,error:{code:"invalid_input",field}}`, 그 밖은 200 `{success:true,data:LoginAttemptsScreenView}`. no-store. */
export async function loginAttemptsResponse(request: Request): Promise<Response> {
  void request;
  throw new Error("not implemented");
}
