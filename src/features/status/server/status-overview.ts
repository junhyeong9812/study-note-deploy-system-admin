/** 상태 한눈에 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 ALERT_URL · ALERT_SECRET · OBSERVE_URL · BACKEND_URL · DEPLOY_MASTER_URL 을 읽는다.
 * 네트워크는 부를 때의 전역 fetch. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { STATUS_CHECK_NAMES, collectStatusOverview, type StatusOverview } from "@/features/status/lib/status-overview";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";

async function buildStatusOverview(): Promise<StatusOverview> {
  const config = readServerConfig();
  const overview = await collectStatusOverview({
    alertUrl: config.alertUrl, alertSecret: config.alertSecret, observeUrl: config.observeUrl,
    backendUrl: config.backendUrl, deployMasterUrl: config.deployMasterUrl, fetch: (input, init) => fetch(input, init),
  });
  for (const name of STATUS_CHECK_NAMES) {
    const logLine = upstreamFailureLogLine("status", name, overview[name]);
    if (logLine !== null) void log("screen-status", logLine, "warning");
  }
  return overview;
}

/** 화면용 — 세션이 없으면 /login(다른 서버를 한 번도 부르지 않는다). */
export async function loadStatusOverview(): Promise<StatusOverview> {
  await requireSession();
  return buildStatusOverview();
}

/** 데이터 경로용 — 세션이 없으면 401, 그 밖은 200 `{success:true,data:StatusOverview}`. no-store. */
export async function statusOverviewResponse(request: Request): Promise<Response> {
  void request;
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  return screenDataResponse(await buildStatusOverview(), null);
}
