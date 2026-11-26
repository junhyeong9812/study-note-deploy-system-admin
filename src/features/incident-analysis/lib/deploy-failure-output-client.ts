/** 배포 마스터의 실패 출력 조회(GET /deploys/{요청 ID}/output — 12-2) — 뼈대: 구현 워커가 채운다. 계약: deploy-failure-output-client.test.ts 머리 주석. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";

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

export function createDeployFailureOutputClient(options: DeployFailureOutputClientOptions): DeployFailureOutputClient {
  void options;
  throw new Error("createDeployFailureOutputClient: 구현 전");
}
