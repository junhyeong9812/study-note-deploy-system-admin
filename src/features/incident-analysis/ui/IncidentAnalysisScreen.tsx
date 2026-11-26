/** 분석 화면(서버 컴포넌트 — 스크립트 없음). 뼈대: 구현 워커가 채운다. 계약: IncidentAnalysisScreen.test.ts 머리 주석. */
import type { ReactNode } from "react";
import type { IncidentAnalysisScreenOutcome } from "@/features/incident-analysis/lib/incident-analysis-screen";

export function IncidentAnalysisScreen({ outcome }: { outcome: IncidentAnalysisScreenOutcome }): ReactNode {
  void outcome;
  throw new Error("IncidentAnalysisScreen: 구현 전");
}
