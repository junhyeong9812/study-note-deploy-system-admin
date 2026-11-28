/** 문제 하나의 근거 묶음(순수 조립 — 클라이언트는 가짜를 주입) — 칸마다 따로 실패 · 시간 창의 경계 · 로그는 경고 · 오류만(상한을 드러냄) ·
 * 배포 실패의 로그는 그 배포의 요청 ID 로 · 대응 표에 없는 대상은 짐작하지 않음 · 칸들은 한꺼번에. */
import { describe, expect, it, vi } from "vitest";
import {
  EVIDENCE_LOG_LINE_LIMIT, EVIDENCE_TEXT, INCIDENT_EVIDENCE_MAXIMUM_CALLS, buildIncidentEvidence, evidenceCellNotice,
  type EvidenceCell, type IncidentEvidenceDependencies,
} from "@/features/incidents/lib/incident-evidence";
import { openIncidentsFrom, type IncidentSources, type OpenIncident } from "@/features/incidents/lib/incident-list";
import type { IncidentSummary } from "@/features/log-trace/lib/incident-client";
import type { TraceResourcesView } from "@/features/log-trace/lib/trace-resources";
import type { LogPage, LogQuery } from "@/features/logs/lib/log-query";
import { LOG_QUERY_DEFAULT_LIMIT } from "@/features/logs/lib/log-query";
import { logsHref } from "@/features/logs/ui/logs-address";
import type { GitCommitRange } from "@/features/deploy-detail/lib/deploy-git-client";
import { deploysHref } from "@/features/deploys/ui/deploys-address";
import { DEPLOY_HISTORY_DEFAULT_LIMIT } from "@/features/deploys/lib/deploy-history-query";
import {
  HOUR, MINUTE, NOW, SECOND, UNREACHABLE, alertRecord, deployment, firing, iso, latest, logLine, logPage, monitor, monitors, ok, quietSources, serverLatest,
} from "@/features/incidents/lib/incidents-test-fakes";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

// ── 가짜 클라이언트 ──────────────────────────────────────

interface FakeAnswers {
  alertRecords?: () => Promise<UpstreamResult<IncidentSummary[]>>;
  logs?: (query: LogQuery) => Promise<UpstreamResult<LogPage>>;
  commits?: () => Promise<UpstreamResult<GitCommitRange>>;
  trace?: (service: string, atMilliseconds: number) => Promise<TraceResourcesView | null>;
}

function traceView(service: string, atMilliseconds: number, location: TraceResourcesView["location"] = ok({
  kind: "found", server: "s158", matchedBy: "container", serviceContainer: `${service}-app`, containers: [`${service}-app`], alsoSeenOn: [], uncheckedServers: [],
  skippedServerCount: 0, unreadableServerNameCount: 0,
})): TraceResourcesView {
  return {
    service, atMilliseconds, fromMilliseconds: atMilliseconds - 5 * MINUTE, toMilliseconds: atMilliseconds + 5 * MINUTE, location,
    host: ok({ source: "raw", stepMilliseconds: 30_000, pointCount: 20, noRecord: false, values: [
      { label: "CPU", unit: "percent", atLogValue: 97.5, atLogText: "97.5%", maximumValue: 99, maximumText: "99.0%" },
    ] }),
    container: null,
  };
}

function fakeDependencies(answers: FakeAnswers = {}) {
  const dependencies = {
    alertRecords: { listIncidents: vi.fn((limit: number) => { void limit; return answers.alertRecords ? answers.alertRecords() : Promise.resolve(ok<IncidentSummary[]>([])); }) },
    logs: { searchLogs: vi.fn((query: LogQuery) => (answers.logs ? answers.logs(query) : Promise.resolve(ok(logPage([], { from: query.from!, to: query.to! }))))) },
    deployGit: {
      listCommits: vi.fn((service: string, fromSha: string, toSha: string) => {
        void service; void fromSha; void toSha;
        return answers.commits ? answers.commits() : Promise.resolve(ok<GitCommitRange>({ commits: [], truncated: false, rangeComplete: true, relation: "ancestor" }));
      }),
      getCommit: vi.fn(() => Promise.resolve(upstreamFailure("not_found"))),
    },
    traceResources: vi.fn((service: string, atMilliseconds: number) => (answers.trace ? answers.trace(service, atMilliseconds) : Promise.resolve(traceView(service, atMilliseconds)))),
  };
  return dependencies;
}

function asDependencies(fake: ReturnType<typeof fakeDependencies>): IncidentEvidenceDependencies {
  return fake as unknown as IncidentEvidenceDependencies;
}

function value<Value>(cell: EvidenceCell<Value>): Value {
  expect(cell, JSON.stringify(cell)).toMatchObject({ state: "value" });
  if (cell.state !== "value") throw new Error("expected value");
  return cell.value;
}

function incidentOf(sources: IncidentSources, kind: OpenIncident["kind"]): OpenIncident {
  const incident = openIncidentsFrom(sources).incidents.find((candidate) => candidate.kind === kind);
  expect(incident, kind).toBeDefined();
  return incident!;
}

