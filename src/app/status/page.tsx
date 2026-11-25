/** 상태 한눈에 화면 — 서버 쪽 진입 함수(loadStatusScreen)만 부른다. 세션 검증 · 다섯 호출 + 서버 자원 요약(관측 서버 latest)을 한꺼번에(각각 5초)는 그 함수가 한다.
 * (데이터 경로 /api/status 는 기존 진입 statusOverviewResponse 그대로 — 다섯 칸의 응답 꼴과 호출 주소 집합을 기존 테스트가 고정한다.)
 * 조회 시각은 다섯 칸이 모두 끝난 뒤의 이 서버 시각. 자동 새로 고침은 없다(새로 고침은 같은 주소로 가는 링크). */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadStatusScreen } from "@/features/status/server/status-screen";
import { StatusScreen } from "@/features/status/ui/StatusScreen";

export const dynamic = "force-dynamic";

export const metadata = { title: "상태 한눈에 · study-note 어드민" };

export default async function StatusPage() {
  const { overview, resources } = await loadStatusScreen();
  const checkedAt = new Date().toISOString();
  return (
    <AdminShell current="status" temporaryRestriction={isTemporaryRestrictionActive()}>
      <StatusScreen overview={overview} resources={resources} checkedAt={checkedAt} />
    </AdminShell>
  );
}
