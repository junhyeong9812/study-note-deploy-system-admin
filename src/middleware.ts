/** 공통 진입 — 기본 거절. classifyPath 가 public 이라고 한 경로만 통과하고, 나머지는 서명한 세션 쿠키가 있어야 한다.
 * matcher 를 두지 않는다(모든 경로가 여기를 지난다 — 정적 자산 허용도 classifyPath 가 판단).
 * 런타임: Node.js(Next 15.5 에서 stable) — 세션 검증이 node:crypto 의 HMAC 을 쓰기 때문.
 * 이 파일이 임포트하는 것: auth-boundary · session(node:crypto 만) · server-config(환경 변수 읽기). argon2 · ioredis 는 임포트하지 않는다. */
import { NextResponse, type NextRequest } from "next/server";
import { classifyPath, unauthenticatedAction } from "@/features/auth/lib/auth-boundary";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/features/auth/lib/session";
import { readServerConfig, sessionSigningKey } from "@/shared/config/server-config";

export const config = {
  runtime: "nodejs",
};

/** 로그인 이동의 기준 주소 — 설정값(ADMIN_ORIGIN). 비었거나 해석할 수 없으면(정상 구동에서는 없다) 요청 주소. */
function loginRedirectBase(request: NextRequest): string | URL {
  const configuredOrigin = readServerConfig().adminOrigin;
  if (URL.canParse(configuredOrigin)) return configuredOrigin;
  return request.nextUrl;
}

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
    // 세부 3 은 상대 주소 `Location: /login` 을 글자 그대로 내라고 한다. 그러나 Next 15.5 의 middleware 어댑터
    // (next/dist/server/web/adapter.js 343행)는 Location 을 `new NextURL(location)` 으로 다시 해석해 상대 주소면
    // "Invalid URL" 500 이 된다(실측). 그래서 절대 주소를 주되, 기준은 요청의 호스트가 아니라 설정값 ADMIN_ORIGIN 이다
    // — 내부 호스트 이름이 나가지 않는다. nginx 의 proxy_redirect 가 바깥으로는 `/login` 으로 바꾼다.
    const response = NextResponse.redirect(new URL(action.location, loginRedirectBase(request)), 307);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  return NextResponse.json({ success: false, error: { code: "unauthorized" } },
    { status: action.status, headers: { "Cache-Control": "no-store" } });
}
