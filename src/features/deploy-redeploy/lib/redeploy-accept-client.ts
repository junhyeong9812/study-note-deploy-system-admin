/** master 접수 클라이언트(순수 — 설정 · 비밀값을 읽지 않는다) — 뼈대: 타입과 시그니처만. 구현 워커가 채운다.
 * `POST <base>/deploy` 한 번(다시 보내지 않는다) · 본문 JSON `{service, commit_sha, request_id, requested_by}` · 머리글 `X-Deploy-Secret` ·
 * `Content-Type: application/json` · redirect:"manual" · 기한 REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";

export const REDEPLOY_ACCEPT_PATH = "/deploy";
export const REDEPLOY_ACCEPT_TIMEOUT_MILLISECONDS = 10_000;

export interface RedeployAcceptRequest {
  service: string;
  commitSha: string;
  requestId: string;
  requestedBy: string;
}

/** master 의 답 → 결과(원문 · 오류 detail 은 담지 않는다).
 * - accepted: 202(새 접수 · duplicate:true 면 같은 요청 ID 의 재접수). 본문을 해석하지 못해도 202 면 accepted(duplicate false · 보낸 요청 ID)
 * - in_progress: 409 deploy_in_progress · request_id_conflict: 409 request_id_conflict
 * - rejected: 422 invalid_requested_by · invalid_sha · unknown_service · invalid_request, 401 unauthorized, 그 밖의 4xx · 3xx 는 unexpected
 * - not_accepted: 연결 실패(TypeError 등) · 5xx(status) — 접수되지 않았다
 * - unknown: 기한 초과(신호가 끊김 · AbortError · TimeoutError) — 요청은 나갔을 수 있다 */
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

export function createRedeployAcceptClient(options: RedeployAcceptClientOptions): RedeployAcceptClient {
  void options;
  throw new Error("not implemented: createRedeployAcceptClient");
}
