/** Claude 사용량 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 CLAUDE_RUNNER_URL · CLAUDE_RUNNER_SETTINGS_SECRET 을 읽고 실행 자리를 부른다.
 * - loadClaudeUsageScreen(): 세션이 없으면 /login(실행 자리를 한 번도 부르지 않는다). 세 칸(헬스 · 사용량 · 상한)을 함께 읽는다 —
 *   한 칸의 실패는 그 칸에만(다른 칸은 그대로). 주소가 http(s) 로 해석되지 않으면 세 칸 모두 not_configured, 비밀값이 비면 사용량 · 상한만 not_configured.
 * - claudeUsageScreenResponse(request): GET /api/claude-usage — 세션이 없으면 401, 그 밖은 200 `{success:true,data:ClaudeUsageScreen}`(no-store).
 * - 실패한 칸마다 앱 로그 1줄(upstreamFailureLogLine("claude-usage", <칸>, 결과) — ID 자리는 그 요청의 추적 ID) — 주소 · 비밀값 없음.
 * - 두 진입 모두 그 요청의 추적 ID 범위에서 돈다(⑬ T2g). 실행 자리는 우리 규약 밖이라 그 호출에는 추적 ID 도 호출자 머리글도 싣지 않는다(클라이언트가 끈다). */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import type { ClaudeLimits } from "@/features/claude-usage/lib/claude-limits";
import { createClaudeRunnerClient, type ClaudeRunnerHealth, type ClaudeUsage } from "@/features/claude-usage/lib/claude-runner-client";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { inRequestScope } from "@/shared/lib/request-id";
import { currentRequestId } from "@/shared/lib/request-scope";
import { screenDataResponse, upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export interface ClaudeUsageScreen {
  health: UpstreamResult<ClaudeRunnerHealth>;
  usage: UpstreamResult<ClaudeUsage>;
  limits: UpstreamResult<ClaudeLimits>;
}

/** 세션 검증을 마친 뒤에만 부른다. */
async function buildClaudeUsageScreen(): Promise<ClaudeUsageScreen> {
  const config = readServerConfig();
  let screen: ClaudeUsageScreen;
  if (!isHttpBaseUrl(config.claudeRunnerUrl)) {
    screen = { health: upstreamFailure("not_configured"), usage: upstreamFailure("not_configured"), limits: upstreamFailure("not_configured") };
  } else {
    const client = createClaudeRunnerClient({
      baseUrl: config.claudeRunnerUrl, settingsSecret: config.claudeRunnerSettingsSecret, fetch: (input, init) => fetch(input, init),
    });
    const hasSecret = config.claudeRunnerSettingsSecret.length > 0;
    const [health, usage, limits] = await Promise.all([
      client.readHealth(),
      hasSecret ? client.readUsage() : Promise.resolve(upstreamFailure("not_configured")),
      hasSecret ? client.readLimits() : Promise.resolve(upstreamFailure("not_configured")),
    ]);
    screen = { health, usage, limits };
  }
  for (const [cell, result] of Object.entries(screen)) {
    const logLine = upstreamFailureLogLine("claude-usage", cell, result);
    if (logLine !== null) void log(currentRequestId(), logLine, "warning");
  }
  return screen;
}

export async function loadClaudeUsageScreen(): Promise<ClaudeUsageScreen> {
  return inRequestScope(async () => {
    await requireSession();
    return buildClaudeUsageScreen();
  });
}

export async function claudeUsageScreenResponse(_request: Request): Promise<Response> {
  return inRequestScope(async () => {
    const session = await requireApiSession();
    if (session instanceof Response) return session;
    return screenDataResponse(await buildClaudeUsageScreen(), null);
  });
}
