/** 분석의 서버 쪽 진입 — 화면(GET /incidents/analysis) · 보내기(POST /api/incidents/analysis). 명세 ⑫ §19 · §20.
 * 두 걸음: 화면은 저장된 분석만(목록의 네 호출 · Redis 읽기) → `&preview=1` 은 보낼 글 그대로(근거 · 배포 실패면 출력 조회 — 가린 뒤 자른 글)와
 * 그 글의 해시와 그 문제의 "언제부터"에 서명한 값(ap2)을 실은 폼(실행 자리 · Redis 쓰기 없음) → POST 는 **받은 글 그대로**를 보낸다(서명이 맞을 때 — 다시 만들지 않는다).
 * POST 의 차례(앞 단계가 거절하면 뒤 단계의 호출이 없다): 출처(403 JSON) → 세션(401 JSON) → 본문(urlencoded · 1MB · UTF-8 · 칸마다 하나 · 식별자의 꼴 — 400 HTML)
 *   → 서명(꼴 400 · 다름 409 · 지남 409) → 설정(실행 자리 주소 · CLAUDE_RUNNER_SECRET · LOG_REDIS_URL — 503) → 아직 열려 있는가(목록 네 호출 — 409)
 *   → 같은 발생분인가(서명이 묶은 since 와 지금의 since — 다르면 409) → 미리보기를 썼다는 표시(SET NX — 이미 썼으면 409 · 닿지 못하면 503)
 *   → 시작(Redis 에 닿지 못하면 503 · 부르지 않는다) → 303 분석 화면(진행 중이 있으면 새로 부르지 않고 같은 303). 409 · 400 에서는 Redis 에 쓰지 않는다(표시 뒤의 것 밖).
 * 실행 자리는 응답을 돌려준 뒤 이 프로세스가 뒤에서 부른다(서비스는 프로세스에 하나 — globalThis). 응답 · 화면 · 로그에 실행 자리 · 배포 마스터의 주소 · 오류 글이 없다.
 * 두 진입 모두 그 요청의 추적 ID 범위에서 돈다(⑬ T2g) — 알림 · 관측 · 마스터로 가는 호출과 진입의 로그 줄(칸의 실패 · 보내기의 거절)이 그 값.
 * 분석의 진행 줄(started · succeeded · failed …)의 ID 자리는 그 분석의 번호(일의 ID — 실행 자리에 본문으로 보내는 값)다. 실행 자리의 호출에는 추적 ID 를 싣지 않는다. */
