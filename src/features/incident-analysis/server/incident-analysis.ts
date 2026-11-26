/** 분석의 서버 쪽 진입 — 화면(GET /incidents/analysis) · 보내기(POST /api/incidents/analysis). 뼈대: 세션 검증만 — 구현 워커가 채운다.
 * 계약: app/incidents/incident-analysis-page.test.ts 머리 주석. */
import "server-only";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import type { IncidentAnalysisService } from "@/features/incident-analysis/lib/incident-analysis-service";
import type { IncidentAnalysisScreenOutcome } from "@/features/incident-analysis/lib/incident-analysis-screen";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export async function loadIncidentAnalysisScreen(input: SearchParamsInput): Promise<IncidentAnalysisScreenOutcome> {
  await requireSession();
  void input;
  throw new Error("loadIncidentAnalysisScreen: 구현 전");
}

export async function incidentAnalysisStartResponse(request: Request): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  void request;
  throw new Error("incidentAnalysisStartResponse: 구현 전");
}

/** 이 프로세스의 분석 서비스(만들어졌으면) — 테스트 · 종료 로그용. */
export function existingIncidentAnalysisService(): IncidentAnalysisService | null {
  return null;
}

/** 테스트 전용 — 프로세스의 분석 서비스를 버린다(다음 부름에서 설정을 다시 읽어 만든다). */
export function resetIncidentAnalysisService(): void {}

/** SIGTERM 때 — 이 프로세스에서 도는 분석의 수를 로그 한 줄로(`incident-analysis:shutdown running=<N>`). 뼈대. */
export function logIncidentAnalysisOnShutdown(): void {}
