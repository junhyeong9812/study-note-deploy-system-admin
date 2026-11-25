/** 버전 목록 화면의 서버 쪽 진입 — 뼈대: 타입과 시그니처만. 구현 워커가 채운다(세션 검증을 직접 부른 뒤에만 설정을 읽고 master 를 부른다). */
import type { DeployVersionsQuery } from "@/features/deploy-versions/lib/deploy-versions-query";
import type { DeployVersionList } from "@/features/deploy-versions/lib/deploy-versions-view";
import type { SearchParamsInput, UpstreamResult } from "@/shared/lib/upstream-result";

export interface DeployVersionsView {
  /** 입력이 틀렸으면 null(그때 versions 는 invalid_input, master 를 부르지 않는다) */
  query: DeployVersionsQuery | null;
  /** 서비스를 고르지 않았으면 null(master 를 부르지 않는다) */
  versions: UpstreamResult<DeployVersionList> | null;
}

/** 화면용 — 세션이 없으면 /login. */
export async function loadDeployVersions(searchParams: SearchParamsInput): Promise<DeployVersionsView> {
  void searchParams;
  throw new Error("not implemented: loadDeployVersions");
}

/** 데이터 경로용 — 세션이 없으면 401, 입력이 틀리면 422, 그 밖은 200 `{success:true,data:DeployVersionsView}`(no-store). */
export async function deployVersionsResponse(request: Request): Promise<Response> {
  void request;
  throw new Error("not implemented: deployVersionsResponse");
}
