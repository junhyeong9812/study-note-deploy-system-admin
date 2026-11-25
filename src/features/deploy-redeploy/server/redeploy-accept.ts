/** 재배포 접수의 서버 쪽 진입(POST /api/deploys/redeploy) — 어드민에서 운영을 바꾸는 유일한 경로.
 * 순서(앞 단계가 거절하면 뒤 단계의 호출이 없다):
 *   출처(로그인과 같은 isAllowedOrigin — 403 JSON) → 세션(requireApiSession — 401 JSON) → 속도 제한(계정당 60초에 5번 — 세션을 통과한 POST 마다)
 *   → 입력의 꼴(urlencoded · 4KB · 칸마다 하나) → 계정 이름(requested_by 로 쓸 수 있는가) → 확인 값(서명 · 5분)
 *   → 비밀번호(로그인 흐름 — 잠금 판정 · 시도 기록 · 관측 서버 장애 때의 임시 제한이 로그인과 같다. 세션 쿠키는 놓지 않는다)
 *   → 이력 재확인(그 서비스의 성공한 버전인가) → master 접수 한 번(다시 보내지 않는다).
 * 확인 값이 틀리면 비밀번호를 확인하지 않는다 — 잠금 횟수가 늘지 않는다.
 * 응답: 접수됨(새 · duplicate) 303 → 배포 이력의 그 배포 상세 / 그 밖의 실패는 HTML(no-store — 스크립트 없음).
 * 접수 여부를 모르면(10초) 504 와 같은 확인 값의 다시 보내기 폼 — 새 요청 ID 를 만들지 않는다(master 의 멱등 접수가 같은 배포로 답한다).
 * 로그: 접수 한 건에 한 줄 `redeploy:<결과> service=… commit=<7자> account=…` — 비밀번호 · 확인 값 · 비밀값 · 해시는 로그 · 응답 · 주소 어디에도 없다. */
