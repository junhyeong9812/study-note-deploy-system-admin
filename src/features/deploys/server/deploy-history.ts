/** 배포 이력 화면의 서버 쪽 진입 — 세션 검증을 **직접** 부른 뒤에만 설정을 읽고 master 를 부른다(명세 ② 세부 "인증 경계의 구현 형태").
 * 설정: DEPLOY_MASTER_URL · DEPLOY_SECRET(readServerConfig — 부를 때마다 읽는다). 둘 중 하나라도 비었거나 주소가 http(s) 가 아니면
 * deployments = not_configured(호출 없음). 네트워크는 부를 때의 전역 fetch. src/app 은 이 모듈만 쓴다(lib 클라이언트를 직접 만들지 않는다). */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createDeployHistoryClient, type DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import { parseDeployHistoryQuery, type DeployHistoryQuery } from "@/features/deploys/lib/deploy-history-query";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { invalidInputOf, screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import { upstreamFailure, type SearchParamsInput, type UpstreamResult } from "@/shared/lib/upstream-result";
import { currentRequestId } from "@/shared/lib/request-scope";
import { inRequestScope } from "@/shared/lib/request-id";

export interface DeployHistoryView {
  /** 입력이 틀렸으면 null(그때 deployments 는 invalid_input, master 를 부르지 않는다). */
  query: DeployHistoryQuery | null;
  deployments: UpstreamResult<DeploymentSummary[]>;
}

/** 세션 검증을 마친 뒤에만 부른다. */
async function buildDeployHistoryView(searchParams: SearchParamsInput): Promise<DeployHistoryView> {
  const parsed = parseDeployHistoryQuery(searchParams);
  if (!parsed.ok) return { query: null, deployments: parsed };
  const config = readServerConfig();
  let deployments: UpstreamResult<DeploymentSummary[]>;
  if (!isHttpBaseUrl(config.deployMasterUrl) || config.deploySecret.length === 0) {
    deployments = upstreamFailure("not_configured");
  } else {
    const client = createDeployHistoryClient({
      baseUrl: config.deployMasterUrl, secret: config.deploySecret, fetch: (input, init) => fetch(input, init),
    });
    deployments = await client.listDeployments(parsed.query);
  }
  const logLine = upstreamFailureLogLine("deploys", "deployments", deployments);
  if (logLine !== null) void log(currentRequestId(), logLine, "warning");
  return { query: parsed.query, deployments };
}

/** 화면용 — 세션이 없으면 requireSession 이 /login 으로 보낸다(다른 서버를 한 번도 부르지 않는다). */
export async function loadDeployHistory(searchParams: SearchParamsInput): Promise<DeployHistoryView> {
  return inRequestScope(async () => {
    await requireSession();
    return buildDeployHistoryView(searchParams);
  });
}

/** 데이터 경로용(Route Handler 의 GET 이 그대로 돌려준다) — 세션이 없으면 401(requireApiSession).
 * 입력이 틀리면 422 `{success:false,error:{code:"invalid_input",field}}`, 그 밖은 200 `{success:true,data:DeployHistoryView}`. 언제나 no-store. */
export async function deployHistoryResponse(request: Request): Promise<Response> {
  return inRequestScope(async () => {
    const session = await requireApiSession();
    if (session instanceof Response) return session;
    const view = await buildDeployHistoryView(searchParamsInputFromUrl(new URL(request.url)));
    return screenDataResponse(view, invalidInputOf(view.deployments));
  });
}
