/** 배포 마스터의 실패 출력 조회(GET /deploys/{요청 ID}/output — 12-2 · ci-cd internal/master/failure_output.go handleFailureOutput) — 읽기 하나.
 * 기존 getUpstream(5초 · redirect manual · no-store) · X-Deploy-Secret. 요청 ID 가 꼴 밖이면 부르지 않는다(경로를 잇기 전에).
 * 출력의 글은 배포 마스터가 이미 가린 것이다 — 여기서는 고치지 않는다(분석의 가림은 analysis-prompt 에서 한 겹 더).
 * 실패는 고정 까닭만(다른 서버의 글을 싣지 않는다). 계약: deploy-failure-output-client.test.ts 머리 주석. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
// master 의 요청 ID 꼴(ci-cd internal/shared/logger.go) — 재배포의 확인 값이 쓰는 것과 같다
import { REDEPLOY_REQUEST_ID_PATTERN } from "@/features/deploy-redeploy/lib/redeploy-confirmation";
import { envelopeData, getUpstream, isNonNegativeInteger, isRecord, upstreamUrl } from "@/shared/lib/upstream-fetch";

export interface DeployFailureOutput {
  requestId: string;
  failedStage: string;
  recordedAt: string;
  output: string;
  truncated: boolean;
  omittedBytes: number;
}

export const DEPLOY_FAILURE_OUTPUT_UNAVAILABLE_REASONS = [
  "not_recorded", "expired", "not_finished", "not_failed", "not_found", "read_failed", "invalid_request_id", "unauthorized",
  "unavailable", "unreachable", "timeout", "unparseable",
] as const;
export type DeployFailureOutputUnavailableReason = (typeof DEPLOY_FAILURE_OUTPUT_UNAVAILABLE_REASONS)[number];

export type DeployFailureOutputResult =
  | { ok: true; output: DeployFailureOutput }
  | { ok: false; reason: DeployFailureOutputUnavailableReason };

/** 까닭마다의 고정 글(다른 서버의 글을 싣지 않는다) — 묶음에 `전체 출력을 얻지 못함 — <글>` 한 줄로. */
export const DEPLOY_FAILURE_OUTPUT_UNAVAILABLE_TEXT: Readonly<Record<DeployFailureOutputUnavailableReason, string>> = {
  not_recorded: "배포 마스터가 출력을 남기지 않았습니다",
  expired: "보관 기간이 지나 지워졌습니다",
  not_finished: "배포가 아직 끝나지 않았습니다",
  not_failed: "실패한 배포가 아닙니다",
  not_found: "배포 이력에 없습니다",
  read_failed: "배포 마스터가 출력 파일을 읽지 못했습니다",
  invalid_request_id: "요청 ID 의 꼴이 맞지 않습니다",
  unauthorized: "배포 마스터가 비밀값을 받지 않았습니다",
  unavailable: "배포 마스터의 일시 장애",
  unreachable: "배포 마스터에 닿지 못했습니다",
  timeout: "배포 마스터가 5초 안에 답하지 않았습니다",
  unparseable: "배포 마스터의 답을 읽지 못했습니다",
};

export interface DeployFailureOutputClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface DeployFailureOutputClient {
  readFailureOutput(requestId: string): Promise<DeployFailureOutputResult>;
}

function failure(reason: DeployFailureOutputUnavailableReason): DeployFailureOutputResult {
  return { ok: false, reason };
}

function outputOf(data: Record<string, unknown> | undefined): DeployFailureOutput | null {
  if (data === undefined) return null;
  const { request_id: requestId, failed_stage: failedStage, recorded_at: recordedAt, output, truncated, omitted_bytes: omittedBytes } = data;
  if (typeof requestId !== "string" || typeof failedStage !== "string" || typeof recordedAt !== "string" || typeof output !== "string"
    || typeof truncated !== "boolean" || !isNonNegativeInteger(omittedBytes)) return null;
  return { requestId, failedStage, recordedAt, output, truncated, omittedBytes };
}

/** 200 이 아닌 상태와 본문의 code → 고정 까닭. */
function unavailableReasonFor(status: number, json: unknown): DeployFailureOutputUnavailableReason {
  const code = isRecord(json) && isRecord(json.error) && typeof json.error.code === "string" ? json.error.code : null;
  switch (status) {
    case 401: return "unauthorized";
    case 422: return "invalid_request_id";
    case 404: return code === "output_not_recorded" ? "not_recorded" : "not_found";
    case 410: return "expired";
    case 409: return code === "not_finished" ? "not_finished" : code === "not_failed" ? "not_failed" : "unparseable";
    case 500: return code === "output_read_failed" ? "read_failed" : "unavailable";
    default: return status >= 500 ? "unavailable" : "unparseable";
  }
}

export function createDeployFailureOutputClient(options: DeployFailureOutputClientOptions): DeployFailureOutputClient {
  return {
    async readFailureOutput(requestId) {
      if (!REDEPLOY_REQUEST_ID_PATTERN.test(requestId)) return failure("invalid_request_id");
      const response = await getUpstream(upstreamUrl(options.baseUrl, `/deploys/${requestId}/output`), {
        fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers: { "X-Deploy-Secret": options.secret },
      });
      if (!response.ok) return failure(response.reason === "timeout" ? "timeout" : "unreachable");
      if (response.status !== 200) return failure(unavailableReasonFor(response.status, response.parsed ? response.json : null));
      const output = outputOf(envelopeData(response));
      return output === null ? failure("unparseable") : { ok: true, output };
    },
  };
}
