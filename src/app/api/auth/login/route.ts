/** POST /api/auth/login — JSON {id, password}(본문 상한 4KB · 기한 3초, login-body). 결과 → 상태 코드 · Set-Cookie · 임시 제한 표시.
 * 응답 본문은 구별 없는 짧은 코드만(ID 틀림 · 비밀번호 틀림 같은 응답). */
import { clientIpOrUnknown } from "@/features/auth/lib/client-ip";
import { readLoginBody } from "@/features/auth/lib/login-body";
import { loginResultStatus, type LoginResult } from "@/features/auth/lib/login-flow";
import { buildSessionCookieHeader } from "@/features/auth/lib/session";
import { loginService } from "@/features/auth/server/login-service";
import { log } from "@/shared/lib/logger";
import { incomingRequestId } from "@/shared/lib/request-id";
import { runWithRequestId } from "@/shared/lib/request-scope";
import { errorResponse, jsonResponse } from "@/shared/lib/responses";

export const dynamic = "force-dynamic";

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
  const requestId = incomingRequestId(request.headers);
  // 관측 서버의 판정 · 알림 서버의 잠금 사건(흐름이 뒤에서 마저 보내는 것까지)이 그 요청의 값을 싣는다
  return runWithRequestId(requestId, async () => {
    const { flow } = loginService();
    if (flow === null) {
      // 정상 구동에서는 닿지 않는다(설정이 없으면 서버가 뜨지 않는다) — 거절만, 관측 서버 기록 없음
      void log(requestId, "login:rejected reason=config_missing", "warning");
      return errorResponse(401, "invalid_credentials", { temporaryRestriction: false });
    }
    // 본문은 여기서 읽지 않는다 — 흐름이 Origin 검사 · 속도 제한 뒤에 readCredentials 를 부른다(상한 4KB · 기한 3초)
    const result = await flow.login({
      id: "",
      password: "",
      readCredentials: () => readLoginBody(request),
      ip: clientIpOrUnknown(request.headers),
      userAgent: request.headers.get("user-agent") ?? "",
      origin: request.headers.get("origin"),
      requestId,
    });
    return resultResponse(result);
  });
}
