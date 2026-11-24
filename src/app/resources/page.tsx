/** 서버 자원 화면 — 서버 쪽 진입 함수(loadResourcesScreen)만 부른다. 세션 검증 · 관측 서버 호출(1단계 latest, 2단계 계열 — 각각 5초)은 그 함수가 한다.
 * 주소 입력(range · server · container)은 틀려도 거절하지 않고 기본값으로 화면을 띄운다. 자동 갱신은 화면 본문의 meta refresh(스크립트 없음 — 명세 §17), 끈 상태 · 펼친 그래프는 주소의 refresh · open. */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadResourcesScreen } from "@/features/resources/server/resources-screen";
import { ResourcesScreen } from "@/features/resources/ui/ResourcesScreen";
import { resourcesViewStateOf } from "@/features/resources/ui/resources-view";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "서버 자원 · study-note 어드민" };

export default async function ResourcesPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const input = await searchParams;
  const screen = await loadResourcesScreen(input);   // 세션 검증이 먼저 — 그 뒤에만 화면 상태를 읽는다
  return (
    <AdminShell current="resources" temporaryRestriction={isTemporaryRestrictionActive()}>
      <ResourcesScreen screen={screen} view={resourcesViewStateOf(input)} />
    </AdminShell>
  );
}
