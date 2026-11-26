/** 문제 하나의 조치(되돌리기 · 다시 배포 — 명세 ⑫ §24)의 순수 판정.
 * 계약:
 * - incidentActionService(근거): 서비스가 하나로 정해질 때만 { ok, service }(DEPLOY_SERVICES 안).
 *   감시 대상 DOWN = 대응 표의 서비스(없으면 unmapped) · 배포 실패 = 그 배포의 서비스 · 오류 로그 = 그 서비스 ·
 *   자원 임계값 = 근거의 로그 칸이 그 서버의 서비스로 찾은 것이 정확히 하나일 때(둘 이상 several_services · 찾지 못함 services_not_found · 로그 칸 실패 services_unknown).
 *   서비스가 배포하는 서비스(DEPLOY_SERVICES)가 아니면 not_deploy_service.
 * - incidentActionTargets(그 서비스의 이력 — master 의 최신순, 서비스가 다른 줄은 건너뛴다):
 *   다시 배포 = 가장 최근 성공한 배포의 커밋(⑥ 의 "지금 판" — 버전 목록의 versions[0]) · 되돌리기 = 그다음(바로 앞) 성공한 배포의 커밋.
 *   이력을 읽지 못함 history_unavailable(둘 다) · 성공한 배포가 없음 no_succeeded(둘 다) · 하나뿐 single_succeeded(되돌리기) ·
 *   바로 앞 성공 배포가 지금과 같은 커밋 same_as_current(되돌리기 — 더 앞을 찾아 건너가지 않는다). 진행 중 · 실패한 배포는 판이 아니다.
 * - recommendedIncidentAction: 분석의 recommended_action 이 정확히 "rollback" · "redeploy" 일 때만 그 단추 · "none" · 없음 · 그 밖은 null.
 * - incidentActionDeployments: 요청한 사람이 정확히 `admin:<계정>:incident:<이 ID>` 인 줄만(차례 그대로) — 접두만 같은 ID · 다른 문제 · 계정 없음 · github 는 섞이지 않는다. */
import { describe, expect, it } from "vitest";
import {
  INCIDENT_ACTION_KINDS, INCIDENT_ACTION_LABELS, INCIDENT_ACTION_TEXT, incidentActionDeployments, incidentActionService, incidentActionTargets,
  recommendedIncidentAction,
} from "@/features/incidents/lib/incident-actions";
import type { IncidentEvidence } from "@/features/incidents/lib/incident-evidence";
import { openIncidentsFrom, type IncidentSources, type OpenIncident } from "@/features/incidents/lib/incident-list";
import { analysisEvidence } from "@/features/incident-analysis/lib/analysis-test-fakes";
import {
  MINUTE, NOW, deployment, firing, iso, latest, logLine, logPage, monitor, monitors, ok, quietSources, serverLatest,
} from "@/features/incidents/lib/incidents-test-fakes";
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import { upstreamFailure } from "@/shared/lib/upstream-result";

function incidentOf(sources: IncidentSources, kind: OpenIncident["kind"]): OpenIncident {
  const found = openIncidentsFrom(sources).incidents.find((incident) => incident.kind === kind);
  expect(found, kind).toBeDefined();
  return found!;
}

function evidenceFor(incident: OpenIncident, overrides: Partial<IncidentEvidence> = {}): IncidentEvidence {
  return { ...analysisEvidence(), incident, ...overrides };
}

const SHA = (seed: string) => seed.repeat(40).slice(0, 40);

describe("incidentActionService — 서비스가 하나로 정해질 때만", () => {
  it("감시 대상 DOWN — 대응 표의 서비스 · 표에 없으면 unmapped", () => {
    const front = incidentOf(quietSources({ monitors: ok(monitors([monitor({ name: "backend-deps", status: "DOWN", downSince: iso(NOW - MINUTE) })])) }), "monitor_down");
    expect(incidentActionService(evidenceFor(front))).toEqual({ ok: true, service: "backend" });
    const master = incidentOf(quietSources({ monitors: ok(monitors([monitor({ name: "deploy-master", status: "DOWN" })])) }), "monitor_down");
    expect(incidentActionService(evidenceFor(master))).toEqual({ ok: false, reason: "unmapped" });
  });

  it("배포 실패 — 그 배포의 서비스", () => {
    const failed = incidentOf(quietSources({ deployments: ok([deployment({ service: "llm", state: "failed", failedStage: "ci_test" })]) }), "deploy_failed");
    expect(incidentActionService(evidenceFor(failed))).toEqual({ ok: true, service: "llm" });
  });

  it("오류 로그 — 그 서비스 · 배포하는 서비스가 아니면 not_deploy_service", () => {
    const errors = incidentOf(quietSources({ errorLogs: ok(logPage([logLine({ service: "front" })])) }), "error_logs");
    expect(incidentActionService(evidenceFor(errors))).toEqual({ ok: true, service: "front" });
    const agent = incidentOf(quietSources({ errorLogs: ok(logPage([logLine({ service: "deploy-agent-backend" })])) }), "error_logs");
    expect(incidentActionService(evidenceFor(agent))).toEqual({ ok: false, reason: "not_deploy_service" });
  });

  describe("자원 임계값 — 그 서버의 서비스(근거의 로그 칸)", () => {
    const resource = () => incidentOf(quietSources({ latest: ok(latest([serverLatest("s158")], [firing({ server: "s158" })])) }), "resource_threshold");
    const logs = (services: string[]): IncidentEvidence["logs"] => ({ state: "value", value: {
      scope: "levels", from: iso(NOW - 10 * MINUTE), to: iso(NOW), services, requestId: null, lines: [], truncated: false, noticeText: null,
    } });
    it("정확히 하나면 그 서비스", () => {
      expect(incidentActionService(evidenceFor(resource(), { logs: logs(["observe"]) }))).toEqual({ ok: true, service: "observe" });
    });
    it("둘 이상이면 several_services", () => {
      expect(incidentActionService(evidenceFor(resource(), { logs: logs(["front", "backend"]) }))).toEqual({ ok: false, reason: "several_services" });
    });
    it("찾지 못함 · 로그 칸 실패", () => {
      expect(incidentActionService(evidenceFor(resource(), { logs: { state: "services_not_found" } }))).toEqual({ ok: false, reason: "services_not_found" });
      expect(incidentActionService(evidenceFor(resource(), { logs: { state: "failed", failure: upstreamFailure("unreachable") } }))).toEqual({ ok: false, reason: "services_unknown" });
    });
  });

  it("까닭마다 고정 글이 있다 · 단추의 이름", () => {
    for (const reason of ["unmapped", "not_deploy_service", "services_not_found", "several_services", "services_unknown"] as const) {
      expect(INCIDENT_ACTION_TEXT.serviceReasons[reason].length).toBeGreaterThan(0);
    }
    expect(INCIDENT_ACTION_KINDS).toEqual(["redeploy", "rollback"]);
    expect(INCIDENT_ACTION_LABELS).toEqual({ redeploy: "다시 배포", rollback: "되돌리기" });
  });
});

