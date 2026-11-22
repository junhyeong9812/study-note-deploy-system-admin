/** 배포 이력 화면 — 서버 쪽 진입 함수(loadDeployHistory)만 부른다. 세션 검증 · 입력 검증 · master 호출은 그 함수가 한다. */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadDeployHistory } from "@/features/deploys/server/deploy-history";
import { DeployHistoryScreen } from "@/features/deploys/ui/DeployHistoryScreen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "배포 이력 · study-note 어드민" };

export default async function DeploysPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const view = await loadDeployHistory(await searchParams);
  return (
    <AdminShell current="deploys" temporaryRestriction={isTemporaryRestrictionActive()}>
      <DeployHistoryScreen view={view} />
    </AdminShell>
  );
}
