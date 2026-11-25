/** 로그 조회 화면 — 서버 쪽 진입 함수(loadLogSearch · 줄을 골랐으면 loadLogTraceWithResources — 연관 로그 + 그때 서버 자원)만 부른다.
 * (데이터 경로 /api/logs/trace 는 기존 진입 logTraceResponse 그대로 — 응답 칸 · 호출 수를 기존 테스트가 고정한다.) 세션 검증 · 입력 검증 · 관측 · 배포 · 알림 서버 호출은 그 함수들이 한다.
 * 폼의 KST 시각 칸은 진입 함수에 넘기기 전에 UTC 의 from · to 로 바꾼다(logSearchInput — 순수). 고른 줄(selected)은 연관 로그 진입에만 넘긴다(traceInput). */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadLogTraceWithResources } from "@/features/log-trace/server/log-trace-resources";
import { loadLogSearch } from "@/features/logs/server/log-search";
import { LogSearchScreen } from "@/features/logs/ui/LogSearchScreen";
import { hasLogSelection, logFormValues, logSearchInput, selectedLogIdOf, traceInput } from "@/features/logs/ui/logs-address";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "로그 조회 · study-note 어드민" };

export default async function LogsPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const input = await searchParams;
  const [view, trace] = await Promise.all([
    loadLogSearch(logSearchInput(input)),
    hasLogSelection(input) ? loadLogTraceWithResources(traceInput(input)) : Promise.resolve(null),
  ]);
  return (
    <AdminShell current="logs" temporaryRestriction={isTemporaryRestrictionActive()}>
      <LogSearchScreen view={view} formValues={logFormValues(input)} trace={trace?.outcome ?? null} traceResources={trace?.resources ?? null}
        selectedLogId={selectedLogIdOf(input)} />
    </AdminShell>
  );
}
