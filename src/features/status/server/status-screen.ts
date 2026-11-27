/** 상태 한눈에 + 서버 자원 요약의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 설정을 읽는다(기존 loadStatusOverview 와 같은 경계).
 * 기존 loadStatusOverview · statusOverviewResponse 는 그대로 둔다(다섯 주소만). 화면이 자원 요약을 함께 보이려면 이 진입을 쓴다.
 * 설정: 기존 다섯 칸의 것 + OBSERVE_SECRET(자원 요약). 네트워크 = 부를 때의 전역 fetch.
 * 실패한 칸은 앱 로그 1줄씩 — 다섯 칸은 upstreamFailureLogLine("status", <칸>, 결과), 자원 요약은 upstreamFailureLogLine("status", "resources", 결과)
 *   를 log(<그 요청의 추적 ID>, 줄, "warning") 로.
 * - loadStatusScreen(): 세션이 없으면 /login(다른 서버를 한 번도 부르지 않는다). StatusScreenData.
 * - statusScreenResponse(request): 세션이 없으면 401, 그 밖은 200 `{success:true,data:StatusScreenData}`(no-store). */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { collectStatusScreen, type StatusScreenData } from "@/features/status/lib/status-resources";
import { STATUS_CHECK_NAMES } from "@/features/status/lib/status-overview";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import type { UpstreamResult } from "@/shared/lib/upstream-result";
import { currentRequestId } from "@/shared/lib/request-scope";
import { inRequestScope } from "@/shared/lib/request-id";

/** 세션 검증을 마친 뒤에만 부른다. */
async function buildStatusScreen(): Promise<StatusScreenData> {
  const config = readServerConfig();
  const data = await collectStatusScreen({
    alertUrl: config.alertUrl, alertSecret: config.alertSecret, observeUrl: config.observeUrl, observeSecret: config.observeSecret,
    backendUrl: config.backendUrl, deployMasterUrl: config.deployMasterUrl, fetch: (input, init) => fetch(input, init),
  });
  const cells: [string, UpstreamResult<unknown>][] = [
    ...STATUS_CHECK_NAMES.map((name): [string, UpstreamResult<unknown>] => [name, data.overview[name]]),
    ["resources", data.resources],
  ];
  for (const [cell, result] of cells) {
    const logLine = upstreamFailureLogLine("status", cell, result);
    if (logLine !== null) void log(currentRequestId(), logLine, "warning");
  }
  return data;
}

export async function loadStatusScreen(): Promise<StatusScreenData> {
  return inRequestScope(async () => {
    await requireSession();
    return buildStatusScreen();
  });
}

export async function statusScreenResponse(request: Request): Promise<Response> {
  return inRequestScope(async () => {
    void request;
    const session = await requireApiSession();
    if (session instanceof Response) return session;
    return screenDataResponse(await buildStatusScreen(), null);
  });
}