function build(fake: ReturnType<typeof fakeDependencies>, sources: IncidentSources, kind: OpenIncident["kind"]) {
  return buildIncidentEvidence(asDependencies(fake), { incident: incidentOf(sources, kind), sources, nowMilliseconds: NOW });
}

/** 로그 조회 인자 — LogQuery 의 모든 칸(조회 조건을 빠짐없이 고정한다). */
function logQuery(overrides: Partial<LogQuery>): LogQuery {
  return { from: null, to: null, service: null, level: null, requestId: null, text: null, before: null, limit: 500, ...overrides };
}

// ── 감시 대상 DOWN ───────────────────────────────────────

const DOWN_AT = NOW - 20 * MINUTE;
const downSources = (overrides: Partial<IncidentSources> = {}) => quietSources({
  monitors: ok(monitors([monitor({ name: "front", status: "DOWN", downSince: iso(DOWN_AT), reason: "status 502" })])),
  ...overrides,
});

describe("감시 대상 DOWN — 무엇이 · 언제부터", () => {
  it("대상 · 상태 · 이유 · DOWN 시각 · 서비스", async () => {
    const evidence = await build(fakeDependencies(), downSources(), "monitor_down");
    expect(evidence.facts).toEqual([
      { label: "대상", value: "front" }, { label: "상태", value: "DOWN" }, { label: "이유", value: "status 502" },
      { label: "DOWN 시각", value: iso(DOWN_AT) }, { label: "서비스", value: "front" },
    ]);
    expect(evidence.reductions).toEqual([]);
  });

  it("이유 · DOWN 시각이 없으면 '—' · '모름', 대응 표에 없으면 서비스 '대응 표에 없음'", async () => {
    const sources = quietSources({ monitors: ok(monitors([monitor({ name: "deploy-master", status: "DOWN", downSince: null, reason: "" })])) });
    const evidence = await build(fakeDependencies(), sources, "monitor_down");
    expect(evidence.facts).toEqual([
      { label: "대상", value: "deploy-master" }, { label: "상태", value: "DOWN" }, { label: "이유", value: "—" },
      { label: "DOWN 시각", value: "모름" }, { label: "서비스", value: "대응 표에 없음" },
    ]);
  });
});

describe("감시 대상 DOWN — 관련 알림: 그 대상의 앞뒤 1시간(양끝 포함)", () => {
  it("대상 이름 · monitor_ 종류 · 창으로 거른다(쉼표로 묶인 key 포함)", async () => {
    const records = [
      alertRecord({ at: iso(DOWN_AT + HOUR + 1), kind: "monitor_up", key: "front", title: "창 뒤 1ms" }),
      alertRecord({ at: iso(DOWN_AT + HOUR), kind: "monitor_up", key: "front", title: "창 끝" }),
      alertRecord({ at: iso(DOWN_AT + 5 * MINUTE), kind: "monitor_still_down", key: "front", title: "아직" }),
      alertRecord({ at: iso(DOWN_AT), kind: "monitor_down", key: "backend,front,llm", title: "여럿" }),
      alertRecord({ at: iso(DOWN_AT), kind: "monitor_down", key: "frontier", title: "비슷한 이름" }),
      alertRecord({ at: iso(DOWN_AT), kind: "event", key: "front", title: "이벤트" }),
      alertRecord({ at: iso(DOWN_AT - HOUR), kind: "monitor_down", key: "front", title: "창 앞 끝" }),
      alertRecord({ at: iso(DOWN_AT - HOUR - 1), kind: "monitor_down", key: "front", title: "창 앞 1ms" }),
    ];
    const fake = fakeDependencies({ alertRecords: async () => ok(records) });
    const history = value((await build(fake, downSources(), "monitor_down")).alertHistory);
    expect(fake.alertRecords.listIncidents).toHaveBeenCalledTimes(1);
    expect(fake.alertRecords.listIncidents).toHaveBeenCalledWith(200);
    expect(history.records.map((record) => record.title)).toEqual(["창 끝", "아직", "여럿", "창 앞 끝"]);
    expect(history.from).toBe(iso(DOWN_AT - HOUR));
    expect(history.to).toBe(iso(DOWN_AT + HOUR));
    expect(history.coversWindow).toBe(true);
  });

  it("받은 기록이 200건이고 가장 이른 것이 창의 앞쪽에 닿지 못하면 coversWindow false", async () => {
    const records = Array.from({ length: 200 }, (_, index) => alertRecord({ at: iso(DOWN_AT + HOUR - index * SECOND), key: "other" }));
    const history = value((await build(fakeDependencies({ alertRecords: async () => ok(records) }), downSources(), "monitor_down")).alertHistory);
    expect(history.records).toEqual([]);
    expect(history.coversWindow).toBe(false);
  });

  it("200건 미만이면 창 앞쪽까지 본 것이다", async () => {
    const records = Array.from({ length: 199 }, (_, index) => alertRecord({ at: iso(DOWN_AT + HOUR - index * SECOND), key: "other" }));
    expect(value((await build(fakeDependencies({ alertRecords: async () => ok(records) }), downSources(), "monitor_down")).alertHistory).coversWindow).toBe(true);
  });
});

