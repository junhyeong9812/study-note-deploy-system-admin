/** 문제 화면 — 서버 쪽 진입 함수(loadIncidentsScreen)만 부른다(세션 검증 · 입력 검증 · 다른 서버 호출은 그 함수가). 내비게이션의 현재 화면은 "문제". */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadIncidentsScreen } from "@/features/incidents/server/incidents-screen";
import { IncidentsScreen } from "@/features/incidents/ui/IncidentsScreen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "문제 · study-note 어드민" };

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const outcome = await loadIncidentsScreen(await searchParams);
  return (
    <AdminShell current="incidents" temporaryRestriction={isTemporaryRestrictionActive()}>
      <IncidentsScreen outcome={outcome} />
    </AdminShell>
  );
}
