/** 상태를 바꾸는 요청(로그인·로그아웃)의 Origin 검사 — 설정값(ADMIN_ORIGIN)과 글자까지 같을 때만 통과. */
export function isAllowedOrigin(originHeader: string | null | undefined, configuredOrigin: string): boolean {
  throw new Error("not implemented");
}
