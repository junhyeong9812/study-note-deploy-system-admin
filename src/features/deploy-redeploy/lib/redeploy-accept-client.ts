/** master 접수 클라이언트(순수 — 설정 · 비밀값을 읽지 않는다. 기준 주소 · 비밀값은 부르는 쪽이 준다).
 * `POST <base>/deploy` 한 번(다시 보내지 않는다 — 같은 요청 ID 로 다시 보내는 것은 사람이 정한다) · 본문 JSON `{service, commit_sha, request_id, requested_by}` ·
 * 머리글 `X-Deploy-Secret` · `Content-Type: application/json` · redirect:"manual" · 기한 REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS(본문까지).
 * 오류 봉투의 error.code 는 결과를 가르는 데만 쓰고, 원문 · detail 은 결과에 담지 않는다. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { REDEPLOY_REQUEST_ID_PATTERN } from "@/features/deploy-redeploy/lib/redeploy-confirmation";
import { isRecord, upstreamUrl } from "@/shared/lib/upstream-fetch";

export const REDEPLOY_ACCEPT_PATH = "/deploy";
export const REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS = 10_000;

export interface RedeployAcceptRequest {
  service: string;
  commitSha: string;
  requestId: string;
  requestedBy: string;
}

/** master 의 답 → 결과(원문 · 오류 detail 은 담지 않는다).
 * - accepted: 202(새 접수 · duplicate:true 면 같은 요청 ID 의 재접수). 본문을 해석하지 못해도 202 면 accepted(duplicate false · 보낸 요청 ID).
 *   돌려받은 요청 ID 는 꼴(REDEPLOY_REQUEST_ID_PATTERN)이 맞을 때만 쓰고, 아니면 보낸 요청 ID
 * - in_progress: 409 deploy_in_progress · request_id_conflict: 409 request_id_conflict
 * - rejected: 422 invalid_requested_by · invalid_sha · unknown_service · invalid_request, 401 unauthorized, 그 밖의 4xx · 3xx 는 unexpected
 * - not_accepted: 연결을 맺지 못함(cause 가 Error 이고 code 가 CONNECT_FAILURE_CODES) · 5xx(status) — 접수되지 않았다
 * - unknown: 그 밖의 모든 실패 — 기한 초과 · 보낸 뒤 끊김 · 모르는 예외 · 2xx · 409 의 본문을 읽다 끊김. 요청은 나갔을 수 있다 */
export type RedeployAcceptResult =
  | { kind: "accepted"; requestId: string; duplicate: boolean }
  | { kind: "in_progress" }
  | { kind: "request_id_conflict" }
  | { kind: "rejected"; code: "invalid_requested_by" | "invalid_sha" | "unknown_service" | "invalid_request" | "unauthorized" | "unexpected" }
  | { kind: "not_accepted"; status?: number }
  | { kind: "unknown" };

export interface RedeployAcceptClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface RedeployAcceptClient {
  accept(request: RedeployAcceptRequest): Promise<RedeployAcceptResult>;
}

type RejectedCode = Extract<RedeployAcceptResult, { kind: "rejected" }>["code"];

/** 422 의 code 가운데 결과에 그대로 옮기는 것(그 밖은 unexpected). */
const KNOWN_REJECTED_CODES: readonly RejectedCode[] = ["invalid_requested_by", "invalid_sha", "unknown_service", "invalid_request"];

function defaultTimeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

/** 연결을 맺지 못한 쪽의 code(Node fetch — undici 가 TypeError 의 cause 에 싣는다). 이 밖은 요청이 나갔을 수 있다. */
const CONNECT_FAILURE_CODES: readonly string[] = ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"];

/** 요청이 나가지 않았다고 말할 수 있는 실패인가 — 기한이 끊었으면 아니다. */
function isConnectFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || !(error instanceof Error) || !(error.cause instanceof Error)) return false;
  const code = (error.cause as Error & { code?: unknown }).code;
  return typeof code === "string" && CONNECT_FAILURE_CODES.includes(code);
}

/** 본문(JSON 이면 그 값, 아니면 null) — 기한 안에서 읽는다. 끊기면 그 예외를 던진다. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorCodeOf(json: unknown): string | null {
  if (!isRecord(json) || !isRecord(json.error)) return null;
  return typeof json.error.code === "string" ? json.error.code : null;
}

function resultForStatus(status: number, json: unknown, sentRequestId: string): RedeployAcceptResult {
  if (status === 202) {
    const data = isRecord(json) && isRecord(json.data) ? json.data : null;
    const requestId = data !== null && typeof data.request_id === "string" && REDEPLOY_REQUEST_ID_PATTERN.test(data.request_id) ? data.request_id : sentRequestId;
    return { kind: "accepted", requestId, duplicate: data?.duplicate === true };
  }
  // 5xx 를 "접수되지 않음"으로 두는 것은 어드민과 배포 서버 사이에 프록시가 없다는 전제다(5xx 는 배포 서버 자신의 답).
  if (status >= 500) return { kind: "not_accepted", status };
  const code = errorCodeOf(json);
  if (status === 409 && code === "deploy_in_progress") return { kind: "in_progress" };
  if (status === 409 && code === "request_id_conflict") return { kind: "request_id_conflict" };
  if (status === 401) return { kind: "rejected", code: "unauthorized" };
  if (status === 422 && code !== null && (KNOWN_REJECTED_CODES as readonly string[]).includes(code)) return { kind: "rejected", code: code as RejectedCode };
  return { kind: "rejected", code: "unexpected" };   // 그 밖의 4xx · 3xx · 202 가 아닌 2xx
}

export function createRedeployAcceptClient(options: RedeployAcceptClientOptions): RedeployAcceptClient {
  return {
    async accept(request) {
      const signal = (options.timeoutSignal ?? defaultTimeoutSignal)(REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS);
      const body = JSON.stringify({ service: request.service, commit_sha: request.commitSha, request_id: request.requestId, requested_by: request.requestedBy });
      let response: Response;
      try {
        response = await options.fetch(upstreamUrl(options.baseUrl, REDEPLOY_ACCEPT_PATH), {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-Deploy-Secret": options.secret },
          body,
          signal,
          redirect: "manual",
          cache: "no-store",
        });
      } catch (error) {
        return isConnectFailure(error, signal) ? { kind: "not_accepted" } : { kind: "unknown" };
      }
      let json: unknown = null;
      try {
        json = await readJson(response);
      } catch {
        // 상태는 받았다. 2xx · 409 는 본문이 있어야 가를 수 있어 모름, 그 밖의 4xx · 5xx 는 상태로 이미 접수되지 않음이다
        if ((response.status >= 200 && response.status < 300) || response.status === 409) return { kind: "unknown" };
      }
      return resultForStatus(response.status, json, request.requestId);
    },
  };
}