describe("incidentActionTargets — 그 서비스의 이력(최신순)에서", () => {
  const row = (service: string, commit: string, state: DeploymentSummary["state"] = "succeeded") => deployment({ service, commitSha: SHA(commit), state });

  it("다시 배포 = 가장 최근 성공 · 되돌리기 = 바로 앞 성공(진행 중 · 실패 · 다른 서비스의 줄은 건너뛴다)", () => {
    const history = ok([row("backend", "c", "cd_running"), row("backend", "b", "failed"), row("front", "f"), row("backend", "a"), row("backend", "9"), row("backend", "8")]);
    expect(incidentActionTargets(history, "backend")).toEqual({ redeploy: { ok: true, commitSha: SHA("a") }, rollback: { ok: true, commitSha: SHA("9") } });
  });

  it("이력을 읽지 못함 — 둘 다 history_unavailable", () => {
    expect(incidentActionTargets(upstreamFailure("unreachable"), "backend")).toEqual({
      redeploy: { ok: false, reason: "history_unavailable" }, rollback: { ok: false, reason: "history_unavailable" },
    });
  });

  it("성공한 배포가 없음 — 둘 다 no_succeeded", () => {
    expect(incidentActionTargets(ok([row("backend", "a", "failed")]), "backend")).toEqual({
      redeploy: { ok: false, reason: "no_succeeded" }, rollback: { ok: false, reason: "no_succeeded" },
    });
  });

  it("성공한 배포가 하나뿐 — 다시 배포만", () => {
    expect(incidentActionTargets(ok([row("backend", "a"), row("backend", "b", "failed")]), "backend")).toEqual({
      redeploy: { ok: true, commitSha: SHA("a") }, rollback: { ok: false, reason: "single_succeeded" },
    });
  });

  it("바로 앞 성공 배포가 지금과 같은 커밋 — 되돌리기 없음(더 앞으로 건너가지 않는다)", () => {
    expect(incidentActionTargets(ok([row("backend", "a"), row("backend", "a"), row("backend", "b")]), "backend")).toEqual({
      redeploy: { ok: true, commitSha: SHA("a") }, rollback: { ok: false, reason: "same_as_current" },
    });
  });
});

describe("recommendedIncidentAction — 정해진 낱말과 정확히 같을 때만", () => {
  it.each([["rollback", "rollback"], ["redeploy", "redeploy"], ["none", null], [null, null], [undefined, null]] as const)("%s → %s", (action, expected) => {
    expect(recommendedIncidentAction(action)).toBe(expected);
  });

  it.each([["Rollback"], ["rollback "], ["되돌리기"], ["restart"]])("목록 밖의 글자 %j → null", (action) => {
    expect(recommendedIncidentAction(action as never)).toBeNull();
  });
});

describe("incidentActionDeployments — 이 문제에서 접수한 것만", () => {
  const by = (requestedBy: string | null | undefined, commit = "a") => ({ ...deployment({ commitSha: SHA(commit) }), requestedBy });

  it("`admin:<계정>:incident:<이 ID>` 만 · 차례 그대로", () => {
    const mine = by("admin:jun:incident:monitor:front", "1");
    const mineLater = by("admin:other.user:incident:monitor:front", "2");
    const rows = [
      by("admin:jun:incident:monitor:front-2"), by("admin:jun:incident:monitor:fron"), by("admin:jun:incident:monitor:front:x"),
      mine, by("admin:jun"), by("github"), by(null), by(undefined), by("admin:jun:incident:errors:front"), mineLater,
      by("xadmin:jun:incident:monitor:front"), by("admin::incident:monitor:front"), by("admin:j@n:incident:monitor:front"),
    ];
    expect(incidentActionDeployments(rows, "monitor:front")).toEqual([mine, mineLater]);
  });

  it("접두가 같은 ID — `…:incident:ab` 와 `…:incident:abc` 는 섞이지 않는다", () => {
    const ab = by("admin:jun:incident:errors:ab");
    const abc = by("admin:jun:incident:errors:abc");
    expect(incidentActionDeployments([ab, abc], "errors:ab")).toEqual([ab]);
    expect(incidentActionDeployments([ab, abc], "errors:abc")).toEqual([abc]);
  });
});
