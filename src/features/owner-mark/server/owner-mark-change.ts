/** 주인 표시를 심고 지우는 서버 쪽 진입 — POST /api/owner-mark(심기) · POST /api/owner-mark/clear(지우기). 폼은 스크립트 없이 보낸다.
 * 차례(앞 단계가 거절하면 뒤 단계가 없다 — 배포된 서버에서는 세션이 없으면 middleware 가 먼저 401):
 *   출처(isAllowedOrigin — 403 JSON origin_rejected) → 세션(requireApiSession — 401 JSON) → 속도 제한(계정당 60초에 5번 · 심기와 지우기를 함께 센다 — 429 HTML)
 *   → 설정(checkOwnerMarkSettings — 심기는 ok 일 때만, 지우기는 clearableDomain 이 있을 때만. 아니면 503 HTML "설정 없음" + 문제의 이름 · Set-Cookie 없음)
 *   → 심기: 값 = ownerMarkValue(열쇠, Date.now()) · Set-Cookie = buildOwnerMarkCookieHeader(값, 도메인) / 지우기: buildClearedOwnerMarkCookieHeader(도메인)
 *   → 303 Location `/owner-mark` · Cache-Control: no-store · 몸 없음.
 * 요청의 몸 · 질의 · 머리(Host 포함)의 글자는 보지 않는다 — 도메인 · 시각 · 값은 설정과 서버의 시계에서만.
 * 로그: 한 번에 한 줄 `owner-mark:<결과> action=<set|clear> account=<계정>` — 결과 = set · cleared · origin_rejected · unauthenticated · rate_limited
 *   · not_configured(뒤에 ` problems=<낱말,…>`). 쿠키의 값 · 서명 · 열쇠는 로그 · 응답에 없다. 줄의 ID 자리는 그 요청의 추적 ID(⑬ T2g — 그 범위에서 돈다).
 */
import "server-only";
import { isAllowedOrigin } from "@/features/auth/lib/origin";
import { createRateLimiter } from "@/features/auth/lib/rate-limit";
import { requireApiSession } from "@/features/auth/server/require-session";
import { requestedByFor } from "@/features/deploy-redeploy/lib/redeploy-requester";
import { escapeHtml } from "@/features/deploy-redeploy/server/redeploy-accept";
import {
  OWNER_MARK_PROBLEM_SETTING_NAMES, buildClearedOwnerMarkCookieHeader, buildOwnerMarkCookieHeader, checkOwnerMarkSettings, ownerMarkValue,
} from "@/features/owner-mark/lib/owner-mark";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { inRequestScope } from "@/shared/lib/request-id";
import { currentRequestId } from "@/shared/lib/request-scope";
import { NO_STORE_HEADERS, errorResponse } from "@/shared/lib/responses";

/** 계정당 60초(미끄러지는 창) 안의 시도 상한 — 심기와 지우기를 함께 센다. */
export const OWNER_MARK_RATE_LIMIT_PER_MINUTE = 5;

const OWNER_MARK_PATH = "/owner-mark";
const RATE_LIMIT_WINDOW_MILLISECONDS = 60_000;

// 단순화: 속도 제한은 이 프로세스의 메모리에서 센다 — 두 자리(blue · green)가 함께 받으면 계정당 상한이 자리 수만큼 늘고, 다시 뜨면 0 부터다(재배포 접수와 같다).
const accountRateLimiter = createRateLimiter({
  clock: () => Date.now(), limit: OWNER_MARK_RATE_LIMIT_PER_MINUTE, windowMilliseconds: RATE_LIMIT_WINDOW_MILLISECONDS,
});

type OwnerMarkAction = "set" | "clear";

function logOutcome(account: string, action: OwnerMarkAction, outcome: string, suffix = "", level: "info" | "warning" = "warning") {
  void log(currentRequestId(), `owner-mark:${outcome} action=${action} account=${account}${suffix}`, level);
}

/** 거절 화면 — 서버에서 그린 최소한의 HTML(스크립트 없음) · 화면으로 돌아가는 링크. */
function failurePage(status: number, title: string, detail: string): Response {
  const html = "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    + "<title>주인 표시 · study-note 어드민</title></head>"
    + "<body style=\"font-family: system-ui, sans-serif; line-height: 1.6; margin: 0;\"><main style=\"max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem;\">"
    + `<h1 style="font-size: 1.25rem;">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`
    + `<p><a href="${OWNER_MARK_PATH}">주인 표시 화면으로 돌아가기</a></p>`
    + "</main></body></html>";
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS } });
}

/** 심기 · 지우기의 공통 차례 — 출처 → 세션 → 속도 제한 → 설정 → Set-Cookie + 303. 요청의 몸 · 질의 · 머리의 글자는 보지 않는다. */
async function ownerMarkChangeResponse(request: Request, action: OwnerMarkAction): Promise<Response> {
  return inRequestScope(async () => {
    const config = readServerConfig();
    const account = requestedByFor(config.adminUser) !== null ? config.adminUser : "(not_allowed)";
    if (!isAllowedOrigin(request.headers.get("origin"), config.adminOrigin)) {
      logOutcome(account, action, "origin_rejected");
      return errorResponse(403, "origin_rejected");
    }
    const session = await requireApiSession();
    if (session instanceof Response) {
      logOutcome(account, action, "unauthenticated");
      return session;
    }
    if (!accountRateLimiter.hit(config.adminUser).allowed) {
      logOutcome(account, action, "rate_limited");
      return failurePage(429, "주인 표시를 너무 자주 바꿨습니다", `잠시 뒤 다시 시도하세요(1분에 ${OWNER_MARK_RATE_LIMIT_PER_MINUTE}번까지 — 표시하기와 지우기를 함께 셉니다).`);
    }
    const settings = checkOwnerMarkSettings({ secret: config.ownerCookieSecret, domain: config.ownerCookieDomain, adminOrigin: config.adminOrigin });
    const domain = settings.ok ? settings.domain : action === "clear" ? settings.clearableDomain : null;
    if (domain === null) {
      const problems = settings.ok ? [] : settings.problems;
      logOutcome(account, action, "not_configured", ` problems=${problems.join(",")}`);
      const names = [...new Set(problems.flatMap((problem) => OWNER_MARK_PROBLEM_SETTING_NAMES[problem]))];
      return failurePage(503, "설정 없음", `주인 표시의 설정을 쓸 수 없어 ${action === "set" ? "표시하지" : "지우지"} 않았습니다 — 확인할 설정: ${names.join(" · ")}.`);
    }
    const setCookie = action === "set"
      ? buildOwnerMarkCookieHeader(ownerMarkValue(config.ownerCookieSecret, Date.now()), domain)
      : buildClearedOwnerMarkCookieHeader(domain);
    logOutcome(account, action, action === "set" ? "set" : "cleared", "", "info");
    return new Response(null, { status: 303, headers: { Location: OWNER_MARK_PATH, "Set-Cookie": setCookie, ...NO_STORE_HEADERS } });
  });
}

export async function ownerMarkSetResponse(request: Request): Promise<Response> {
  return ownerMarkChangeResponse(request, "set");
}

export async function ownerMarkClearResponse(request: Request): Promise<Response> {
  return ownerMarkChangeResponse(request, "clear");
}