import "server-only";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { isAllowedOrigin } from "@/features/auth/lib/origin";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import { escapeHtml, readBoundedBody } from "@/features/deploy-redeploy/server/redeploy-accept";
import { analysisPromptDigest, buildAnalysisPrompt } from "@/features/incident-analysis/lib/analysis-prompt";
import { ANALYSIS_PREVIEW_TOKEN_MAX_LENGTH, issueAnalysisPreviewToken, verifyAnalysisPreviewToken } from "@/features/incident-analysis/lib/analysis-preview-token";
import { createAnalysisRunnerClient } from "@/features/incident-analysis/lib/analysis-runner-client";
import type { AnalysisAction } from "@/features/incident-analysis/lib/analysis-answer";
import { createDeployFailureOutputClient, type DeployFailureOutputResult } from "@/features/incident-analysis/lib/deploy-failure-output-client";
import {
  createIncidentAnalysisService, type AnalysisRedisCommands, type IncidentAnalysisService,
} from "@/features/incident-analysis/lib/incident-analysis-service";
import {
  INCIDENT_ANALYSIS_TEXT, incidentAnalysisHref, parseIncidentAnalysisQuery, type AnalysisHistoryView, type AnalysisIncidentState, type AnalysisPreviewState,
  type IncidentAnalysisScreenOutcome,
} from "@/features/incident-analysis/lib/incident-analysis-screen";
import { isIncidentId } from "@/features/incidents/lib/incident-id";
import { incidentHref } from "@/features/incidents/lib/incidents-query";
import { lookupIncident, type IncidentLookup } from "@/features/incidents/lib/incidents-screen";
import { readServerConfig, sessionSigningKey, type ServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";
import { inRequestScope } from "@/shared/lib/request-id";
import { currentRequestId } from "@/shared/lib/request-scope";
import { NO_STORE_HEADERS, errorResponse } from "@/shared/lib/responses";
import { upstreamFailureLogLine } from "@/shared/lib/screen-responses";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

/** 본문(application/x-www-form-urlencoded) 상한 — 6만 자의 글을 퍼센트 인코딩해도 든다. */
export const INCIDENT_ANALYSIS_BODY_MAX_BYTES = 1024 * 1024;
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";
/** 요청 ID — `adm-` + 무작위(실행 자리의 요청 ID 꼴 [A-Za-z0-9._-]{1,64} 안). */
const REQUEST_ID_RANDOM_BYTES = 18;

// ---- 프로세스에 하나인 서비스 ----

interface AnalysisServiceHolder {
  service: IncidentAnalysisService;
  disconnect: () => void;
}

const SERVICE_KEY = Symbol.for("study-note-admin.incident-analysis-service");
type GlobalWithService = typeof globalThis & { [SERVICE_KEY]?: AnalysisServiceHolder };

/** 분석을 부르고 남기는 데 필요한 설정이 있는가 — 실행 자리 주소 · 호출용 비밀값 · 저장소. */
function analysisConfigured(config: ServerConfig): boolean {
  return isHttpBaseUrl(config.claudeRunnerUrl) && config.claudeRunnerCallSecret.length > 0 && config.logRedisUrl.length > 0;
}

/** ioredis 의 같은 이름 명령으로(어드민이 이미 쓰는 Redis — LOG_REDIS_URL). 닿지 못하면 명령이 거부된다(오래 기다리지 않는다). */
function redisCommands(url: string): { redis: AnalysisRedisCommands; disconnect: () => void } {
  const client = new Redis(url, { connectTimeout: 1_000, commandTimeout: 2_000, maxRetriesPerRequest: 1 });
  client.on("error", () => undefined);   // 연결 오류는 명령의 거부로 드러난다 — 처리하지 않은 이벤트로 프로세스를 흔들지 않는다
  return {
    redis: {
      get: (key) => client.get(key),
      set: (key, value, _mode, milliseconds, condition) => (condition === "NX" ? client.set(key, value, "PX", milliseconds, "NX") : client.set(key, value, "PX", milliseconds)),
      del: (...keys) => client.del(...keys),
      lpush: (key, value) => client.lpush(key, value),
      ltrim: (key, start, stop) => client.ltrim(key, start, stop),
      lrange: (key, start, stop) => client.lrange(key, start, stop),
      pexpire: (key, milliseconds) => client.pexpire(key, milliseconds),
    },
    disconnect: () => client.disconnect(),
  };
}

/** 설정이 있으면 프로세스의 서비스(처음 부를 때 만든다), 없으면 null. */
function analysisService(config: ServerConfig): IncidentAnalysisService | null {
  if (!analysisConfigured(config)) return null;
  const store = globalThis as GlobalWithService;
  if (store[SERVICE_KEY] === undefined) {
    const { redis, disconnect } = redisCommands(config.logRedisUrl);
    const runner = createAnalysisRunnerClient({ baseUrl: config.claudeRunnerUrl, callSecret: config.claudeRunnerCallSecret, fetch: (input, init) => fetch(input, init) });
    const service = createIncidentAnalysisService({
      redis, runAnalysis: (prompt, requestId) => runner.runAnalysis(prompt, requestId), clock: () => Date.now(),
      newRequestId: () => `adm-${randomBytes(REQUEST_ID_RANDOM_BYTES).toString("base64url")}`,
      log: (requestId, message, level) => { void log(requestId, message, level); },
    });
    store[SERVICE_KEY] = { service, disconnect };
  }
  return store[SERVICE_KEY].service;
}

/** 이 프로세스의 분석 서비스(만들어졌으면) — 테스트 · 종료 로그용. */
export function existingIncidentAnalysisService(): IncidentAnalysisService | null {
  return (globalThis as GlobalWithService)[SERVICE_KEY]?.service ?? null;
}

/** 테스트 전용 — 프로세스의 분석 서비스를 버린다(다음 부름에서 설정을 다시 읽어 만든다). */
export function resetIncidentAnalysisService(): void {
  const store = globalThis as GlobalWithService;
  store[SERVICE_KEY]?.disconnect();
  delete store[SERVICE_KEY];
}

/** 같은 발생(since)의 가장 최근 분석이 끝났으면(succeeded) 그 권하는 조치 — 문제 화면의 "Claude 가 권함"(명세 ⑫ §24 — 표시일 뿐).
 * 분석 설정이 없거나 · 저장소에 닿지 못하거나 · 가장 최근 것이 끝나지 않았거나(진행 중 · 실패 · 끊김 · 읽을 수 없음) · 옛 발생의 것이면 null — 그 앞의 분석은 보지 않는다. */
export async function latestAnalysisAction(incidentId: string, since: string | null): Promise<AnalysisAction | null> {
  const service = analysisService(readServerConfig());
  if (service === null) return null;
  const history = await service.history(incidentId, since);
  if (!history.ok) return null;
  const [latest] = history.entries;
  if (latest === undefined || latest.kind !== "attempt" || latest.status !== "succeeded" || latest.fromEarlierOpening) return null;
  return latest.attempt.answer?.recommendedAction ?? null;
}

/** SIGTERM 때 — 이 프로세스에서 도는 분석의 수를 로그 한 줄로(`incident-analysis:shutdown running=<N>`). 서비스가 없으면 남기지 않는다.
 * 기록은 고치지 않는다 — 도는 분석은 running 으로 남아 5분 뒤 "끊김"으로 보인다. */
export function logIncidentAnalysisOnShutdown(): void {
  const service = existingIncidentAnalysisService();
  if (service === null) return;
  const running = service.runningCount();
  void log("shutdown", `incident-analysis:shutdown running=${running}`, running > 0 ? "warning" : "info");
}

// ---- 문제와 근거 ----

function lookup(config: ServerConfig, incidentId: string, withEvidence: boolean): Promise<IncidentLookup> {
  return lookupIncident({
    alertUrl: config.alertUrl, alertSecret: config.alertSecret, observeUrl: config.observeUrl, observeSecret: config.observeSecret,
    deployMasterUrl: config.deployMasterUrl, deploySecret: config.deploySecret,
    fetch: (input, init) => fetch(input, init), now: () => Date.now(),
    logFailure: (cell, failure) => {
      const logLine = upstreamFailureLogLine("incident-analysis", cell, failure);
      if (logLine !== null) void log(currentRequestId(), logLine, "warning");
    },
  }, incidentId, withEvidence);
}

function incidentState(found: IncidentLookup): AnalysisIncidentState {
  if (found.kind !== "open") return { state: found.kind };
  return { state: "open", kindLabel: found.incident.kindLabel, target: found.incident.target, since: found.incident.since };
}

/** 배포 실패 문제면 배포 마스터의 실패 출력(12-2 — 이미 가린 것), 아니면 null. */
async function failureOutputFor(config: ServerConfig, found: Extract<IncidentLookup, { kind: "open" }>): Promise<DeployFailureOutputResult | null> {
  if (found.incident.kind !== "deploy_failed") return null;
  if (!isHttpBaseUrl(config.deployMasterUrl) || config.deploySecret.length === 0) return { ok: false, reason: "unreachable" };
  return createDeployFailureOutputClient({ baseUrl: config.deployMasterUrl, secret: config.deploySecret, fetch: (input, init) => fetch(input, init) })
    .readFailureOutput(found.incident.deployment.requestId);
}

/** 보낼 글 그대로와 그 서명 — 실행 자리를 부르지 않고 Redis 에 쓰지 않는다. */
async function previewFor(config: ServerConfig, found: Extract<IncidentLookup, { kind: "open" }>, incidentId: string): Promise<AnalysisPreviewState> {
  if (found.evidence === null) return { kind: "unavailable", text: "근거를 모으지 못했습니다" };
  const failureOutput = await failureOutputFor(config, found);
  const built = buildAnalysisPrompt({ evidence: found.evidence, failureOutput, randomBytes: (size) => randomBytes(size) });
  if (!built.ok) {
    return { kind: "unavailable", text: built.reason === "too_long"
      ? `보낼 글이 6만 자를 넘어 보낼 수 없습니다(${built.characters}자)`
      : "자료와 겹치지 않는 경계 표지를 뽑지 못했습니다 — 미리보기를 다시 열어 주세요" };
  }
  const token = issueAnalysisPreviewToken(sessionSigningKey(), {
    incidentId, promptDigest: analysisPromptDigest(built.prompt), issuedAt: Date.now(), account: config.adminUser, incidentSince: found.incident.since,
  });
  return { kind: "ready", view: { prompt: built.prompt, token, characters: built.characters, bytes: built.bytes, reductions: built.reductions, maskCounts: built.maskCounts } };
}

async function historyFor(config: ServerConfig, incidentId: string, found: IncidentLookup): Promise<AnalysisHistoryView> {
  const service = analysisService(config);
  if (service === null) return { ok: false, reason: "not_configured" };
  const history = await service.history(incidentId, found.kind === "open" ? found.incident.since : undefined);
  return history.ok ? history : { ok: false, reason: "store_unavailable" };
}

/** 화면 — 세션이 없으면 /login(다른 서버를 부르지 않는다). 입력이 틀리면 invalid_input(호출 없음). */
export async function loadIncidentAnalysisScreen(input: SearchParamsInput): Promise<IncidentAnalysisScreenOutcome> {
  return inRequestScope(async () => {
    await requireSession();
    const parsed = parseIncidentAnalysisQuery(input);
    if (!parsed.ok) return { kind: "invalid_input" };
    const { incidentId, preview } = parsed.query;
    const config = readServerConfig();
    const found = await lookup(config, incidentId, preview);
    const history = await historyFor(config, incidentId, found);
    let previewState: AnalysisPreviewState | null = null;
    if (preview && found.kind === "open") {
      previewState = analysisConfigured(config) ? await previewFor(config, found, incidentId) : { kind: "unavailable", text: INCIDENT_ANALYSIS_TEXT.notConfigured };
    }
    return { kind: "screen", data: { checkedAt: new Date().toISOString(), incidentId, incident: incidentState(found), history, preview: previewState } };
  });
}

// ---- 보내기 ----

interface StartForm {
  incidentId: string;
  token: string;
  prompt: string;
}

/** urlencoded 본문의 세 칸 — 칸마다 정확히 하나 · 식별자의 꼴. 아니면 null. */
async function readStartForm(request: Request): Promise<StartForm | null> {
  if ((request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() !== FORM_MEDIA_TYPE) {
    request.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await readBoundedBody(request, INCIDENT_ANALYSIS_BODY_MAX_BYTES);
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
  const incidentId = single("incident");
  const token = single("preview");
  const prompt = single("prompt");
  if (incidentId === null || token === null || prompt === null || !isIncidentId(incidentId)) return null;
  if (token.length === 0 || token.length > ANALYSIS_PREVIEW_TOKEN_MAX_LENGTH || prompt.length === 0) return null;
  // 브라우저는 폼을 보낼 때 줄바꿈을 CRLF 로 바꾼다 — 보낼 글에는 \r 이 없으므로(직렬화가 줄 끝 글자를 거른다) 되돌리면 미리본 글 그대로다
  return { incidentId, token, prompt: prompt.replaceAll("\r\n", "\n") };
}

/** 실패 화면 — 서버에서 그린 최소한의 HTML(스크립트 없음). 식별자를 알면 그 분석 화면으로, 모르면 문제 화면으로 가는 링크. */
function failurePage(status: number, title: string, detail: string, incidentId: string | null): Response {
  const back = incidentId === null
    ? `<a href="${escapeHtml(incidentHref(null))}">${INCIDENT_ANALYSIS_TEXT.toIncident}</a>`
    : `<a href="${escapeHtml(incidentAnalysisHref(incidentId))}">분석 화면으로 돌아가기</a> · <a href="${escapeHtml(incidentHref(incidentId))}">${INCIDENT_ANALYSIS_TEXT.toIncident}</a>`;
  const html = "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    + "<title>분석 요청 · study-note 어드민</title></head>"
    + "<body style=\"font-family: system-ui, sans-serif; line-height: 1.6; margin: 0;\"><main style=\"max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem;\">"
    + `<h1 style="font-size: 1.25rem;">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p>${back}</p>`
    + "</main></body></html>";
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS } });
}