describe("감시 대상 DOWN — 로그: 그 서비스의 앞뒤 10분 경고 · 오류", () => {
  it("warning · error 두 번, 창 [T−10분, T+10분], 그 서비스, limit 500", async () => {
    const fake = fakeDependencies();
    const logs = value((await build(fake, downSources(), "monitor_down")).logs);
    expect(fake.logs.searchLogs).toHaveBeenCalledTimes(2);
    const queries = fake.logs.searchLogs.mock.calls.map(([query]) => query);
    const window = { from: iso(DOWN_AT - 10 * MINUTE), to: iso(DOWN_AT + 10 * MINUTE), service: "front" };
    expect(queries).toContainEqual(logQuery({ ...window, level: "warning" }));
    expect(queries).toContainEqual(logQuery({ ...window, level: "error" }));
    expect(logs).toMatchObject({ scope: "levels", from: window.from, to: window.to, services: ["front"], requestId: null, truncated: false, noticeText: null });
  });

  it("DOWN 시각을 모르면 지금을 기준으로", async () => {
    const fake = fakeDependencies();
    const sources = quietSources({ monitors: ok(monitors([monitor({ name: "front", status: "DOWN", downSince: null })])) });
    await build(fake, sources, "monitor_down");
    expect(fake.logs.searchLogs.mock.calls[0][0]).toMatchObject({ from: iso(NOW - 10 * MINUTE), to: iso(NOW + 10 * MINUTE) });
    expect(fake.traceResources).toHaveBeenCalledWith("front", NOW);
  });

  it("두 응답을 합쳐 시간순(옛것부터) · 줄마다 로그 화면의 그 줄로 가는 링크", async () => {
    const early = logLine({ at: iso(DOWN_AT - 2 * MINUTE), level: "warning", message: "느림" });
    const late = logLine({ at: iso(DOWN_AT + MINUTE), level: "error", message: "실패" });
    const fake = fakeDependencies({ logs: async (query) => ok(logPage(query.level === "warning" ? [early] : [late], { from: query.from!, to: query.to! })) });
    const logs = value((await build(fake, downSources(), "monitor_down")).logs);
    expect(logs.lines.map((line) => line.message)).toEqual(["느림", "실패"]);
    expect(logs.lines[0].href).toBe(logsHref({
      service: "front", level: null, requestId: null, text: null, from: logs.from, to: logs.to, before: null, limit: LOG_QUERY_DEFAULT_LIMIT,
    }, early.id));
    expect(logs.lines[0].href).toContain(`selected=${early.id}`);
  });
});

describe("로그의 상한 — 넘으면 '최근 N줄만'을 드러낸다(조용히 자르지 않는다)", () => {
  function linesFrom(count: number, level: "warning" | "error", startMilliseconds: number) {
    return Array.from({ length: count }, (_, index) => logLine({ level, at: iso(startMilliseconds + index * SECOND), message: `${level}-${index}` }));
  }

  it(`합쳐 ${EVIDENCE_LOG_LINE_LIMIT}줄이면 그대로(안쪽 경계)`, async () => {
    const fake = fakeDependencies({ logs: async (query) => ok(logPage(query.level === "warning" ? linesFrom(40, "warning", DOWN_AT) : linesFrom(60, "error", DOWN_AT + 0.5 * SECOND))) });
    const logs = value((await build(fake, downSources(), "monitor_down")).logs);
    expect(logs.lines).toHaveLength(EVIDENCE_LOG_LINE_LIMIT);
    expect(logs.truncated).toBe(false);
    expect(logs.noticeText).toBeNull();
  });

  it(`${EVIDENCE_LOG_LINE_LIMIT + 1}줄이면 최신 ${EVIDENCE_LOG_LINE_LIMIT}줄만 · 시간순 · 알림 글(바깥 경계)`, async () => {
    const warnings = linesFrom(41, "warning", DOWN_AT - 5 * MINUTE);   // 가장 이른 한 줄이 빠진다
    const errors = linesFrom(60, "error", DOWN_AT);
    const fake = fakeDependencies({ logs: async (query) => ok(logPage(query.level === "warning" ? [...warnings].reverse() : [...errors].reverse())) });
    const logs = value((await build(fake, downSources(), "monitor_down")).logs);
    expect(EVIDENCE_LOG_LINE_LIMIT).toBe(100);
    expect(logs.lines).toHaveLength(100);
    expect(logs.lines[0].message).toBe("warning-1");
    expect(logs.lines[99].message).toBe("error-59");
    expect(logs.lines.map((line) => Date.parse(line.at))).toEqual([...logs.lines.map((line) => Date.parse(line.at))].sort((left, right) => left - right));
    expect(logs.truncated).toBe(true);
    expect(logs.noticeText).toBe("최근 100줄만 보입니다 — 더 있음");
  });

  it("관측 서버가 500줄을 채웠으면(next_before 있음) 줄 수와 무관하게 더 있음", async () => {
    const fake = fakeDependencies({ logs: async (query) => ok(logPage(query.level === "error" ? linesFrom(5, "error", DOWN_AT) : [], { nextBefore: query.level === "error" ? "1-0" : null })) });
    const logs = value((await build(fake, downSources(), "monitor_down")).logs);
    expect(logs.lines).toHaveLength(5);
    expect(logs.truncated).toBe(true);
    expect(logs.noticeText).toBe("최근 100줄만 보입니다 — 더 있음");
  });
});

