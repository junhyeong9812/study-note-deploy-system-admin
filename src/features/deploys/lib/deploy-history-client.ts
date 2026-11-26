/** master 배포 이력 클라이언트 — `GET <DEPLOY_MASTER_URL>/deploys?service=&limit=`, 헤더 `X-Deploy-Secret`, 5초 기한, GET 만.
 * 응답 봉투 `{success:true,data:{deployments:[Deployment]}}`(ci-cd internal/master/master.go:351, internal/shared/envelope.go:11).
 * Deployment JSON 칸(internal/master/store.go:22-33): request_id · service · commit_sha · state · failed_stage(omitempty) · detail(omitempty)
 * · accepted_at · finished_at(omitempty) · ci_ms · cd_ms.
 * 화면에 넘기는 칸 = 요청 ID(목록 key · 앞부분 표시 — 판정 11-22 4번) · 상태 · 서비스 · 커밋 · 실패 단계 · 접수/종료 시각 · 걸린 시간(ci_ms · cd_ms)뿐
 * — detail(빌드 출력 끝부분) · 원본 봉투는 넘기지 않는다.
 * 비밀값을 실은 요청은 리다이렉트를 따라가지 않는다(redirect:"manual" — 3xx 는 bad_status).
 * 응답의 한 항목이라도 꼴이 다르면 전체를 unparseable 로(원문을 넘기지 않는다). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { DeployHistoryQuery } from "@/features/deploys/lib/deploy-history-query";
import { envelopeData, getUpstream, isNonNegativeInteger, isRecord, upstreamUrl } from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

/** master 의 배포 상태(store.go:13-19). 이 밖의 값은 unparseable. */
export const DEPLOY_STATES = ["accepted", "ci_running", "cd_running", "succeeded", "failed"] as const;
export type DeployState = (typeof DEPLOY_STATES)[number];

/** 화면 한 줄. */
export interface DeploymentSummary {
  /** request_id(비밀값 아님) */
  requestId: string;
  state: DeployState;
  service: string;
  commitSha: string;
  /** failed_stage 가 없거나 빈 글자면 null */
  failedStage: string | null;
  acceptedAt: string;
  /** finished_at 이 없거나 빈 글자면 null(진행 중) */
  finishedAt: string | null;
  /** ci_ms */
  integrationMilliseconds: number;
  /** cd_ms */
  deliveryMilliseconds: number;
  /** requested_by(누가 일으켰나 — 명세 ⑫ §24). 뼈대: 아직 읽지 않는다 */
  requestedBy?: string | null;
}

export interface DeployHistoryClientOptions {
  baseUrl: string;      // 끝의 / 허용
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;   // 기본 AbortSignal.timeout — 5000 으로 부른다
}

export interface DeployHistoryClient {
  /** 최신순(master 가 정렬한 순서 그대로). service 가 null 이면 service 인자를 보내지 않는다. */
  listDeployments(query: DeployHistoryQuery): Promise<UpstreamResult<DeploymentSummary[]>>;
}

/** 빠졌거나(omitempty) 빈 글자면 null, 글자가 아니면 undefined(해석 불가). */
function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" ? value : undefined;
}

/** master 의 한 항목 → 화면 한 줄. 꼴이 다르면 null. */
function parseDeployment(row: unknown): DeploymentSummary | null {
  if (!isRecord(row)) return null;
  const { request_id: requestId, service, commit_sha: commitSha, state, accepted_at: acceptedAt, ci_ms: integrationMilliseconds, cd_ms: deliveryMilliseconds } = row;
  if (typeof requestId !== "string" || typeof service !== "string" || typeof commitSha !== "string" || typeof acceptedAt !== "string") return null;
  if (typeof state !== "string" || !(DEPLOY_STATES as readonly string[]).includes(state)) return null;
  if (!isNonNegativeInteger(integrationMilliseconds) || !isNonNegativeInteger(deliveryMilliseconds)) return null;
  const failedStage = optionalText(row.failed_stage);
  const finishedAt = optionalText(row.finished_at);
  if (failedStage === undefined || finishedAt === undefined) return null;
  return {
    requestId, state: state as DeployState, service, commitSha, failedStage, acceptedAt, finishedAt,
    integrationMilliseconds, deliveryMilliseconds,
  };
}

export function createDeployHistoryClient(options: DeployHistoryClientOptions): DeployHistoryClient {
  return {
    async listDeployments(query) {
      const url = upstreamUrl(options.baseUrl, "/deploys", [["service", query.service], ["limit", String(query.limit)]]);
      const response = await getUpstream(url, { fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers: { "X-Deploy-Secret": options.secret } });
      if (!response.ok) return response;
      if (response.status < 200 || response.status >= 300) return failureForHttpStatus(response.status);
      const rows = envelopeData(response)?.deployments;
      if (!Array.isArray(rows)) return upstreamFailure("unparseable");
      const deployments: DeploymentSummary[] = [];
      for (const row of rows) {
        const deployment = parseDeployment(row);
        if (deployment === null) return upstreamFailure("unparseable");   // 한 항목이라도 다르면 전체
        deployments.push(deployment);
      }
      return { ok: true, value: deployments };
    },
  };
}
