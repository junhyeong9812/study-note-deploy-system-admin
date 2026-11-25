/** 상한 바꾸기의 서버 쪽 진입(POST /api/claude-usage/limits) — 폼은 스크립트 없이 보낸다(urlencoded).
 * route 안의 차례(앞 단계가 거절하면 뒤 단계의 호출이 없다 — 배포된 서버에서는 세션이 없으면 middleware 가 이보다 먼저 401):
 *   출처(isAllowedOrigin — 403 JSON origin_rejected) → 세션(requireApiSession — 401 JSON)
 *   → 본문의 꼴(Content-Type 이 정확히 urlencoded · 4KB · UTF-8 — 아니면 400 HTML, 실행 자리를 부르지 않는다)
 *   → 계정 이름(changed_by = requestedByFor(ADMIN_USER) — null 이면 422 HTML)
 *   → 설정(CLAUDE_RUNNER_URL · CLAUDE_RUNNER_SETTINGS_SECRET — 없으면 503 HTML)
 *   → 지금 상한을 서버가 다시 읽는다(GET /limits 한 번) — 읽지 못하면 바꾸지 않는다: 503 HTML "지금 상한을 읽지 못해 바꿀 수 없습니다"
 *     (용도를 모르면 PUT 의 몸을 만들 수 없다 — 닫힌 쪽. 로그인 흐름 · PUT 0)
 *   → 폼의 칸(parseClaudeLimitsForm(칸, 지금 상한의 용도) — malformed 400 HTML / invalid_value 422 HTML. 로그인 흐름 · PUT 0)
 *   → 올림이면(isRaisingChange(지금, 바꿀 값)) 비밀번호 재확인: 비었으면 401 HTML(로그인 흐름 · 실행 자리 PUT 0), 있으면 재배포 접수와 같은 로그인 흐름
 *     (틀림 401 · 잠김 423 · 잦음 429 — 세션 쿠키를 놓지 않는다). 올림이 아니면 비밀번호를 보지 않는다(로그인 흐름 0)
 *   → 실행 자리 PUT /limits 한 번(다시 보내지 않는다).
 * 응답(HTML · no-store · 스크립트 없음): 바뀜 200(실행 자리가 돌려준 값) · 실행 자리의 거절 422(code) · 실행 자리가 설정 비밀값 거절 502 ·
 *   바뀌지 않음 502(연결을 맺지 못했을 때만) · 모름 504(5xx 포함)("다시 읽어 확인"). 로그: 한 번에 한 줄 `claude-limits:<결과> account=<계정> raise=<true|false|->`
 *   (올림인지 아직 모르는 단계의 거절은 `-`). 비밀번호 · 비밀값 · 실행 자리의 주소 · 상한 값은 로그 · 응답에 싣지 않는다. */
import "server-only";
import { randomUUID } from "node:crypto";
import { clientIpOrUnknown } from "@/features/auth/lib/client-ip";
import { isAllowedOrigin } from "@/features/auth/lib/origin";
import { loginService } from "@/features/auth/server/login-service";
import { requireApiSession } from "@/features/auth/server/require-session";
import {
  CLAUDE_LIMIT_MAXIMUM, CLAUDE_LIMIT_MINIMUM, CLAUDE_USAGE_PATH, claudePurposeTitle, isRaisingChange, parseClaudeLimitsForm, type ClaudeLimits,
} from "@/features/claude-usage/lib/claude-limits";
import { createClaudeRunnerClient, type ClaudeLimitsReplaceResult } from "@/features/claude-usage/lib/claude-runner-client";
import { requestedByFor } from "@/features/deploy-redeploy/lib/redeploy-requester";
import { escapeHtml, readBoundedBody } from "@/features/deploy-redeploy/server/redeploy-accept";
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { NO_STORE_HEADERS, errorResponse } from "@/shared/lib/responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";

/** 본문(application/x-www-form-urlencoded) 상한. */
export const CLAUDE_LIMITS_BODY_MAX_BYTES = 4_096;
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

/** 로그 한 줄의 앞쪽 — 누가 · 올림인지(모르면 null). */
interface LogSubject {
  requestId: string;
  account: string;
  raise: boolean | null;
}

function logOutcome(subject: LogSubject, outcome: string, level: "info" | "warning" = "warning") {
  const raise = subject.raise === null ? "-" : String(subject.raise);
  void log(subject.requestId, `claude-limits:${outcome} account=${subject.account} raise=${raise}`, level);
}