describe("감시 대상 DOWN — 배포: 앞 1시간(모든 서비스, 받은 이력을 다시 거른다 — 호출 없음)", () => {
  it("창 [T−1시간, T] 에 접수된 배포만(양끝 포함) · 배포 이력의 그 배포로 가는 링크", async () => {
    const inside = [
      deployment({ service: "backend", acceptedAt: iso(DOWN_AT) }),
      deployment({ service: "front", acceptedAt: iso(DOWN_AT - HOUR) }),
    ];
    const outside = [deployment({ service: "front", acceptedAt: iso(DOWN_AT + 1) }), deployment({ service: "llm", acceptedAt: iso(DOWN_AT - HOUR - 1) })];
    const sources = downSources({ deployments: ok([outside[0], ...inside, outside[1]]) });
    const deployments = value((await build(fakeDependencies(), sources, "monitor_down")).deployments);
    expect(deployments).toMatchObject({ kind: "window", from: iso(DOWN_AT - HOUR), to: iso(DOWN_AT), coversWindow: true });
    if (deployments.kind !== "window") throw new Error("window");
    expect(deployments.deployments.map((entry) => entry.requestId)).toEqual(inside.map((entry) => entry.requestId));
    expect(deployments.deployments[0].href).toBe(deploysHref({ service: null, limit: DEPLOY_HISTORY_DEFAULT_LIMIT }, { requestId: inside[0].requestId, service: "backend" }));
  });

  it("이력 200건이 창의 앞쪽에 닿지 못하면 coversWindow false", async () => {
    const recent = Array.from({ length: 200 }, (_, index) => deployment({ acceptedAt: iso(DOWN_AT - index * SECOND) }));
    const deployments = value((await build(fakeDependencies(), downSources({ deployments: ok(recent) }), "monitor_down")).deployments);
    expect(deployments).toMatchObject({ kind: "window", coversWindow: false });
  });
});

describe("감시 대상 DOWN — 자원: 그 서비스가 그때 있던 서버의 값(로그 추적의 자원 칸)", () => {
  it("서비스 · DOWN 시각으로 묻는다", async () => {
    const fake = fakeDependencies();
    const resources = value((await build(fake, downSources(), "monitor_down")).resources);
    expect(fake.traceResources).toHaveBeenCalledTimes(1);
    expect(fake.traceResources).toHaveBeenCalledWith("front", DOWN_AT);
    expect(resources).toMatchObject({ kind: "trace", trace: { service: "front", atMilliseconds: DOWN_AT } });
  });

  it("서버를 찾지 못했으면(location 실패) 자원 칸만 확인하지 못함", async () => {
    const fake = fakeDependencies({ trace: async (service, at) => traceView(service, at, upstreamFailure("timeout")) });
    const evidence = await build(fake, downSources(), "monitor_down");
    expect(evidence.resources).toMatchObject({ state: "failed", failure: { reason: "timeout" } });
    expect(evidenceCellNotice(evidence.resources)).toBe("확인하지 못함 — 닿지 않음(5초 초과)");
    value(evidence.logs);
  });
});

describe("대응 표에 없는 대상 — 서비스 · 서버를 짐작하지 않는다", () => {
  it("로그 · 자원은 '확인할 수 없음 — 대응 표에 없음'(부르지 않는다), 알림 · 배포는 보인다", async () => {
    const fake = fakeDependencies();
    const sources = quietSources({ monitors: ok(monitors([monitor({ name: "deploy-agent-front", status: "DOWN", downSince: iso(DOWN_AT) })])) });
    const evidence = await build(fake, sources, "monitor_down");
    expect(evidence.logs).toEqual({ state: "unmapped" });
    expect(evidence.resources).toEqual({ state: "unmapped" });
    expect(evidenceCellNotice(evidence.logs)).toBe("확인할 수 없음 — 대응 표에 없음");
    expect(fake.logs.searchLogs).not.toHaveBeenCalled();
    expect(fake.traceResources).not.toHaveBeenCalled();
    value(evidence.alertHistory);
    value(evidence.deployments);
  });
});

