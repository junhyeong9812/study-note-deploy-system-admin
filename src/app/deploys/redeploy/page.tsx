/** 재배포 확인 화면(/deploys/redeploy) — 서버 쪽 진입 함수(loadRedeployPreview)만 부른다. 세션 검증 · 입력 검증 · master 호출은 그 함수가 한다.
 * 내비게이션에는 새 항목을 두지 않는다 — 버전 목록에서 오는 화면이라 "버전 목록"이 지금 화면이다. */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadRedeployPreview } from "@/features/deploy-redeploy/server/redeploy-preview";
import { RedeployPreviewScreen } from "@/features/deploy-redeploy/ui/RedeployPreviewScreen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "재배포 확인 · study-note 어드민" };

export default async function RedeployPreviewPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const view = await loadRedeployPreview(await searchParams);
  return (
    <AdminShell current="deploy-versions" temporaryRestriction={isTemporaryRestrictionActive()}>
      <RedeployPreviewScreen view={view} />
    </AdminShell>
  );
}
