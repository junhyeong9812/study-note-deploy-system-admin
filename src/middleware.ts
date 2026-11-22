/** 공통 진입 — 기본 거절. classifyPath 가 public 이라고 한 경로만 통과하고, 나머지는 서명한 세션 쿠키가 있어야 한다.
 * matcher 를 두지 않는다(모든 경로가 여기를 지난다 — 정적 자산 허용도 classifyPath 가 판단).
 * 런타임: Node.js(Next 15.5 에서 stable) — 세션 검증이 node:crypto 의 HMAC 을 쓰기 때문.
 * 이 파일이 임포트하는 것: auth-boundary · session(node:crypto 만) · server-config(환경 변수 읽기). argon2 · ioredis 는 임포트하지 않는다. */
import { NextResponse, type NextRequest } from "next/server";
import { classifyPath, unauthenticatedAction } from "@/features/auth/lib/auth-boundary";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/features/auth/lib/session";
import { sessionSigningKey } from "@/shared/config/server-config";

export const config = {
  runtime: "nodejs",
};

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (classifyPath(pathname) === "public") return NextResponse.next();

  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, sessionSigningKey(), Date.now());
  if (session !== null) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const action = unauthenticatedAction(pathname);
  if (action.kind === "redirect") {
    // Next 는 같은 출처로의 이동을 상대 Location(`/login`)으로 바꿔 내보낸다 — Host 헤더로 만든 절대 주소가 밖으로 나가지 않는다
    const response = NextResponse.redirect(new URL(action.location, request.nextUrl), 307);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  return NextResponse.json({ success: false, error: { code: "unauthorized" } },
    { status: action.status, headers: { "Cache-Control": "no-store" } });
}