describe("칸마다 따로 실패한다 — 한 칸이 실패해도 다른 칸은 보인다", () => {
  it("알림 서버 실패 → 관련 알림만", async () => {
    const evidence = await build(fakeDependencies({ alertRecords: async () => UNREACHABLE }), downSources(), "monitor_down");
    expect(evidence.alertHistory).toMatchObject({ state: "failed", failure: { reason: "unreachable", message: "닿지 않음" } });
    expect(evidenceCellNotice(evidence.alertHistory)).toBe("확인하지 못함 — 닿지 않음");
    value(evidence.logs); value(evidence.deployments); value(evidence.resources);
  });

  it("로그 두 번 중 하나라도 실패 → 로그 칸 전체가 그 실패(warning 쪽을 먼저 본다)", async () => {
    const onlyWarningFails = await build(fakeDependencies({ logs: async (query) => (query.level === "warning" ? upstreamFailure("server_timeout", { status: 504 }) : ok(logPage([logLine()]))) }), downSources(), "monitor_down");
    expect(onlyWarningFails.logs).toMatchObject({ state: "failed", failure: { reason: "server_timeout", status: 504 } });
    const onlyErrorFails = await build(fakeDependencies({ logs: async (query) => (query.level === "error" ? UNREACHABLE : ok(logPage([logLine()]))) }), downSources(), "monitor_down");
    expect(onlyErrorFails.logs).toMatchObject({ state: "failed", failure: { reason: "unreachable" } });
    const bothFail = await build(fakeDependencies({ logs: async (query) => (query.level === "warning" ? upstreamFailure("unavailable", { status: 503 }) : UNREACHABLE) }), downSources(), "monitor_down");
    expect(bothFail.logs).toMatchObject({ state: "failed", failure: { reason: "unavailable" } });
    value(bothFail.alertHistory); value(bothFail.deployments); value(bothFail.resources);
  });

  it("배포 이력(목록의 출처)이 실패였으면 배포 칸만 그 실패", async () => {
    const evidence = await build(fakeDependencies(), downSources({ deployments: upstreamFailure("unauthorized", { status: 401 }) }), "monitor_down");
    expect(evidence.deployments).toMatchObject({ state: "failed", failure: { reason: "unauthorized" } });
    value(evidence.alertHistory); value(evidence.logs); value(evidence.resources);
  });

  it("클라이언트가 뜻밖에 거부해도 그 칸만 실패(unparseable) — 묶음은 거부하지 않는다", async () => {
    const fake = fakeDependencies({ alertRecords: () => Promise.reject(new Error("boom")) });
    const evidence = await build(fake, downSources(), "monitor_down");
    expect(evidence.alertHistory).toMatchObject({ state: "failed", failure: { reason: "unparseable" } });
    value(evidence.logs);
  });
});

describe("칸들의 호출은 한꺼번에 시작한다(서로 기다리지 않는다)", () => {
  it("알림 · 로그 두 번 · 자원이 아무것도 끝나기 전에 모두 시작한다", async () => {
    const pending: (() => void)[] = [];
    const hold = <Value>(result: Value) => new Promise<Value>((resolve) => { pending.push(() => resolve(result)); });
    const fake = fakeDependencies({
      alertRecords: () => hold(ok<IncidentSummary[]>([])),
      logs: (query) => hold(ok(logPage([], { from: query.from!, to: query.to! }))),
      trace: (service, at) => hold(traceView(service, at)),
    });
    const built = build(fake, downSources(), "monitor_down");
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    expect(fake.alertRecords.listIncidents).toHaveBeenCalledTimes(1);
    expect(fake.logs.searchLogs).toHaveBeenCalledTimes(2);
    expect(fake.traceResources).toHaveBeenCalledTimes(1);
    for (const release of pending) release();
    const evidence = await built;
    value(evidence.alertHistory); value(evidence.logs); value(evidence.resources);
  });

  it("호출 수의 상한 = 알림 1 + 로그 2 + 자원 칸의 상한(13)", () => {
    expect(INCIDENT_EVIDENCE_MAXIMUM_CALLS).toBe(16);
  });
});

// ── 배포 실패 ────────────────────────────────────────────

const HEAD_SHA = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const ACCEPTED = NOW - 40 * MINUTE;
const FINISHED = NOW - 30 * MINUTE;

function failedDeploySources(overrides: { base?: "success" | "none" | "same" } = {}) {
  const failed = deployment({ requestId: "req-failed-1", service: "backend", state: "failed", failedStage: "ci_test", commitSha: HEAD_SHA, acceptedAt: iso(ACCEPTED), finishedAt: iso(FINISHED) });
  const history = [failed, deployment({ service: "front", state: "succeeded", acceptedAt: iso(ACCEPTED - MINUTE) }),
    deployment({ service: "backend", state: "failed", commitSha: "d".repeat(40), acceptedAt: iso(ACCEPTED - 2 * HOUR) })];
  if (overrides.base !== "none") {
    history.push(deployment({ requestId: "req-base-1", service: "backend", state: "succeeded", commitSha: overrides.base === "same" ? HEAD_SHA : BASE_SHA, acceptedAt: iso(ACCEPTED - 3 * HOUR) }));
  }
  return { failed, sources: quietSources({ deployments: ok(history) }) };
}

describe("배포 실패 — 무엇이 · 언제부터", () => {
  it("서비스 · 커밋 · 요청 ID · 실패 단계(이름) · 접수 · 끝난 시각", async () => {
    const { sources } = failedDeploySources();
    const evidence = await build(fakeDependencies(), sources, "deploy_failed");
    expect(evidence.facts).toEqual([
      { label: "서비스", value: "backend" }, { label: "커밋", value: HEAD_SHA }, { label: "요청 ID", value: "req-failed-1" },
      { label: "실패 단계", value: "ci_test(테스트)" }, { label: "접수 시각", value: iso(ACCEPTED) }, { label: "끝난 시각", value: iso(FINISHED) },
    ]);
  });
});

