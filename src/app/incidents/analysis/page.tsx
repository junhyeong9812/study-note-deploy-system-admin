/** 분석 화면 — 서버 쪽 진입 함수(loadIncidentAnalysisScreen)만 부른다. 내비게이션의 현재 화면은 "문제". */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadIncidentAnalysisScreen } from "@/features/incident-analysis/server/incident-analysis";
import { IncidentAnalysisScreen } from "@/features/incident-analysis/ui/IncidentAnalysisScreen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "분석 · study-note 어드민" };

export default async function IncidentAnalysisPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const outcome = await loadIncidentAnalysisScreen(await searchParams);
  return (
    <AdminShell current="incidents" temporaryRestriction={isTemporaryRestrictionActive()}>
      <IncidentAnalysisScreen outcome={outcome} />
    </AdminShell>
  );
}
