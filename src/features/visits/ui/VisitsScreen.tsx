/** 방문 기록 화면(서버 컴포넌트 — 받은 화면 데이터만 그린다. server · *-client · 설정을 값으로 임포트하지 않는다). */
import type React from "react";
import type { VisitsScreen as VisitsScreenData } from "@/features/visits/lib/visits-screen";

export function VisitsScreen({ screen }: { screen: VisitsScreenData }): React.ReactNode {
  void screen;
  throw new Error("구현 전");
}