import "server-only";
import { clientIpOrUnknown } from "@/features/auth/lib/client-ip";
import { LOGIN_PASSWORD_MAX_LENGTH } from "@/features/auth/lib/login-body";
import { isAllowedOrigin } from "@/features/auth/lib/origin";
import { createRateLimiter } from "@/features/auth/lib/rate-limit";
import { loginService } from "@/features/auth/server/login-service";
import { requireApiSession } from "@/features/auth/server/require-session";
import { createDeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import { isSameCommit } from "@/features/deploy-detail/lib/deploy-range";
import { createRedeployAcceptClient, type RedeployAcceptResult } from "@/features/deploy-redeploy/lib/redeploy-accept-client";
import { REDEPLOY_CONFIRMATION_MAX_LENGTH, verifyRedeployConfirmation } from "@/features/deploy-redeploy/lib/redeploy-confirmation";
import {
  REDEPLOY_ACCEPT_ACTION, parseRedeployPreviewQuery, redeployPreviewHref, type RedeployPreviewQuery,
} from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import { requestedByFor } from "@/features/deploy-redeploy/lib/redeploy-requester";
import { buildDeployVersionList } from "@/features/deploy-versions/lib/deploy-versions-view";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import { DEPLOY_HISTORY_DEFAULT_LIMIT } from "@/features/deploys/lib/deploy-history-query";
import { deploysHref } from "@/features/deploys/ui/deploys-address";
import { readServerConfig, sessionSigningKey } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { NO_STORE_HEADERS, errorResponse } from "@/shared/lib/responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";

/** 계정당 60초(미끄러지는 창) 안의 접수 시도 상한 — 세션을 통과한 POST 마다 센다. */
export const REDEPLOY_RATE_LIMIT_PER_MINUTE = 5;
/** 본문(application/x-www-form-urlencoded) 상한. */
export const REDEPLOY_BODY_MAX_BYTES = 4_096;

const RATE_LIMIT_WINDOW_MILLISECONDS = 60_000;
const COMMIT_PREFIX_LENGTH = 7;

// 단순화: 속도 제한은 이 프로세스의 메모리에서 센다 — 두 자리(blue · green)가 함께 받으면 계정당 상한이 자리 수만큼 늘고, 다시 뜨면 0 부터다.
// 자리 사이에 같은 상한이 필요해지면 관측 서버처럼 한곳에서 세는 저장소로 옮긴다.
const accountRateLimiter = createRateLimiter({ clock: () => Date.now(), limit: REDEPLOY_RATE_LIMIT_PER_MINUTE, windowMilliseconds: RATE_LIMIT_WINDOW_MILLISECONDS });

/** 본문의 네 칸(꼴을 본 뒤). */
interface AcceptForm {
  query: RedeployPreviewQuery;
  confirmation: string;
  password: string;
}

/** 로그 한 줄의 앞쪽(누가 · 어느 서비스 · 어느 커밋) — 값을 아는 만큼. */
interface LogSubject {
  account: string;
  service: string | null;
  commitSha: string | null;
  requestId: string | null;
}

function logOutcome(subject: LogSubject, outcome: string, level: "info" | "warning" = "warning") {
  const commit = subject.commitSha === null ? "-" : subject.commitSha.slice(0, COMMIT_PREFIX_LENGTH);
  void log(subject.requestId ?? "redeploy", `redeploy:${outcome} service=${subject.service ?? "-"} commit=${commit} account=${subject.account}`, level);
}

// ---- 본문 ----

/** 상한 안에서 본문 바이트를 모은다. 넘으면 null(더 읽지 않고 스트림을 끊는다).
 * 단순화: 읽기의 시간 기한은 두지 않는다 — 앞의 nginx 가 본문을 받아 넘긴다. 어드민을 nginx 없이 열게 되면 로그인 본문처럼 기한을 둔다. */
async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > REDEPLOY_BODY_MAX_BYTES) {
        reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    reader.cancel().catch(() => undefined);
    return null;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** urlencoded 본문의 네 칸 — 칸마다 정확히 하나. service · commit 은 확인 화면의 주소와 같은 검증(parseRedeployPreviewQuery). 아니면 null. */
async function readAcceptForm(request: Request): Promise<AcceptForm | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    request.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await readBoundedBody(request);
  if (bytes === null) return null;
  let fields: URLSearchParams;
  try {
    fields = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const single = (name: string): string | null => {
    const values = fields.getAll(name);
    return values.length === 1 ? values[0] : null;
  };
  const service = single("service");
  const commit = single("commit");
  const confirmation = single("confirmation");
  const password = single("password");
  if (service === null || commit === null || confirmation === null || password === null) return null;
  const parsed = parseRedeployPreviewQuery({ service, commit });
  if (!parsed.ok) return null;
  if (confirmation.length === 0 || confirmation.length > REDEPLOY_CONFIRMATION_MAX_LENGTH) return null;
  if (password.length === 0 || password.length > LOGIN_PASSWORD_MAX_LENGTH) return null;
  return { query: parsed.query, confirmation, password };
}

// ---- HTML ----

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

/** 실패 화면 — 서버에서 그린 최소한의 HTML(스크립트 없음). query 를 알면 확인 화면과 그 서비스의 배포 이력으로, 모르면 배포 이력으로 돌아가는 링크. */
export function failurePage(status: number, title: string, detail: string, query: RedeployPreviewQuery | null, extraHtml = ""): Response {
  const links = query === null
    ? `<a href="${escapeHtml(deploysHref({ service: null, limit: DEPLOY_HISTORY_DEFAULT_LIMIT }))}">배포 이력</a>`
    : `<a href="${escapeHtml(redeployPreviewHref(query.service, query.commitSha))}">확인 화면으로 돌아가기</a>`
      + ` · <a href="${escapeHtml(deploysHref({ service: query.service, limit: DEPLOY_HISTORY_DEFAULT_LIMIT }))}">배포 이력</a>`;
  const html = "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    + "<title>재배포 접수 · study-note 어드민</title></head>"
    + "<body style=\"font-family: system-ui, sans-serif; line-height: 1.6; margin: 0;\"><main style=\"max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem;\">"
    + `<h1 style="font-size: 1.25rem;">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>${extraHtml}<p>${links}</p>`
    + "</main></body></html>";
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS } });
}

