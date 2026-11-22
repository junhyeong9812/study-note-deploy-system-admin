/** JSON 응답 — 봉투 {success,data} / {success:false,error}, 항상 Cache-Control: no-store. 다른 모듈(middleware 포함)이 같이 쓴다. */

export const NO_STORE_HEADERS: Readonly<Record<string, string>> = { "Cache-Control": "no-store" };

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE_HEADERS, ...extraHeaders },
  });
}

export function errorResponse(status: number, code: string, extra: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse({ success: false, error: { code, ...extra } }, status, extraHeaders);
}

export function unauthorizedResponse(): Response {
  return errorResponse(401, "unauthorized");
}
