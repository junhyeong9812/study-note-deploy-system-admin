/** 로그 조회 화면 — 서버 쪽 진입 함수(loadLogSearch)만 부른다. 세션 검증 · 입력 검증 · 관측 서버 호출은 그 함수가 한다.
 * 폼의 KST 시각 칸은 진입 함수에 넘기기 전에 UTC 의 from · to 로 바꾼다(logSearchInput — 순수). */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadLogSearch } from "@/features/logs/server/log-search";
import { LogSearchScreen } from "@/features/logs/ui/LogSearchScreen";
import { logFormValues, logSearchInput } from "@/features/logs/ui/logs-address";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "로그 조회 · study-note 어드민" };

export default async function LogsPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const input = await searchParams;
  const view = await loadLogSearch(logSearchInput(input));
  return (
    <AdminShell current="logs" temporaryRestriction={isTemporaryRestrictionActive()}>
      <LogSearchScreen view={view} formValues={logFormValues(input)} />
    </AdminShell>
  );
}
