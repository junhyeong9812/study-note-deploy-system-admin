/** 통신 지도 화면 — 뼈대(T8 테스트가 컴파일되게 하는 꼴만, 구현 전). 서버 쪽 진입 함수(loadTrafficMapScreen)만 부른다. */
import { loadTrafficMapScreen } from "@/features/traffic-map/server/traffic-map";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "통신 지도 · study-note 어드민" };

export default async function TrafficPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }): Promise<React.JSX.Element> {
  await loadTrafficMapScreen(await searchParams);
  throw new Error("T8: 구현 전");
}
