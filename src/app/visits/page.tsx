/** 방문 기록 화면 — 서버 쪽 진입 함수(loadVisitsScreen)만 부른다. 세션 검증 · 관측 서버 호출(5초)은 그 함수가 한다.
 * 주소 입력(days)은 틀려도 거절하지 않고 기본값(7)으로 화면을 띄운다. 스크립트 없음. */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadVisitsScreen } from "@/features/visits/server/visits-screen";
import { VisitsScreen } from "@/features/visits/ui/VisitsScreen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "방문 기록 · study-note 어드민" };

export default async function VisitsPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const screen = await loadVisitsScreen(await searchParams);   // 세션 검증이 먼저
  return (
    <AdminShell current="visits" temporaryRestriction={isTemporaryRestrictionActive()}>
      <VisitsScreen screen={screen} />
    </AdminShell>
  );
}
