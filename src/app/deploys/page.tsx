/** 배포 이력 화면 — 서버 쪽 진입 함수(loadDeployHistory · 상세를 열었으면 loadDeployDetail)만 부른다. 세션 검증 · 입력 검증 · master · GitHub 호출은 그 함수들이 한다. */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadDeployDetail } from "@/features/deploy-detail/server/deploy-detail";
import { loadDeployHistory } from "@/features/deploys/server/deploy-history";
import { DeployHistoryScreen } from "@/features/deploys/ui/DeployHistoryScreen";
import { detailInput, hasDetailSelection, incidentIdOf, selectedRequestIdOf } from "@/features/deploys/ui/deploys-address";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "배포 이력 · study-note 어드민" };

export default async function DeploysPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const input = await searchParams;
  const [view, detail] = await Promise.all([
    loadDeployHistory(input),
    hasDetailSelection(input) ? loadDeployDetail(detailInput(input)) : Promise.resolve(null),
  ]);
  return (
    <AdminShell current="deploys" temporaryRestriction={isTemporaryRestrictionActive()}>
      <DeployHistoryScreen view={view} detail={detail} selectedRequestId={selectedRequestIdOf(input)} incidentId={incidentIdOf(input)} />
    </AdminShell>
  );
}
