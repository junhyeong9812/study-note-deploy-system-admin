/** 주인 표시 화면(/owner-mark) — 서버 쪽 진입 함수(loadOwnerMarkScreen)만 부른다. 세션 검증 · 설정 · 쿠키의 판정은 그 함수가 한다.
 * 표시하기 · 지우기는 POST /api/owner-mark · /api/owner-mark/clear 로 스크립트 없이 보낸다. */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadOwnerMarkScreen } from "@/features/owner-mark/server/owner-mark-screen";
import { OwnerMarkScreen } from "@/features/owner-mark/ui/OwnerMarkScreen";

export const dynamic = "force-dynamic";

export const metadata = { title: "주인 표시 · study-note 어드민" };

export default async function OwnerMarkPage() {
  const screen = await loadOwnerMarkScreen();
  return (
    <AdminShell current="owner-mark" temporaryRestriction={isTemporaryRestrictionActive()}>
      <OwnerMarkScreen screen={screen} />
    </AdminShell>
  );
}