/** 접수 여부 모름 — 같은 확인 값(같은 요청 ID)으로 다시 내는 폼. 받은 값은 속성 값으로 이스케이프한다. */
export function retryFormHtml(form: AcceptForm): string {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<form method="post" action="${REDEPLOY_ACCEPT_ACTION}">`
    + hidden("service", form.query.service) + hidden("commit", form.query.commitSha) + hidden("confirmation", form.confirmation)
    + "<p><label for=\"redeploy-password\">비밀번호</label> "
    + "<input id=\"redeploy-password\" type=\"password\" name=\"password\" autocomplete=\"current-password\" required></p>"
    + `<p><button type="submit">${escapeHtml(`같은 접수를 다시 보내기(${form.query.service} 를 ${form.query.commitSha.slice(0, COMMIT_PREFIX_LENGTH)} 로)`)}</button></p>`
    + "</form>";
}

/** master 의 답 → 응답. */
function responseForAccept(result: RedeployAcceptResult, form: AcceptForm, subject: LogSubject): Response {
  const { query } = form;
  switch (result.kind) {
    case "accepted":
      logOutcome({ ...subject, requestId: result.requestId }, result.duplicate ? "duplicate" : "accepted", "info");
      return new Response(null, {
        status: 303,
        headers: { Location: deploysHref({ service: query.service, limit: DEPLOY_HISTORY_DEFAULT_LIMIT }, { requestId: result.requestId, service: query.service }), ...NO_STORE_HEADERS },
      });
    case "in_progress":
      logOutcome(subject, "in_progress");
      return failurePage(409, "그 서비스의 배포가 진행 중입니다", "진행 중인 배포가 끝난 뒤에 확인 화면을 다시 열어 주세요.", query);
    case "request_id_conflict":
      logOutcome(subject, "request_id_conflict");
      return failurePage(409, "확인 화면을 다시 열어 주세요", "이 접수 번호는 다른 배포에 이미 쓰였습니다. 확인 화면을 다시 열면 새 번호로 접수합니다.", query);
    case "rejected":
      logOutcome(subject, `rejected code=${result.code}`);
      return failurePage(502, "배포 서버가 이 접수를 받지 않았습니다",
        result.code === "unauthorized" ? "배포 서버가 어드민의 접수 비밀값을 받지 않았습니다. 설정을 확인하세요." : "배포 서버가 접수의 내용을 받지 않았습니다. 배포 서버의 판과 어드민의 판이 맞는지 확인하세요.",
        query);
    case "not_accepted":
      logOutcome(subject, `not_accepted${result.status !== undefined ? ` status=${result.status}` : ""}`);
      return failurePage(502, "접수하지 못함",
        `배포 서버에 닿지 않았거나 서버가 오류로 답했습니다${result.status !== undefined ? ` (HTTP ${result.status})` : ""}. 접수되지 않았습니다.`, query);
    case "unknown":
      logOutcome(subject, "unknown");
      return failurePage(504, "접수됐는지 확인하지 못했습니다",
        "배포 서버가 10초 안에 답하지 않았습니다. 배포 이력에서 이 배포가 보이는지 먼저 확인하세요. 보이지 않으면 아래 폼으로 같은 접수를 다시 보낼 수 있습니다(같은 접수 번호라 두 번 배포되지 않습니다).",
        query, retryFormHtml(form));
  }
}

export async function redeployAcceptResponse(request: Request): Promise<Response> {
  const config = readServerConfig();
  const allowedAccount = requestedByFor(config.adminUser) !== null;
  const subject: LogSubject = { account: allowedAccount ? config.adminUser : "(not_allowed)", service: null, commitSha: null, requestId: null };

  // 1 출처 — 로그인 · 로그아웃과 같은 검사(Referer 로 갈음하지 않는다)
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
  // 3 속도 제한 — 계정당
  if (!accountRateLimiter.hit(config.adminUser).allowed) {
    logOutcome(subject, "rate_limited");
    return failurePage(429, "접수 시도가 너무 잦습니다", "잠시 뒤 다시 시도하세요(1분에 5번까지).", null);
  }
  // 4 입력의 꼴
  const form = await readAcceptForm(request);
  if (form === null) {
    logOutcome(subject, "malformed");
    return failurePage(400, "요청의 꼴이 맞지 않습니다", "확인 화면의 폼으로만 접수할 수 있습니다. 확인 화면을 다시 열어 주세요.", null);
  }
  subject.service = form.query.service;
  subject.commitSha = form.query.commitSha;
  // 5 계정 이름 — requested_by 로 쓸 수 없으면 master 를 부르지 않는다
  const requestedBy = requestedByFor(config.adminUser);
  if (requestedBy === null) {
    logOutcome(subject, "account_not_allowed");
    return failurePage(422, "이 계정 이름으로는 배포를 일으킬 수 없습니다", "접수에 남기는 이름(admin:계정)은 영문 · 숫자 · . _ - 만 받습니다. 계정 이름(ADMIN_USER)을 바꾼 뒤 다시 접수하세요.", form.query);
  }
  // 6 확인 값 — 틀리면 비밀번호를 확인하지 않는다
  const check = verifyRedeployConfirmation(form.confirmation, sessionSigningKey(),
    { service: form.query.service, commitSha: form.query.commitSha, account: config.adminUser }, Date.now());
  if (!check.ok) {
    logOutcome(subject, `confirmation_${check.reason}`);
    if (check.reason === "expired") return failurePage(410, "확인 화면을 다시 열어 주세요", "확인 화면은 연 뒤 5분 동안만 쓸 수 있습니다.", form.query);
    return failurePage(400, "확인 값이 맞지 않습니다", "확인 화면에서 고른 서비스 · 커밋과 다르거나 값이 바뀌었습니다. 확인 화면을 다시 열어 주세요.", form.query);
  }
  subject.requestId = check.requestId;
  // 7 비밀번호 — 로그인 흐름 그대로(잠금 판정 · 시도 기록 · 임시 제한). 흐름이 만든 세션 토큰은 쓰지 않는다(쿠키를 놓지 않는다).
  const { flow } = loginService();
  if (flow === null) {
    logOutcome(subject, "password_unavailable");
    return failurePage(401, "비밀번호를 확인할 수 없습니다", "로그인 설정이 없어 비밀번호를 확인하지 못했습니다.", form.query);
  }
  const login = await flow.login({
    id: config.adminUser, password: form.password, ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get("user-agent") ?? "", origin: request.headers.get("origin"), requestId: check.requestId,
  });
  if (login.kind !== "success") {
    logOutcome(subject, `password_${login.kind}`);
    if (login.kind === "locked") return failurePage(423, "잠겨 있습니다", "비밀번호를 여러 번 틀려 잠겼습니다. 로그인과 같은 잠금입니다 — 풀린 뒤에 다시 접수하세요.", form.query);
    if (login.kind === "rate_limited") return failurePage(429, "비밀번호 확인이 너무 잦습니다", "잠시 뒤 다시 시도하세요.", form.query);
    return failurePage(401, "비밀번호가 맞지 않습니다", "로그인 비밀번호를 다시 넣어 주세요. 틀린 입력은 로그인의 잠금 횟수에 듭니다.", form.query);
  }
  // 8 이력 재확인 — 그 서비스의 성공한 버전인가
  if (!isHttpBaseUrl(config.deployMasterUrl) || config.deploySecret.length === 0) {
    logOutcome(subject, "history_not_configured");
    return failurePage(502, "배포 이력을 확인하지 못해 접수하지 않았습니다", "배포 서버 설정이 없습니다.", form.query);
  }
  const masterOptions = { baseUrl: config.deployMasterUrl, secret: config.deploySecret, fetch: (input: string, init: RequestInit) => fetch(input, init) };
  const list = await buildDeployVersionList({ deployHistory: createDeployHistoryClient(masterOptions), deployGit: createDeployGitClient(masterOptions) }, form.query.service);
  if (!list.ok) {
    logOutcome(subject, `history_unavailable upstream=${list.reason}`);
    return failurePage(502, "배포 이력을 확인하지 못해 접수하지 않았습니다", `배포 서버: ${list.message}`, form.query);
  }
  if (!list.value.versions.some((version) => isSameCommit(version.commitSha, form.query.commitSha))) {
    logOutcome(subject, "not_deployable");
    return failurePage(409, "배포된 적 없는 버전은 고를 수 없습니다", "이 커밋은 그 서비스의 성공한 배포 이력(최근 200건)에 없습니다.", form.query);
  }
  // 9 master 접수 한 번
  const result = await createRedeployAcceptClient(masterOptions).accept({
    service: form.query.service, commitSha: form.query.commitSha, requestId: check.requestId, requestedBy,
  });
  return responseForAccept(result, form, subject);
}
