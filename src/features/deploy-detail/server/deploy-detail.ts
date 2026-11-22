/** 배포 상세의 서버 쪽 진입 — 세션 검증을 **직접** 부른 뒤에만 입력을 해석하고 설정을 읽고 master · GitHub 를 부른다(명세 ② 세부 "인증 경계의 구현 형태" · §10.2).
 * 설정: DEPLOY_MASTER_URL · DEPLOY_SECRET(없으면 deployment = not_configured, 호출 없음) · GITHUB_TOKEN(선택 — 비면 Authorization 없이 부른다).
 * GitHub 기준 주소 = GITHUB_API_BASE_URL(코드 상수). 네트워크 = 부를 때의 전역 fetch, 시계 = Date.now.
 * GitHub 캐시(createCachedGitHubClient)는 이 모듈에 하나 — 요청 사이에 이어진다(재시작하면 비워짐).
 * 실패한 칸은 앱 로그 1줄(upstreamFailureLogLine — 이유 낱말 · 상태 코드만, 토큰 · 주소 · 원문 없음).
 * 응답(언제나 no-store):
 * - 세션 없음 → 401(requireApiSession — master · GitHub 를 부르지 않는다)
 * - 입력 거절 · 목록 밖 commit → 422 `{success:false,error:{code:"invalid_input",field}}`(입력 거절은 master · GitHub 를 부르지 않는다)
 * - 선택한 배포가 master 목록에 없음 → 404 `{success:false,error:{code:"not_found"}}`
 * - 그 밖 → 200 `{success:true,data:DeployDetailView}`(GitHub · master 의 실패는 칸의 결과로). */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import type { DeployDetailOutcome } from "@/features/deploy-detail/lib/deploy-detail-view";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

/** 화면용 — 세션이 없으면 requireSession 이 /login 으로 보낸다(다른 서버를 한 번도 부르지 않는다). */
export async function loadDeployDetail(searchParams: SearchParamsInput): Promise<DeployDetailOutcome> {
  await requireSession();
  throw new Error("not implemented");
}

/** 데이터 경로용(Route Handler 의 GET 이 그대로 돌려준다). */
export async function deployDetailResponse(request: Request): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  throw new Error("not implemented");
}