describe("배포 실패 — 로그는 그 배포의 요청 ID 로 묶은 줄", () => {
  it("request_id 한 번, 수준 거름 없음, 창 [접수 − 10분, 끝 + 10분]", async () => {
    const fake = fakeDependencies();
    const logs = value((await build(fake, failedDeploySources().sources, "deploy_failed")).logs);
    expect(fake.logs.searchLogs).toHaveBeenCalledTimes(1);
    expect(fake.logs.searchLogs).toHaveBeenCalledWith(logQuery({ requestId: "req-failed-1", from: iso(ACCEPTED - 10 * MINUTE), to: iso(FINISHED + 10 * MINUTE) }));
    expect(logs).toMatchObject({ scope: "request", requestId: "req-failed-1", services: null });
  });

  it("다른 요청 ID 의 줄을 섞지 않는다(받은 줄 중 그 요청 ID 인 것만)", async () => {
    const fake = fakeDependencies({ logs: async () => ok(logPage([
      logLine({ requestId: "req-failed-1", message: "테스트 실패", level: "info" }), logLine({ requestId: "req-other", message: "남의 줄" }),
    ])) });
    const logs = value((await build(fake, failedDeploySources().sources, "deploy_failed")).logs);
    expect(logs.lines.map((line) => line.message)).toEqual(["테스트 실패"]);
  });
});

describe("배포 실패 — 배포: 앞 성공 배포와의 사이의 커밋", () => {
  it("같은 서비스의 앞 성공 배포(실패는 건너뜀)를 A 로, master git 커밋 목록 한 번", async () => {
    const commits: GitCommitRange = { commits: [
      { sha: HEAD_SHA, authorName: "jun", authoredAt: iso(NOW - HOUR), subject: "고침", body: "", bodyTruncated: false },
    ], truncated: false, rangeComplete: true, relation: "ancestor" };
    const fake = fakeDependencies({ commits: async () => ok(commits) });
    const { failed, sources } = failedDeploySources();
    const deployments = value((await build(fake, sources, "deploy_failed")).deployments);
    expect(fake.deployGit.listCommits).toHaveBeenCalledTimes(1);
    expect(fake.deployGit.listCommits).toHaveBeenCalledWith("backend", BASE_SHA, HEAD_SHA);
    expect(deployments).toMatchObject({
      kind: "range", status: "range", baseRequestId: "req-base-1", baseCommitSha: BASE_SHA, headCommitSha: HEAD_SHA, truncated: false, relation: "ancestor",
      detailHref: deploysHref({ service: null, limit: DEPLOY_HISTORY_DEFAULT_LIMIT }, { requestId: failed.requestId, service: "backend" }),
    });
    if (deployments.kind !== "range") throw new Error("range");
    expect(deployments.commits.map((commit) => commit.subject)).toEqual(["고침"]);
  });

  it("앞 성공 배포가 받은 200건 안에 없으면 부르지 않는다(no_previous)", async () => {
    const fake = fakeDependencies();
    const deployments = value((await build(fake, failedDeploySources({ base: "none" }).sources, "deploy_failed")).deployments);
    expect(fake.deployGit.listCommits).not.toHaveBeenCalled();
    expect(deployments).toMatchObject({ kind: "range", status: "no_previous", baseRequestId: null, commits: [] });
    expect(EVIDENCE_TEXT.noPreviousDeploy).toBe("앞 성공 배포가 배포 이력 최근 200건 안에 없습니다");
  });

  it("같은 커밋이면 부르지 않는다(same_commit)", async () => {
    const fake = fakeDependencies();
    const deployments = value((await build(fake, failedDeploySources({ base: "same" }).sources, "deploy_failed")).deployments);
    expect(fake.deployGit.listCommits).not.toHaveBeenCalled();
    expect(deployments).toMatchObject({ kind: "range", status: "same_commit", commits: [] });
  });

  it("커밋 조회가 실패하면 배포 칸만 실패", async () => {
    const evidence = await build(fakeDependencies({ commits: async () => upstreamFailure("history_changing", { status: 503 }) }), failedDeploySources().sources, "deploy_failed");
    expect(evidence.deployments).toMatchObject({ state: "failed", failure: { reason: "history_changing" } });
    value(evidence.logs); value(evidence.alertHistory); value(evidence.resources);
  });
});

describe("배포 실패 — 관련 알림 · 자원", () => {
  it("관련 알림은 key `deploy-failed:<서비스>:<커밋>` · 창 [접수, 끝 + 10분]", async () => {
    const key = `deploy-failed:backend:${HEAD_SHA}`;
    const records = [
      alertRecord({ at: iso(FINISHED + 10 * MINUTE + 1), kind: "event", key, title: "창 뒤" }),
      alertRecord({ at: iso(FINISHED), kind: "event", key, title: "그 배포" }),
      alertRecord({ at: iso(FINISHED), kind: "event", key: `deploy-failed:front:${HEAD_SHA}`, title: "다른 서비스" }),
      alertRecord({ at: iso(ACCEPTED - 1), kind: "event", key, title: "창 앞" }),
    ];
    const history = value((await build(fakeDependencies({ alertRecords: async () => ok(records) }), failedDeploySources().sources, "deploy_failed")).alertHistory);
    expect(history.records.map((record) => record.title)).toEqual(["그 배포"]);
    expect([history.from, history.to]).toEqual([iso(ACCEPTED), iso(FINISHED + 10 * MINUTE)]);
  });

  it("자원은 그 서비스 · 끝난 시각으로", async () => {
    const fake = fakeDependencies();
    await build(fake, failedDeploySources().sources, "deploy_failed");
    expect(fake.traceResources).toHaveBeenCalledWith("backend", FINISHED);
  });
});

