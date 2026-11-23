/** 로그인 시도 기록 화면 — 세션 검증(requireSession)을 직접 부른 뒤 서버 쪽 진입 함수(loadLoginAttempts)만 부른다.
 * 입력 검증 · 관측 서버 호출(목록 · 잠금 상태 — 병렬, 각각 5초)은 그 함수가 한다. 폼의 KST 시각 칸은 진입 함수에 넘기기 전에 UTC 의 from · to 로 바꾼다(loginAttemptsInput — 순수). */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { requireSession } from "@/features/auth/server/require-session";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { loadLoginAttempts } from "@/features/login-attempts/server/login-attempts";
import { LoginAttemptsScreen } from "@/features/login-attempts/ui/LoginAttemptsScreen";
import { loginAttemptsFormValues, loginAttemptsInput } from "@/features/login-attempts/ui/login-attempts-address";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "로그인 시도 기록 · study-note 어드민" };

export default async function LoginAttemptsPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  await requireSession();
  const input = await searchParams;
  const view = await loadLoginAttempts(loginAttemptsInput(input));
  return (
    <AdminShell current="login-attempts" temporaryRestriction={isTemporaryRestrictionActive()}>
      <LoginAttemptsScreen view={view} formValues={loginAttemptsFormValues(input)} />
    </AdminShell>
  );
}
