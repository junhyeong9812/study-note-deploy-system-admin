/** 요청 추적 화면 — 서버 쪽 진입 함수(loadRequestTrace)만 부른다. 세션 검증 · 입력 검증 · 관측 서버 호출은 그 함수가 한다(세션이 먼저). */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadRequestTrace } from "@/features/request-trace/server/request-trace";
import { RequestTraceScreen } from "@/features/request-trace/ui/RequestTraceScreen";
import { typedRequestIdOf } from "@/features/request-trace/ui/request-trace-address";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "요청 추적 · study-note 어드민" };

export default async function TracePage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const input = await searchParams;
  const view = await loadRequestTrace(input);
  return (
    <AdminShell current="trace" temporaryRestriction={isTemporaryRestrictionActive()}>
      <RequestTraceScreen view={view} typedRequestId={typedRequestIdOf(input)} />
    </AdminShell>
  );
}
