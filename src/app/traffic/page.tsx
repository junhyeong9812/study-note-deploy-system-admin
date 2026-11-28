/** 통신 지도 화면 — 서버 쪽 진입 함수(loadTrafficMapScreen)만 부른다. 세션 검증과 첫 그림(허브의 snapshot — 관측 서버를 직접 부르지 않는다)은 그 함수가 한다.
 * 그 뒤의 갱신은 브라우저 조각이 같은 출처의 `/api/traffic/stream` 으로 받는다. 기간(range)은 틀려도 기본값. */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadTrafficMapScreen } from "@/features/traffic-map/server/traffic-map";
import { TrafficMapScreen } from "@/features/traffic-map/ui/TrafficMapScreen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "통신 지도 · study-note 어드민" };

export default async function TrafficPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }): Promise<React.JSX.Element> {
  const screen = await loadTrafficMapScreen(await searchParams);   // 세션 검증이 먼저
  return (
    <AdminShell current="traffic" temporaryRestriction={isTemporaryRestrictionActive()}>
      <TrafficMapScreen screen={screen} />
    </AdminShell>
  );
}
