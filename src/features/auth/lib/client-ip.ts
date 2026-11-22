/** 클라이언트 IP — nginx 가 다시 쓴 `X-Real-IP` 한 헤더만 읽는다(X-Forwarded-For 등은 보지 않는다).
 * 없거나 비면 null. */
export function readClientIp(headers: Headers): string | null {
  const value = headers.get("x-real-ip")?.trim() ?? "";
  return value.length > 0 ? value : null;
}

/** 헤더가 없는 요청을 묶어 세는 이름 — nginx 를 거치지 않은 요청들은 속도 제한에서 한 통으로 센다. */
export const UNKNOWN_CLIENT_IP = "unknown";

/** 속도 제한·시도 기록에 쓰는 IP — 헤더가 없으면 `unknown`(헤더를 빼서 제한을 피하지 못하게). */
export function clientIpOrUnknown(headers: Headers): string {
  return readClientIp(headers) ?? UNKNOWN_CLIENT_IP;
}
