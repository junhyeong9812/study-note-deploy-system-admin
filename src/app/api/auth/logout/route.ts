/** POST /api/auth/logout — 같은 출처 · 세션 필요. 쿠키를 지운다(발급과 같은 이름 · 경로). */
import { isAllowedOrigin } from "@/features/auth/lib/origin";
import { buildClearedSessionCookieHeader } from "@/features/auth/lib/session";
import { requireApiSession } from "@/features/auth/server/require-session";
import { readServerConfig } from "@/shared/config/server-config";
import { errorResponse, jsonResponse } from "@/shared/lib/responses";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAllowedOrigin(request.headers.get("origin"), readServerConfig().adminOrigin)) return errorResponse(403, "origin_rejected");
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  return jsonResponse({ success: true, data: {} }, 200, { "Set-Cookie": buildClearedSessionCookieHeader() });
}
