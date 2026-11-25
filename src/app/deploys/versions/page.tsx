/** 버전 목록 화면(/deploys/versions) — 서버 쪽 진입 함수(loadDeployVersions)만 부른다. 세션 검증 · 입력 검증 · master 호출은 그 함수가 한다. */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadDeployVersions } from "@/features/deploy-versions/server/deploy-versions";
import { DeployVersionsScreen } from "@/features/deploy-versions/ui/DeployVersionsScreen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "버전 목록 · study-note 어드민" };

export default async function DeployVersionsPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const view = await loadDeployVersions(await searchParams);
  return (
    <AdminShell current="deploy-versions" temporaryRestriction={isTemporaryRestrictionActive()}>
      <DeployVersionsScreen view={view} />
    </AdminShell>
  );
}
