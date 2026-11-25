/** Claude 사용량 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 CLAUDE_RUNNER_URL · CLAUDE_RUNNER_SETTINGS_SECRET 을 읽고 실행 자리를 부른다.
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 몸은 구현 워커가 채운다.
 * - loadClaudeUsageScreen(): 세션이 없으면 /login(실행 자리를 한 번도 부르지 않는다). 세 칸(헬스 · 사용량 · 상한)을 함께 읽는다 —
 *   한 칸의 실패는 그 칸에만(다른 칸은 그대로). 주소가 http(s) 로 해석되지 않으면 세 칸 모두 not_configured, 비밀값이 비면 사용량 · 상한만 not_configured.
 * - claudeUsageScreenResponse(request): GET /api/claude-usage — 세션이 없으면 401, 그 밖은 200 `{success:true,data:ClaudeUsageScreen}`(no-store).
 * - 실패한 칸마다 앱 로그 1줄(upstreamFailureLogLine("claude-usage", <칸>, 결과)) — 주소 · 비밀값 없음. */
import "server-only";
import type { ClaudeLimits } from "@/features/claude-usage/lib/claude-limits";
import type { ClaudeRunnerHealth, ClaudeUsage } from "@/features/claude-usage/lib/claude-runner-client";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

export interface ClaudeUsageScreen {
  health: UpstreamResult<ClaudeRunnerHealth>;
  usage: UpstreamResult<ClaudeUsage>;
  limits: UpstreamResult<ClaudeLimits>;
}

export async function loadClaudeUsageScreen(): Promise<ClaudeUsageScreen> {
  throw new Error("not implemented: loadClaudeUsageScreen");
}

export async function claudeUsageScreenResponse(_request: Request): Promise<Response> {
  throw new Error("not implemented: claudeUsageScreenResponse");
}
