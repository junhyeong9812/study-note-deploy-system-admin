/** Claude 사용량 화면(/claude-usage) — 서버 쪽 진입 함수(loadClaudeUsageScreen)만 부른다. 세션 검증 · 실행 자리 호출은 그 함수가 한다.
 * 상한을 바꾸는 폼은 POST /api/claude-usage/limits 로 스크립트 없이 보낸다. */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadClaudeUsageScreen } from "@/features/claude-usage/server/claude-usage-screen";
import { ClaudeUsageScreen } from "@/features/claude-usage/ui/ClaudeUsageScreen";

export const dynamic = "force-dynamic";

export const metadata = { title: "Claude 사용량 · study-note 어드민" };

export default async function ClaudeUsagePage() {
  const screen = await loadClaudeUsageScreen();
  return (
    <AdminShell current="claude-usage" temporaryRestriction={isTemporaryRestrictionActive()}>
      <ClaudeUsageScreen screen={screen} />
    </AdminShell>
  );
}