// ── 자원 임계값 ──────────────────────────────────────────

const FIRING_SINCE = NOW - 30 * MINUTE;
const thresholdSources = (overrides: Partial<IncidentSources> = {}) => quietSources({
  latest: ok(latest([
    serverLatest("s158", { containers: [
      { name: "front-app-green", seriesName: "front-app", state: "running", cpuPct: 1, memUsed: 1, restarts: 0 },
      { name: "observe-app-blue", seriesName: "observe-app", state: "running", cpuPct: 1, memUsed: 1, restarts: 0 },
      { name: "ci-cd-agent", seriesName: "ci-cd-agent", state: "running", cpuPct: 1, memUsed: 1, restarts: 0 },
    ] }),
    serverLatest("s9"),
  ], [firing({ server: "s158", rule: "disk_warning", severity: "warning", since: iso(FIRING_SINCE), lastValue: 86.2 })])),
  ...overrides,
});

describe("자원 임계값 — 무엇이 · 관련 알림 · 로그 · 자원", () => {
  it("서버 · 규칙 · 대상 · 심각도 · 값 · 언제부터", async () => {
    const evidence = await build(fakeDependencies(), thresholdSources(), "resource_threshold");
    expect(evidence.facts).toEqual([
      { label: "서버", value: "s158" }, { label: "규칙", value: "디스크 경고" }, { label: "대상", value: "—" },
      { label: "심각도", value: "경고" }, { label: "값", value: "86.2%" }, { label: "언제부터", value: iso(FIRING_SINCE) },
    ]);
  });

  it("관련 알림은 그 서버 · 규칙의 key(그 뒤 :resolved 포함), 창 [since − 1시간, 지금]", async () => {
    const records = [
      alertRecord({ kind: "event", key: "resource:s158:disk_warning:resolved", title: "해소", at: iso(NOW - MINUTE) }),
      alertRecord({ kind: "event", key: "resource:s158:disk_warning", title: "넘음", at: iso(FIRING_SINCE) }),
      alertRecord({ kind: "event", key: "resource:s158:disk_warning_extra", title: "다른 규칙 이름", at: iso(FIRING_SINCE) }),
      alertRecord({ kind: "event", key: "resource:s1580:disk_warning", title: "다른 서버", at: iso(FIRING_SINCE) }),
      alertRecord({ kind: "event", key: "resource:s158:disk_warning", title: "창 앞", at: iso(FIRING_SINCE - HOUR - 1) }),
    ];
    const history = value((await build(fakeDependencies({ alertRecords: async () => ok(records) }), thresholdSources(), "resource_threshold")).alertHistory);
    expect(history.records.map((record) => record.title)).toEqual(["해소", "넘음"]);
    expect([history.from, history.to]).toEqual([iso(FIRING_SINCE - HOUR), iso(NOW)]);
  });

  it("로그는 warning · error 두 번(서비스 거름 없음) → 그 서버의 서비스들(배포 서비스 이름)의 줄만", async () => {
    const fake = fakeDependencies({ logs: async (query) => ok(logPage(query.level === "error" ? [
      logLine({ service: "front", message: "그 서버 front" }), logLine({ service: "backend", message: "다른 서버 backend" }),
      logLine({ service: "observe", message: "그 서버 observe" }),
    ] : [])) });
    const logs = value((await build(fake, thresholdSources(), "resource_threshold")).logs);
    const window = { from: iso(FIRING_SINCE - 10 * MINUTE), to: iso(FIRING_SINCE + 10 * MINUTE) };
    expect(fake.logs.searchLogs.mock.calls.map(([query]) => query)).toEqual(expect.arrayContaining([
      logQuery({ ...window, level: "warning" }), logQuery({ ...window, level: "error" }),
    ]));
    expect(logs.services).toEqual(["front", "observe"]);
    expect(logs.lines.map((line) => line.message).sort()).toEqual(["그 서버 front", "그 서버 observe"]);
  });

  it("자원은 그 서버의 지금 값 + 서버 자원 화면의 그 서버로 가는 링크(호출 없음)", async () => {
    const fake = fakeDependencies();
    const resources = value((await build(fake, thresholdSources(), "resource_threshold")).resources);
    expect(fake.traceResources).not.toHaveBeenCalled();
    expect(resources).toEqual({
      kind: "server", server: "s158", found: true, cpuText: "3.4%", memoryText: "12.5%", diskText: "86.0%", receivedAt: iso(NOW - 19 * SECOND),
      resourcesHref: "/resources?range=1h#resource-server-s158",
    });
  });
});

