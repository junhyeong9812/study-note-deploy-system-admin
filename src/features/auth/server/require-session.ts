/** 서버 쪽 세션 검증 — middleware 와 두 겹. 보호 화면 · 데이터 경로 · 다른 서버를 부르는 서버 쪽 함수는 전부 이것을 직접 호출한다. */
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LOGIN_PATH } from "@/features/auth/lib/auth-boundary";
import { SESSION_COOKIE_NAME, verifySessionToken, type VerifiedSession } from "@/features/auth/lib/session";
import { sessionSigningKey } from "@/shared/config/server-config";
import { unauthorizedResponse } from "@/shared/lib/responses";

/** 쿠키의 세션 — 없거나 무효면 null. */
export async function readVerifiedSession(): Promise<VerifiedSession | null> {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, sessionSigningKey(), Date.now());
}

/** 화면용 — 세션이 없으면 로그인으로 보낸다(돌아오지 않는다). */
export async function requireSession(): Promise<VerifiedSession> {
  const session = await readVerifiedSession();
  if (session === null) redirect(LOGIN_PATH);
  return session;
}

/** 데이터 경로용 — 세션이 없으면 401 응답을 돌려준다. 호출하는 쪽: `if (session instanceof Response) return session;` */
export async function requireApiSession(): Promise<VerifiedSession | Response> {
  const session = await readVerifiedSession();
  return session ?? unauthorizedResponse();
}