function logStart(outcome: string, incidentId: string | null, level: "info" | "warning" = "warning") {
  void log(currentRequestId(), `incident-analysis:${outcome} incident=${incidentId ?? "-"}`, level);
}

export async function incidentAnalysisStartResponse(request: Request): Promise<Response> {
  return inRequestScope(async () => {
    const config = readServerConfig();
    // 1 출처 — 로그인 · 재배포와 같은 검사
    if (!isAllowedOrigin(request.headers.get("origin"), config.adminOrigin)) {
      logStart("origin_rejected", null);
      return errorResponse(403, "origin_rejected");
    }
    // 2 세션
    const session = await requireApiSession();
    if (session instanceof Response) return session;
    // 3 본문
    const form = await readStartForm(request);
    if (form === null) {
      logStart("malformed", null);
      return failurePage(400, "요청의 꼴이 맞지 않습니다", "분석 화면의 미리보기 폼으로만 보낼 수 있습니다. 미리보기를 다시 열어 주세요.", null);
    }
    const { incidentId } = form;
    // 4 서명 — 미리본 글 그대로인가(다시 만들지 않는다)
    const check = verifyAnalysisPreviewToken(form.token, sessionSigningKey(),
      { incidentId, promptDigest: analysisPromptDigest(form.prompt), account: config.adminUser }, Date.now());
    if (!check.ok) {
      logStart(`preview_${check.reason}`, incidentId);
      if (check.reason === "malformed") return failurePage(400, "요청의 꼴이 맞지 않습니다", "미리보기의 서명 값이 아닙니다. 미리보기를 다시 열어 주세요.", incidentId);
      if (check.reason === "expired") return failurePage(409, "미리보기가 지났습니다", "미리보기는 연 뒤 10분 동안만 보낼 수 있습니다. 미리보기를 다시 열어 보낼 글을 확인하세요.", incidentId);
      return failurePage(409, "미리본 글과 다릅니다", "보내려는 글이 미리보기에서 보인 글과 다르거나 다른 문제의 미리보기입니다. 미리보기를 다시 열어 주세요.", incidentId);
    }
    // 5 설정
    const service = analysisService(config);
    if (service === null) {
      logStart("not_configured", incidentId);
      return failurePage(503, "분석을 시작하지 않았습니다", INCIDENT_ANALYSIS_TEXT.notConfigured, incidentId);
    }
    // 6 아직 열려 있는가 — 닫혔거나 확인하지 못하면 부르지 않는다
    const found = await lookup(config, incidentId, false);
    if (found.kind !== "open") {
      logStart(found.kind, incidentId);
      return failurePage(409, "분석을 시작하지 않았습니다", found.kind === "closed" ? INCIDENT_ANALYSIS_TEXT.closed : INCIDENT_ANALYSIS_TEXT.unchecked, incidentId);
    }
    // 7 같은 발생분인가 — 미리본 뒤 닫혔다 같은 식별자로 다시 열렸으면 옛 미리보기를 새 발생분의 분석으로 보내지 않는다
    if (check.incidentSince !== found.incident.since) {
      logStart("reopened", incidentId);
      return failurePage(409, "분석을 시작하지 않았습니다", INCIDENT_ANALYSIS_TEXT.reopened, incidentId);
    }
    // 8 미리보기는 한 번만 — 같은 폼을 다시 보내도 부르지 않는다("다시 분석"은 미리보기를 다시 열어서)
    const claim = await service.claimPreview(form.token);
    if (claim !== "claimed") {
      logStart(claim === "used" ? "preview_used" : "store_unavailable", incidentId);
      return claim === "used"
        ? failurePage(409, "분석을 시작하지 않았습니다", INCIDENT_ANALYSIS_TEXT.previewUsed, incidentId)
        : failurePage(503, "분석을 시작하지 않았습니다", INCIDENT_ANALYSIS_TEXT.storeUnavailable, incidentId);
    }
    // 9 시작 — 진행 중으로 남긴 뒤 곧바로 답한다(실행 자리는 뒤에서)
    const started = await service.start({ incidentId, incidentSince: found.incident.since, prompt: form.prompt, account: `admin:${config.adminUser}` });
    if (started.kind === "store_unavailable") return failurePage(503, "분석을 시작하지 않았습니다", INCIDENT_ANALYSIS_TEXT.storeUnavailable, incidentId);
    return new Response(null, { status: 303, headers: { Location: incidentAnalysisHref(incidentId), ...NO_STORE_HEADERS } });
  });
}
