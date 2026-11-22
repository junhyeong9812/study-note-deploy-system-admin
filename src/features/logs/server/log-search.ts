/** 로그 조회 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 OBSERVE_URL · OBSERVE_SECRET 을 읽고 관측 서버를 부른다.
 * 설정이 비었거나 주소가 http(s) 가 아니면 logs = not_configured(호출 없음). 시계는 Date.now, 네트워크는 부를 때의 전역 fetch. */
import "server-only";
import type { LogPage, LogQuery } from "@/features/logs/lib/log-query";
import type { SearchParamsInput, UpstreamResult } from "@/shared/lib/upstream-result";

export interface LogSearchView {
  /** 입력이 틀렸으면 null(logs 는 invalid_input, 호출 없음) */
  query: LogQuery | null;
  logs: UpstreamResult<LogPage>;
  /** 다음 쪽 조건(nextLogPageQuery) — 끝이거나 실패면 null */
  nextPageQuery: LogQuery | null;
}

/** 화면용 — 세션이 없으면 /login(다른 서버를 부르지 않는다). */
export async function loadLogSearch(searchParams: SearchParamsInput): Promise<LogSearchView> {
  void searchParams;
  throw new Error("not implemented");
}

/** 데이터 경로용 — 세션이 없으면 401. 입력이 틀리면 422 `{success:false,error:{code:"invalid_input",field}}`, 그 밖은 200 `{success:true,data:LogSearchView}`. no-store. */
export async function logSearchResponse(request: Request): Promise<Response> {
  void request;
  throw new Error("not implemented");
}
