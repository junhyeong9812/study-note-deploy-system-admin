/** 재배포 확인 화면의 서버 쪽 진입 — 세션 검증을 **직접** 부른 뒤에만 입력을 해석하고 설정을 읽고 master 를 부른다.
 * 순서: 세션 → 입력(틀리면 invalid_input, 설정을 읽지 않고 부르지 않음) → 설정 → master 호출(전부 GET). 아무것도 바꾸지 않는다.
 * 설정: DEPLOY_MASTER_URL · DEPLOY_SECRET(버전 목록과 같은 것 — readServerConfig, 부를 때마다 읽는다). 둘 중 하나라도 비었거나 주소가 http(s) 가 아니면
 * preview = not_configured(호출 없음). 네트워크는 부를 때의 전역 fetch. src/app 은 이 모듈만 쓴다.
 * 실패한 칸(이력 · 방향 조회)은 앱 로그 1줄(upstreamFailureLogLine — 이유 낱말 · 상태 코드만). */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { createDeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import { buildRedeployPreview, type RedeployPreview } from "@/features/deploy-redeploy/lib/redeploy-preview";
import { parseRedeployPreviewQuery, type RedeployPreviewQuery } from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import type { DeployService } from "@/features/deploys/lib/deploy-history-query";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import { invalidInputOf, screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import { upstreamFailure, type SearchParamsInput, type UpstreamResult } from "@/shared/lib/upstream-result";

/** 확인 화면의 접수 폼(6-4) — comparison 이고 진행 중인 배포가 없을 때만. 계정 이름이 requested_by 로 쓸 수 없으면 account_not_allowed(폼 대신 안내).
 * 뼈대: 구현 워커가 채운다(지금은 언제나 null). */
export type RedeployAcceptSubmission =
  | { kind: "form"; confirmation: string; requestId: string }
  | { kind: "account_not_allowed" };

export interface RedeployPreviewView {
  /** 입력이 틀렸으면 null(그때 preview 는 invalid_input, master 를 부르지 않는다) */
  query: RedeployPreviewQuery | null;
  /** 돌아갈 버전 목록의 서비스 — 입력의 service 가 허용 목록 안의 글자 하나면 그것(commit 이 틀려도), 아니면 null */
  service: DeployService | null;
  preview: UpstreamResult<RedeployPreview>;
  /** 접수 폼 — 폼을 둘 수 없으면 null */
  submission: RedeployAcceptSubmission | null;
}

/** 세션 검증을 마친 뒤에만 부른다. */
async function buildRedeployPreviewView(searchParams: SearchParamsInput): Promise<RedeployPreviewView> {
  const parsed = parseRedeployPreviewQuery(searchParams);
  if (!parsed.ok) {
    // service 를 먼저 보므로 field 가 commit 이면 service 는 허용 목록 안의 글자 하나다
    return { query: null, service: parsed.field === "commit" ? (searchParams.service as DeployService) : null, preview: parsed, submission: null };
  }
  const config = readServerConfig();
  let preview: UpstreamResult<RedeployPreview>;
  if (!isHttpBaseUrl(config.deployMasterUrl) || config.deploySecret.length === 0) {
    preview = upstreamFailure("not_configured");
  } else {
    const options = { baseUrl: config.deployMasterUrl, secret: config.deploySecret, fetch: (input: string, init: RequestInit) => fetch(input, init) };
    preview = await buildRedeployPreview({ deployHistory: createDeployHistoryClient(options), deployGit: createDeployGitClient(options) }, parsed.query);
  }
  const cells: [string, UpstreamResult<unknown>][] = [["preview", preview]];
  if (preview.ok && preview.value.kind === "comparison" && preview.value.direction.kind === "unknown" && preview.value.direction.failure !== null) {
    cells.push(["direction", preview.value.direction.failure]);
  }
  for (const [cell, result] of cells) {
    const logLine = upstreamFailureLogLine("deploy-redeploy", cell, result);
    if (logLine !== null) void log("screen-deploy-redeploy", logLine, "warning");
  }
  return { query: parsed.query, service: parsed.query.service, preview, submission: null };
}

/** 화면용 — 세션이 없으면 requireSession 이 /login 으로 보낸다(다른 서버를 한 번도 부르지 않는다). */
export async function loadRedeployPreview(searchParams: SearchParamsInput): Promise<RedeployPreviewView> {
  await requireSession();
  return buildRedeployPreviewView(searchParams);
}

/** 데이터 경로용(Route Handler 의 GET 이 그대로 돌려준다) — 세션이 없으면 401(requireApiSession).
 * 입력이 틀리면 422 `{success:false,error:{code:"invalid_input",field}}`, 그 밖은 200 `{success:true,data:RedeployPreviewView}`. 언제나 no-store. */
export async function redeployPreviewResponse(request: Request): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  const view = await buildRedeployPreviewView(searchParamsInputFromUrl(new URL(request.url)));
  return screenDataResponse(view, invalidInputOf(view.preview));
}
