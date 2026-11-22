/** 클라이언트 IP — nginx 가 다시 쓴 `X-Real-IP` 한 헤더만 읽는다(X-Forwarded-For 등은 보지 않는다).
 * 없거나 비면 null. */
export function readClientIp(headers: Headers): string | null {
  throw new Error("not implemented");
}
