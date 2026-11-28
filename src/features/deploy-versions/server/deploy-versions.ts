/** 버전 목록 화면의 서버 쪽 진입 — 세션 검증을 **직접** 부른 뒤에만 입력을 해석하고 설정을 읽고 master 를 부른다.
 * 순서: 세션 → 입력(틀리면 invalid_input, 부르지 않음) → 고르지 않음(versions = null, 부르지 않음) → 설정 → master 호출(전부 GET).
 * 설정: DEPLOY_MASTER_URL · DEPLOY_SECRET(배포 이력 · 배포 상세와 같은 것 — readServerConfig, 부를 때마다 읽는다). 둘 중 하나라도 비었거나
 * 주소가 http(s) 가 아니면 versions = not_configured(호출 없음). 네트워크는 부를 때의 전역 fetch. src/app 은 이 모듈만 쓴다.
 * 실패한 칸(이력 · 커밋 제목)은 앱 로그 1줄(upstreamFailureLogLine — 이유 낱말 · 상태 코드만 · ID 자리는 그 요청의 추적 ID).
 * 두 진입 모두 그 요청의 추적 ID 범위에서 돈다(⑬ T2g — master 로 가는 호출이 그 값 하나를 싣는다). */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createDeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import { parseDeployVersionsQuery, type DeployVersionsQuery } from "@/features/deploy-versions/lib/deploy-versions-query";
import { buildDeployVersionList, type DeployVersionList } from "@/features/deploy-versions/lib/deploy-versions-view";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { inRequestScope } from "@/shared/lib/request-id";
import { currentRequestId } from "@/shared/lib/request-scope";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { invalidInputOf, screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import { upstreamFailure, type SearchParamsInput, type UpstreamResult } from "@/shared/lib/upstream-result";

export interface DeployVersionsView {
  /** 입력이 틀렸으면 null(그때 versions 는 invalid_input, master 를 부르지 않는다) */
  query: DeployVersionsQuery | null;
  /** 서비스를 고르지 않았으면 null(master 를 부르지 않는다) */
  versions: UpstreamResult<DeployVersionList> | null;
}

/** 세션 검증을 마친 뒤에만 부른다. */
async function buildDeployVersionsView(searchParams: SearchParamsInput): Promise<DeployVersionsView> {
  const parsed = parseDeployVersionsQuery(searchParams);
  if (!parsed.ok) return { query: null, versions: parsed };
  const { service } = parsed.query;
  if (service === null) return { query: parsed.query, versions: null };
  const config = readServerConfig();
  let versions: UpstreamResult<DeployVersionList>;
  if (!isHttpBaseUrl(config.deployMasterUrl) || config.deploySecret.length === 0) {
    versions = upstreamFailure("not_configured");
  } else {
    const options = { baseUrl: config.deployMasterUrl, secret: config.deploySecret, fetch: (input: string, init: RequestInit) => fetch(input, init) };
    versions = await buildDeployVersionList({ deployHistory: createDeployHistoryClient(options), deployGit: createDeployGitClient(options) }, service);
  }
  const cells: [string, UpstreamResult<unknown>][] = [["versions", versions]];
  if (versions.ok && versions.value.titleFailure !== null) cells.push(["titles", versions.value.titleFailure]);
  for (const [cell, result] of cells) {
    const logLine = upstreamFailureLogLine("deploy-versions", cell, result);
    if (logLine !== null) void log(currentRequestId(), logLine, "warning");
  }
  return { query: parsed.query, versions };
}

/** 화면용 — 세션이 없으면 requireSession 이 /login 으로 보낸다(다른 서버를 한 번도 부르지 않는다). */
export async function loadDeployVersions(searchParams: SearchParamsInput): Promise<DeployVersionsView> {
  return inRequestScope(async () => {
    await requireSession();
    return buildDeployVersionsView(searchParams);
  });
}

/** 데이터 경로용(Route Handler 의 GET 이 그대로 돌려준다) — 세션이 없으면 401(requireApiSession).
 * 입력이 틀리면 422 `{success:false,error:{code:"invalid_input",field}}`, 그 밖은 200 `{success:true,data:DeployVersionsView}`. 언제나 no-store. */
export async function deployVersionsResponse(request: Request): Promise<Response> {
  return inRequestScope(async () => {
    const session = await requireApiSession();
    if (session instanceof Response) return session;
    const view = await buildDeployVersionsView(searchParamsInputFromUrl(new URL(request.url)));
    return screenDataResponse(view, view.versions === null ? null : invalidInputOf(view.versions));
  });
}