describe("자원 임계값 — 관련 알림은 대상까지 맞춘다(key 가 같거나 그 뒤에 `:resolved` 만)", () => {
  async function keptKeys(rule: { rule: string; target: string | null }, keys: string[]): Promise<string[]> {
    const sources = quietSources({ latest: ok(latest([serverLatest("s")], [firing({ server: "s", ...rule, since: iso(FIRING_SINCE) })])) });
    const records = keys.map((key) => alertRecord({ kind: "event", key, title: key, at: iso(FIRING_SINCE) }));
    const history = value((await build(fakeDependencies({ alertRecords: async () => ok(records) }), sources, "resource_threshold")).alertHistory);
    return history.records.map((record) => record.key);
  }

  it("대상이 있는 규칙 — 그 대상의 key 와 그 :resolved 만(다른 대상 · 대상 이름의 접두는 아니다)", async () => {
    expect(await keptKeys({ rule: "restarts", target: "front-app-green" }, [
      "resource:s:restarts:front-app-green", "resource:s:restarts:front-app-green:resolved",
      "resource:s:restarts:backend-app-blue", "resource:s:restarts:front-app-green-2", "resource:s:restarts",
    ])).toEqual(["resource:s:restarts:front-app-green", "resource:s:restarts:front-app-green:resolved"]);
  });

  it("대상이 없는 규칙 — 그 key 와 그 :resolved 만(이름이 이어지는 다른 규칙 · 뒤에 다른 부분이 붙은 key 는 아니다)", async () => {
    expect(await keptKeys({ rule: "disk", target: null }, [
      "resource:s:disk", "resource:s:disk:resolved", "resource:s:disk_warning", "resource:s:disk:무엇",
    ])).toEqual(["resource:s:disk", "resource:s:disk:resolved"]);
  });
});

describe("자원 임계값 — 그 서버의 서비스를 찾지 못하면 로그 칸은 '확인할 수 없음'(없음이라고 말하지 않는다)", () => {
  it.each([
    ["그 서버의 컨테이너 목록이 비었다", [serverLatest("s158", { containers: [] })]],
    ["그 서버가 지금 지표를 보낸 서버 목록에 없다", [serverLatest("s9")]],
  ])("%s → 로그 칸의 글은 '확인할 수 없음 — 그 서버의 서비스를 찾지 못함' 한 줄", async (_label, servers) => {
    const sources = quietSources({ latest: ok(latest(servers, [firing({ server: "s158", rule: "disk_warning", since: iso(FIRING_SINCE) })])) });
    const fake = fakeDependencies({ logs: async () => ok(logPage([logLine({ service: "front", message: "다른 서버의 줄" })])) });
    const evidence = await build(fake, sources, "resource_threshold");
    expect(evidence.logs.state).not.toBe("value");
    expect(evidenceCellNotice(evidence.logs)).toBe("확인할 수 없음 — 그 서버의 서비스를 찾지 못함");
  });
});

// ── 오류 로그 ────────────────────────────────────────────

describe("오류 로그 — 오류 줄 · 앞 1시간의 배포 · 그 서버의 그때 값 · 관련 알림 없음", () => {
  const errorSources = () => quietSources({ errorLogs: ok(logPage([logLine({ service: "llm" }), logLine({ service: "llm" })])) });

  it("무엇이 = 서비스 · 최근 10분의 오류 수", async () => {
    const evidence = await build(fakeDependencies(), errorSources(), "error_logs");
    expect(evidence.facts).toEqual([{ label: "서비스", value: "llm" }, { label: "최근 10분의 오류 수", value: "오류 2건" }]);
  });

  it("관련 알림은 해당 없음(알림 서버를 부르지 않는다)", async () => {
    const fake = fakeDependencies();
    const evidence = await build(fake, errorSources(), "error_logs");
    expect(evidence.alertHistory).toEqual({ state: "not_applicable" });
    expect(evidenceCellNotice(evidence.alertHistory)).toBe("해당 없음");
    expect(fake.alertRecords.listIncidents).not.toHaveBeenCalled();
  });

  it("로그는 그 서비스의 error 한 번, 창 [지금 − 10분, 지금]", async () => {
    const fake = fakeDependencies();
    const logs = value((await build(fake, errorSources(), "error_logs")).logs);
    expect(fake.logs.searchLogs).toHaveBeenCalledTimes(1);
    expect(fake.logs.searchLogs).toHaveBeenCalledWith(logQuery({ service: "llm", level: "error", from: iso(NOW - 10 * MINUTE), to: iso(NOW) }));
    expect(logs).toMatchObject({ scope: "errors", services: ["llm"] });
  });

  it("배포는 앞 1시간(지금 기준) · 자원은 그 서비스의 지금", async () => {
    const fake = fakeDependencies();
    const evidence = await build(fake, errorSources(), "error_logs");
    expect(value(evidence.deployments)).toMatchObject({ kind: "window", from: iso(NOW - HOUR), to: iso(NOW) });
    expect(fake.traceResources).toHaveBeenCalledWith("llm", NOW);
  });
});

describe("evidenceCellNotice", () => {
  it("값이면 null", () => {
    expect(evidenceCellNotice({ state: "value", value: 1 })).toBeNull();
  });
});