/** 매체 종류가 정확히 urlencoded(뒤의 ; 매개변수는 허용 · 접두 일치는 거절)이고 4KB · UTF-8 안이면 그 칸, 아니면 null. */
async function readLimitsFields(request: Request): Promise<URLSearchParams | null> {
  if ((request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() !== FORM_MEDIA_TYPE) {
    request.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await readBoundedBody(request, CLAUDE_LIMITS_BODY_MAX_BYTES);
  if (bytes === null) return null;
  try {
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/** 결과 화면 — 서버에서 그린 최소한의 HTML(스크립트 없음) · 화면으로 돌아가는 링크. */
function resultPage(status: number, title: string, detail: string, extraHtml = ""): Response {
  const html = "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    + "<title>Claude 상한 · study-note 어드민</title></head>"
    + "<body style=\"font-family: system-ui, sans-serif; line-height: 1.6; margin: 0;\"><main style=\"max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem;\">"
    + `<h1 style="font-size: 1.25rem;">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>${extraHtml}`
    + `<p><a href="${escapeHtml(CLAUDE_USAGE_PATH)}">Claude 사용량 화면으로 돌아가기</a></p>`
    + "</main></body></html>";
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS } });
}

/** 바뀐 값(실행 자리가 돌려준 것)의 표 · 켬/끔 · 바꾼 사람 · 시각. */
function replacedLimitsHtml(limits: ClaudeLimits): string {
  const row = (title: string, perDay: number, perHour: number) =>
    `<tr><th scope="row">${escapeHtml(title)}</th><td>${perDay}</td><td>${perHour}</td></tr>`;
  const rows = [row("전체", limits.total.perDay, limits.total.perHour),
    ...Object.entries(limits.purposes).map(([name, pair]) => row(claudePurposeTitle(name), pair.perDay, pair.perHour))];
  const changed = `바꾼 사람 ${limits.changedBy ?? "—"} · ${limits.changedAt === null ? "—" : formatKoreanTime(limits.changedAt)}`;
  return `<p>${limits.enabled ? "켜짐" : "꺼짐"}</p>`
    + `<table><thead><tr><th scope="col">범위</th><th scope="col">하루</th><th scope="col">한 시간</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
    + `<p>${escapeHtml(changed)}</p>`;
}

/** 실행 자리 PUT 의 답 → 응답. */
function responseForReplace(result: ClaudeLimitsReplaceResult, subject: LogSubject): Response {
  switch (result.kind) {
    case "replaced":
      logOutcome(subject, "replaced", "info");
      return resultPage(200, "상한을 바꿨습니다", "실행 자리가 돌려준 지금 값입니다.", replacedLimitsHtml(result.limits));
    case "rejected":
      logOutcome(subject, `rejected code=${result.code}`);
      if (result.code === "unauthorized") {
        return resultPage(502, "바꾸지 못했습니다", "실행 자리가 어드민의 설정 비밀값을 받지 않았습니다. 설정을 확인하세요.");
      }
      return resultPage(422, "바꾸지 못했습니다", `실행 자리가 값을 거절했습니다 (${result.code}). 실행 자리의 판과 어드민의 판이 맞는지 확인하세요.`);
    case "not_replaced":
      logOutcome(subject, "not_replaced");
      return resultPage(502, "바꾸지 못했습니다 — 바뀌지 않았습니다", "실행 자리에 연결하지 못했습니다(요청이 나가지 않았습니다).");
    case "unknown":
      logOutcome(subject, `unknown${result.status !== undefined ? ` status=${result.status}` : ""}`);
      return resultPage(504, "바뀌었는지 모릅니다 — 다시 읽어 확인하세요",
        `실행 자리의 답을 받지 못했거나 실행 자리가 오류로 답했습니다${result.status !== undefined ? ` (HTTP ${result.status})` : ""}. 오류여도 값은 바뀌었을 수 있습니다. 같은 요청을 다시 보내지 않았습니다 — 화면을 다시 열어 지금 상한을 확인하세요.`);
  }
}

export async function claudeLimitsChangeResponse(request: Request): Promise<Response> {
  const config = readServerConfig();
  const changedBy = requestedByFor(config.adminUser);
  const subject: LogSubject = { requestId: randomUUID(), account: changedBy !== null ? config.adminUser : "(not_allowed)", raise: null };

  // 1 출처 — 로그인 · 재배포 접수와 같은 검사
  if (!isAllowedOrigin(request.headers.get("origin"), config.adminOrigin)) {
    logOutcome(subject, "origin_rejected");
    return errorResponse(403, "origin_rejected");
  }
  // 2 세션
  const session = await requireApiSession();
  if (session instanceof Response) {
    logOutcome(subject, "unauthenticated");
    return session;
  }
  // 3 본문의 꼴 — 칸의 목록은 지금 상한을 읽은 뒤에 가른다
  const fields = await readLimitsFields(request);
  if (fields === null) {
    logOutcome(subject, "malformed");
    return resultPage(400, "요청의 꼴이 맞지 않습니다", "Claude 사용량 화면의 폼으로만 바꿀 수 있습니다. 화면을 다시 열어 주세요.");
  }
  // 4 계정 이름 — changed_by 로 쓸 수 없으면 실행 자리를 부르지 않는다
  if (changedBy === null) {
    logOutcome(subject, "account_not_allowed");
    return resultPage(422, "이 계정 이름으로는 상한을 바꿀 수 없습니다", "바꾼 사람으로 남기는 이름(admin:계정)은 영문 · 숫자 · . _ - 만 받습니다. 계정 이름(ADMIN_USER)을 바꾼 뒤 다시 시도하세요.");
  }
  // 5 설정
  if (!isHttpBaseUrl(config.claudeRunnerUrl) || config.claudeRunnerSettingsSecret.length === 0) {
    logOutcome(subject, "not_configured");
    return resultPage(503, "실행 자리 설정이 없습니다", "어드민 서버에 Claude 실행 자리의 주소와 설정용 비밀값이 없어 바꿀 수 없습니다.");
  }
  // 6 지금 상한을 서버가 다시 읽는다 — 읽지 못하면 바꾸지 않는다
  const client = createClaudeRunnerClient({
    baseUrl: config.claudeRunnerUrl, settingsSecret: config.claudeRunnerSettingsSecret, fetch: (input, init) => fetch(input, init),
  });
  const current = await client.readLimits();
  if (!current.ok) {
    logOutcome(subject, `limits_unreadable upstream=${current.reason}`);
    return resultPage(503, "지금 상한을 읽지 못해 바꿀 수 없습니다", `실행 자리: ${current.message}. 바꾸지 않았습니다.`);
  }
  // 7 폼의 칸 — 닫힌 목록은 지금 상한의 용도에서
  const form = parseClaudeLimitsForm(fields, Object.keys(current.value.purposes));
  if (!form.ok) {
    logOutcome(subject, form.reason === "invalid_value" ? `invalid_value field=${form.field}` : "malformed");
    if (form.reason === "invalid_value") {
      return resultPage(422, "상한 값이 맞지 않습니다", `${form.field} — 상한은 ${CLAUDE_LIMIT_MINIMUM}~${CLAUDE_LIMIT_MAXIMUM} 의 정수입니다.`);
    }
    return resultPage(400, "요청의 꼴이 맞지 않습니다", "화면을 연 뒤 실행 자리의 용도가 바뀌었을 수 있습니다. 화면을 다시 열어 주세요.");
  }
  // 8 올림이면 비밀번호 재확인 — 로그인 흐름 그대로(잠금 판정 · 시도 기록 · 임시 제한). 흐름이 만든 세션 토큰은 쓰지 않는다(쿠키를 놓지 않는다).
  subject.raise = isRaisingChange(current.value, form.change);
  if (subject.raise) {
    if (form.password.length === 0) {
      logOutcome(subject, "password_required");
      return resultPage(401, "비밀번호를 다시 넣어야 합니다", "상한을 올리거나 꺼 둔 것을 켤 때는 로그인 비밀번호를 다시 확인합니다. 화면으로 돌아가 비밀번호를 함께 넣어 주세요.");
    }
    const { flow } = loginService();
    if (flow === null) {
      logOutcome(subject, "password_unavailable");
      return resultPage(401, "비밀번호를 확인할 수 없습니다", "로그인 설정이 없어 비밀번호를 확인하지 못했습니다.");
    }
    const login = await flow.login({
      id: config.adminUser, password: form.password, ip: clientIpOrUnknown(request.headers),
      userAgent: request.headers.get("user-agent") ?? "", origin: request.headers.get("origin"), requestId: subject.requestId,
    });
    if (login.kind !== "success") {
      logOutcome(subject, `password_${login.kind}`);
      if (login.kind === "locked") return resultPage(423, "잠겨 있습니다", "비밀번호를 여러 번 틀려 잠겼습니다. 로그인과 같은 잠금입니다 — 풀린 뒤에 다시 시도하세요.");
      if (login.kind === "rate_limited") return resultPage(429, "비밀번호 확인이 너무 잦습니다", "잠시 뒤 다시 시도하세요.");
      return resultPage(401, "비밀번호가 맞지 않습니다", "로그인 비밀번호를 다시 넣어 주세요. 틀린 입력은 로그인의 잠금 횟수에 듭니다.");
    }
  }
  // 9 실행 자리 PUT 한 번(다시 보내지 않는다)
  return responseForReplace(await client.replaceLimits(form.change, changedBy), subject);
}
