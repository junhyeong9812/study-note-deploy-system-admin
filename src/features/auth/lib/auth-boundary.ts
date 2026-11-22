/** 인증 경계 판정 — middleware 가 부른다. 기본 거절: 허용 목록에 없는 모든 경로는 세션 필요. */

/** 세션 없이 열리는 경로(글자까지 같을 때). */
export const PUBLIC_EXACT_PATHS: readonly string[] = ["/login", "/api/auth/login", "/api/health", "/favicon.ico"];
/** 세션 없이 열리는 접두(빌드 정적 자산). */
export const PUBLIC_PATH_PREFIXES: readonly string[] = ["/_next/static/"];

export const LOGIN_PATH = "/login";

export type PathAccess = "public" | "session_required";

/** 접두 허용에서 막는 모양 — 상위 이동(`..`)·빈 조각(`//`)·인코딩된 글자(`%`)·역슬래시. */
const SUSPICIOUS_PATH_PATTERN = /(^|\/)\.\.?(\/|$)|\/\/|%|\\/;

export function classifyPath(pathname: string): PathAccess {
  if (PUBLIC_EXACT_PATHS.includes(pathname)) return "public";
  if (SUSPICIOUS_PATH_PATTERN.test(pathname)) return "session_required";
  for (const prefix of PUBLIC_PATH_PREFIXES) {
    if (pathname.startsWith(prefix) && pathname.length > prefix.length) return "public";
  }
  return "session_required";
}

export type UnauthenticatedAction =
  | { kind: "redirect"; location: string }    // 화면 → 로그인
  | { kind: "unauthorized"; status: 401 };    // 데이터 경로(/api/ 로 시작)

/** 세션 필요 경로에 세션이 없을 때 할 일. */
export function unauthenticatedAction(pathname: string): UnauthenticatedAction {
  if (pathname === "/api" || pathname.startsWith("/api/")) return { kind: "unauthorized", status: 401 };
  return { kind: "redirect", location: LOGIN_PATH };
}
