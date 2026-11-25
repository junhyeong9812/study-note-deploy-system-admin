/** 문제 화면의 조립(순수 — 설정은 options 로, 네트워크는 options.fetch, 시계는 options.now). 거부(reject)하지 않는다.
 *
 * 1단계(목록) — 네 호출을 **한꺼번에**(각 5초, 기존 클라이언트 그대로):
 *   알림 서버 `GET /monitors`(collectStatusOverview 의 감시 대상 칸과 같은 해석) · 관측 서버 `GET /metrics/latest`(createResourceMetricsClient) ·
 *   배포 마스터 `GET /deploys?limit=200`(createDeployHistoryClient, 서비스 거름 없음) ·
 *   관측 서버 `GET /logs?from=<now−10분>&to=<now>&level=error&limit=500`(createLogClient).
 *   → openIncidentsFrom. 설정이 빈 출처는 그 출처만 not_configured(호출 없음).
 * 2단계(incidentId 가 있을 때만) — 그 식별자가 목록에 있으면 buildIncidentEvidence → fitIncidentEvidence, 글은 incidentEvidenceText(맞춘 묶음).
 *   목록에 없으면: 그 종류의 출처가 실패했으면 { kind: "unchecked" }(열려 있는지 확인하지 못함), 아니면 { kind: "closed" }(지금 열려 있지 않음) — 2단계 호출 없음.
 * 호출 수: 목록 INCIDENT_LIST_CALLS + 근거 INCIDENT_EVIDENCE_MAXIMUM_CALLS 이하. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { IncidentEvidence } from "@/features/incidents/lib/incident-evidence";
import type { IncidentList } from "@/features/incidents/lib/incident-list";

export const INCIDENT_LIST_CALLS = 4;

export const SELECTED_INCIDENT_TEXT = {
  closed: "이 문제는 지금 열려 있지 않습니다",
  unchecked: "이 문제가 지금 열려 있는지 확인하지 못했습니다",
  toList: "문제 목록으로",
} as const;

export type SelectedIncident =
  | { kind: "evidence"; evidence: IncidentEvidence; text: string }
  | { kind: "closed"; incidentId: string }
  | { kind: "unchecked"; incidentId: string };

export interface IncidentsScreenData {
  /** 조회를 시작한 시각(ISO) */
  checkedAt: string;
  list: IncidentList;
  /** 식별자를 고르지 않았으면 null */
  selected: SelectedIncident | null;
}

export interface IncidentsScreenOptions {
  alertUrl: string;
  alertSecret: string;
  observeUrl: string;
  observeSecret: string;
  deployMasterUrl: string;
  deploySecret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
  now: () => number;
}

export async function collectIncidentsScreen(options: IncidentsScreenOptions, incidentId: string | null): Promise<IncidentsScreenData> {
  void options; void incidentId;
  throw new Error("not implemented");
}
