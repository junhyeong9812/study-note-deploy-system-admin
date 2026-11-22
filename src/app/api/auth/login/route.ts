/** POST /api/auth/login — JSON {id, password}. 결과 → 상태 코드 · Set-Cookie · 임시 제한 표시.
 * 응답 본문은 구별 없는 짧은 코드만(ID 틀림 · 비밀번호 틀림 같은 응답). */
import { randomUUID } from "node:crypto";
import { clientIpOrUnknown } from "@/features/auth/lib/client-ip";
import { loginResultStatus, type LoginResult } from "@/features/auth/lib/login-flow";
import { buildSessionCookieHeader } from "@/features/auth/lib/session";
import { loginService } from "@/features/auth/server/login-service";
import { log } from "@/shared/lib/logger";
import { errorResponse, jsonResponse } from "@/shared/lib/responses";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_096;
const MAX_ID_LENGTH = 200;
const MAX_PASSWORD_LENGTH = 1_024;   // argon2 에 아주 긴 입력을 넣어 시간을 끌지 못하게

interface LoginBody { id: string; password: string }

async function readLoginBody(request: Request): Promise<LoginBody | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { id, password } = parsed as Record<string, unknown>;
  if (typeof id !== "string" || typeof password !== "string") return null;
  if (id.length > MAX_ID_LENGTH || password.length > MAX_PASSWORD_LENGTH) return null;
  return { id, password };
}

function resultResponse(result: LoginResult): Response {
  const status = loginResultStatus(result);
  switch (result.kind) {
    case "success":
      return jsonResponse({ success: true, data: { temporaryRestriction: result.temporaryRestriction } }, status,
        { "Set-Cookie": buildSessionCookieHeader(result.sessionToken) });
    case "failure":
      return errorResponse(status, "invalid_credentials", { temporaryRestriction: result.temporaryRestriction });
    case "locked":
      return errorResponse(status, "locked", { temporaryRestriction: result.temporaryRestriction });
    case "rate_limited":
      return errorResponse(status, "rate_limited", {}, { "Retry-After": "60" });
    case "origin_rejected":
      return errorResponse(status, "origin_rejected");
    case "malformed":
      return errorResponse(status, "bad_request");
  }
}

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id")?.match(/^[A-Za-z0-9-]{1,64}$/)?.[0] ?? randomUUID();
  const { flow } = loginService();
  if (flow === null) {
    void log(requestId, "login:rejected reason=config_missing", "warning");
    return errorResponse(401, "invalid_credentials", { temporaryRestriction: false });
  }
  // 본문은 여기서 해석만 하고, 판정 순서(Origin → 속도 제한 → 형식)는 흐름이 정한다
  const body = await readLoginBody(request);
  const result = await flow.login({
    id: body?.id ?? "",
    password: body?.password ?? "",
    malformed: body === null,
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get("user-agent") ?? "",
    origin: request.headers.get("origin"),
    requestId,
  });
  return resultResponse(result);
}
