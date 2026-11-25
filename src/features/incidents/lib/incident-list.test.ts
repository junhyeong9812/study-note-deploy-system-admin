/** 열린 문제의 목록(순수) — 명세 ⑫ §2 "열린 문제의 출처는 넷 … 급증 판정을 꾸며 내지 않는다" · "조회가 실패한 칸은 그 칸만 확인하지 못함". */
import { describe, expect, it } from "vitest";
import {
  INCIDENT_LIST_TEXT, errorCountText, isUncovered, openIncidentsFrom, scopeNotesFrom, uncoveredScopes,
  type IncidentList, type IncidentSources, type OpenIncident, type UncoveredScopes,
} from "@/features/incidents/lib/incident-list";
import { deployIncidentId, errorLogsIncidentId, monitorIncidentId, resourceIncidentId } from "@/features/incidents/lib/incident-id";
import {
  HOUR, MINUTE, NOW, UNREACHABLE, deployment, firing, iso, latest, logLine, logPage, monitor, monitors, ok, quietSources, serverLatest,
} from "@/features/incidents/lib/incidents-test-fakes";
import { upstreamFailure } from "@/shared/lib/upstream-result";

function ids(list: IncidentList): string[] {
  return list.incidents.map((incident) => incident.id);
}

function only<Kind extends OpenIncident["kind"]>(list: IncidentList, kind: Kind): Extract<OpenIncident, { kind: Kind }>[] {
  return list.incidents.filter((incident): incident is Extract<OpenIncident, { kind: Kind }> => incident.kind === kind);
}

describe("감시 대상 DOWN — 상태가 DOWN 인 대상마다 하나", () => {
  it("DOWN 둘 · UP · UNKNOWN(사유 있음) → DOWN 둘만", () => {
    const list = openIncidentsFrom(quietSources({ monitors: ok(monitors([
      monitor({ name: "front", status: "DOWN", downSince: iso(NOW - 20 * MINUTE), reason: "status 502" }),
      monitor({ name: "backend", status: "UP", reason: "1번 실패" }),
      monitor({ name: "llm", status: "UNKNOWN", reason: "연결 실패" }),
      monitor({ name: "deploy-master", status: "DOWN", downSince: iso(NOW - 5 * MINUTE), reason: "꺼짐" }),
    ])) }));
    expect(ids(list)).toEqual([monitorIncidentId("front"), monitorIncidentId("deploy-master")]);
    const [front, deployMaster] = only(list, "monitor_down");
    expect(front).toMatchObject({ kindLabel: "감시 대상 DOWN", target: "front", severity: "critical", severityLabel: "위험", since: iso(NOW - 20 * MINUTE), service: "front" });
    expect(front.monitor.reason).toBe("status 502");
    expect(deployMaster.service).toBeNull();   // 대응 표에 없음 — 짐작하지 않는다
  });

  it("DOWN 시각이 없으면(down_since 빈 글자) since null — 지어내지 않는다", () => {
    const list = openIncidentsFrom(quietSources({ monitors: ok(monitors([monitor({ name: "front", status: "DOWN", downSince: null })])) }));
    expect(list.incidents[0].since).toBeNull();
  });
});

describe("자원 임계값 — 지금 울리는 것마다 하나", () => {
  it("울리는 규칙 셋 → 셋, 대상 · 심한 정도 · 언제부터는 받은 값", () => {
    const list = openIncidentsFrom(quietSources({ latest: ok(latest([serverLatest("s158")], [
      firing({ server: "s158", rule: "disk_critical", severity: "critical", since: iso(NOW - 3 * HOUR), lastValue: 96.1 }),
      firing({ server: "s9", rule: "restarts", target: "front-app-green", severity: "warning", since: iso(NOW - 10 * MINUTE), lastValue: 4 }),
      firing({ server: "s164", rule: "brand_new_rule", severity: "notice", since: iso(NOW - MINUTE), lastValue: null }),
    ])) }));
    expect(ids(list)).toEqual([
      resourceIncidentId("s158", "disk_critical", null), resourceIncidentId("s9", "restarts", "front-app-green"), resourceIncidentId("s164", "brand_new_rule", null),
    ]);
    const [disk, restarts, unknownRule] = only(list, "resource_threshold");
    expect(disk).toMatchObject({ kindLabel: "자원 임계값", target: "서버 s158 디스크 위험", severity: "critical", severityLabel: "위험", ruleLabel: "디스크 위험" });
    expect(restarts).toMatchObject({ target: "서버 s9 컨테이너 재시작 반복 front-app-green", severity: "warning", severityLabel: "경고" });
    // 모르는 규칙 · 심각도 낱말은 낱말 그대로 보이고, 심한 정도는 경고로 친다(위험으로 올리지 않는다)
    expect(unknownRule).toMatchObject({ target: "서버 s164 brand_new_rule", severity: "warning", ruleLabel: "brand_new_rule" });
  });

  it("firing 칸이 없으면(null) 임계값 출처만 확인하지 못함 — 다른 출처의 문제는 보인다", () => {
    const list = openIncidentsFrom(quietSources({
      latest: ok(latest([serverLatest("s158")], null)),
      monitors: ok(monitors([monitor({ name: "front", status: "DOWN", downSince: iso(NOW - MINUTE) })])),
    }));
    expect(ids(list)).toEqual([monitorIncidentId("front")]);
    expect(list.unchecked).toEqual([{
      source: "thresholds", label: "관측 서버(자원 임계값)", message: "임계값 칸 없음", text: "관측 서버(자원 임계값): 확인하지 못함 — 임계값 칸 없음",
    }]);
  });
});

describe("배포 실패 — 서비스의 가장 최근 배포가 실패일 때만", () => {
  it("가장 최근이 실패 → 문제 하나(그 배포)", () => {
    const failed = deployment({ service: "backend", state: "failed", failedStage: "ci_test", acceptedAt: iso(NOW - 30 * MINUTE), finishedAt: iso(NOW - 25 * MINUTE) });
    const list = openIncidentsFrom(quietSources({ deployments: ok([failed, deployment({ service: "backend", state: "succeeded" })]) }));
    expect(ids(list)).toEqual([deployIncidentId("backend", failed.requestId)]);
    expect(only(list, "deploy_failed")[0]).toMatchObject({
      kindLabel: "배포 실패", target: "backend", severity: "warning", severityLabel: "경고", since: iso(NOW - 25 * MINUTE), deployment: failed,
    });
  });

  it("실패 뒤에 성공한 배포가 있으면 열린 문제가 아니다(가장 최근이 아닌 실패는 보지 않는다)", () => {
    const list = openIncidentsFrom(quietSources({ deployments: ok([
      deployment({ service: "backend", state: "succeeded", acceptedAt: iso(NOW - 10 * MINUTE) }),
      deployment({ service: "backend", state: "failed", failedStage: "cd_health", acceptedAt: iso(NOW - 40 * MINUTE) }),
      deployment({ service: "backend", state: "failed", failedStage: "ci_test", acceptedAt: iso(NOW - 50 * MINUTE) }),
    ]) }));
    expect(only(list, "deploy_failed")).toEqual([]);
  });

  it("가장 최근이 진행 중이면 열린 문제가 아니다 — 그 앞의 실패도 치지 않는다(다시 배포하는 중)", () => {
    for (const state of ["accepted", "ci_running", "cd_running"] as const) {
      const list = openIncidentsFrom(quietSources({ deployments: ok([
        deployment({ service: "front", state, finishedAt: null, acceptedAt: iso(NOW - MINUTE) }),
        deployment({ service: "front", state: "failed", failedStage: "ci_build", acceptedAt: iso(NOW - 20 * MINUTE) }),
      ]) }));
      expect(only(list, "deploy_failed"), state).toEqual([]);
    }
  });

  it("서비스마다 따로 본다 — 다른 서비스의 성공이 이 서비스의 실패를 닫지 않는다", () => {
    const frontFailed = deployment({ service: "front", state: "failed", failedStage: "ci_fetch", acceptedAt: iso(NOW - 30 * MINUTE), finishedAt: iso(NOW - 29 * MINUTE) });
    const list = openIncidentsFrom(quietSources({ deployments: ok([
      deployment({ service: "backend", state: "succeeded", acceptedAt: iso(NOW - MINUTE) }),
      frontFailed,
      deployment({ service: "backend", state: "failed", acceptedAt: iso(NOW - 2 * HOUR) }),
    ]) }));
    expect(ids(list)).toEqual([deployIncidentId("front", frontFailed.requestId)]);
  });

  it("끝난 시각이 없는 실패는 접수 시각을 언제부터로", () => {
    const failed = deployment({ service: "llm", state: "failed", acceptedAt: iso(NOW - 7 * MINUTE), finishedAt: null });
    const list = openIncidentsFrom(quietSources({ deployments: ok([failed]) }));
    expect(list.incidents[0].since).toBe(iso(NOW - 7 * MINUTE));
  });
});

describe("오류 로그 — 최근 10분의 오류 수가 0 보다 큰 서비스마다(수만 — 급증 판정 없음)", () => {
  it("서비스별로 센다 · 0 인 서비스는 없다 · since 없음", () => {
    const list = openIncidentsFrom(quietSources({ errorLogs: ok(logPage([
      logLine({ service: "backend" }), logLine({ service: "backend" }), logLine({ service: "backend" }), logLine({ service: "llm" }),
    ])) }));
    expect(ids(list)).toEqual([errorLogsIncidentId("backend"), errorLogsIncidentId("llm")]);
    const [backend, llm] = only(list, "error_logs");
    expect(backend).toMatchObject({ kindLabel: "오류 로그", target: "backend", service: "backend", errorCount: 3, countIsLowerBound: false, since: null, severity: "warning" });
    expect(llm.errorCount).toBe(1);
    expect(list.errorLogsTruncated).toBe(false);
  });

  it("오류 줄이 없으면 오류 로그 문제는 없다", () => {
    expect(only(openIncidentsFrom(quietSources()), "error_logs")).toEqual([]);
  });

  it("응답이 상한을 채웠으면(next_before 있음) 수는 '이상' · 목록에 일부만 셈을 드러낸다", () => {
    const lines = Array.from({ length: 500 }, (_, index) => logLine({ service: index < 499 ? "backend" : "front" }));
    const list = openIncidentsFrom(quietSources({ errorLogs: ok(logPage(lines, { nextBefore: "1764050000000-0" })) }));
    expect(only(list, "error_logs").map((incident) => [incident.service, incident.errorCount, incident.countIsLowerBound])).toEqual([
      ["backend", 499, true], ["front", 1, true],
    ]);
    expect(list.errorLogsTruncated).toBe(true);
    expect(INCIDENT_LIST_TEXT.errorLogsTruncated).toBe("최근 10분의 오류가 500건을 넘어 일부 서비스만 셌습니다");
  });

  it("오류 수의 글 — 'N건' · 'N건 이상', '급증'이라는 낱말을 쓰지 않는다", () => {
    expect(errorCountText(3, false)).toBe("오류 3건");
    expect(errorCountText(500, true)).toBe("오류 500건 이상");
    const list = openIncidentsFrom(quietSources({ errorLogs: ok(logPage(Array.from({ length: 300 }, () => logLine({ service: "backend" })))) }));
    expect(JSON.stringify(list)).not.toContain("급증");
  });
});

describe("한 출처의 실패는 그 출처만 '확인하지 못함'", () => {
  const openEverywhere = () => quietSources({
    monitors: ok(monitors([monitor({ name: "front", status: "DOWN", downSince: iso(NOW - MINUTE) })])),
    latest: ok(latest([serverLatest("s158")], [firing({ server: "s158" })])),
    deployments: ok([deployment({ service: "backend", state: "failed", acceptedAt: iso(NOW - 2 * MINUTE), finishedAt: iso(NOW - MINUTE) })]),
    errorLogs: ok(logPage([logLine({ service: "llm" })])),
  });

  it.each([
    ["monitors", "알림 서버(감시 대상)", "monitor_down"],
    ["latest", "관측 서버(자원 임계값)", "resource_threshold"],
    ["deployments", "배포 서버(배포 이력)", "deploy_failed"],
    ["errorLogs", "관측 서버(오류 로그)", "error_logs"],
  ] as const)("%s 실패 → 그 종류만 빠지고 나머지 셋은 보인다 · 목록 위에 '%s: 확인하지 못함 — 닿지 않음'", (source, label, missingKind) => {
    const list = openIncidentsFrom({ ...openEverywhere(), [source]: UNREACHABLE });
    expect(list.incidents.map((incident) => incident.kind).sort()).toEqual(
      ["deploy_failed", "error_logs", "monitor_down", "resource_threshold"].filter((kind) => kind !== missingKind),
    );
    expect(list.unchecked.map((failure) => failure.text)).toEqual([`${label}: 확인하지 못함 — 닿지 않음`]);
    expect(list.emptyText).toBeNull();
  });

  it("실패가 여럿이면 출처 순서(감시 대상 · 임계값 · 배포 · 오류 로그)대로, 실패의 고정 글자만", () => {
    const list = openIncidentsFrom({
      ...openEverywhere(), errorLogs: upstreamFailure("timeout"), monitors: upstreamFailure("unauthorized", { status: 401 }),
    });
    expect(list.unchecked.map((failure) => [failure.source, failure.message])).toEqual([["monitors", "비밀값 거절됨"], ["errorLogs", "닿지 않음(5초 초과)"]]);
  });
});

describe("빈 목록의 말", () => {
  it("출처가 모두 성공이고 문제가 없으면 '열린 문제가 없습니다'", () => {
    const list = openIncidentsFrom(quietSources());
    expect(list.incidents).toEqual([]);
    expect(list.unchecked).toEqual([]);
    expect(list.emptyText).toBe("열린 문제가 없습니다");
  });

  it("출처 가운데 실패가 있으면 그 말을 하지 않는다 — '확인된 범위에서는 열린 문제가 없습니다'", () => {
    const list = openIncidentsFrom(quietSources({ deployments: UNREACHABLE }));
    expect(list.emptyText).toBe("확인된 범위에서는 열린 문제가 없습니다");
    expect(list.emptyText).not.toBe(INCIDENT_LIST_TEXT.empty);
  });

  it("firing 칸이 없는 것도 실패로 친다", () => {
    expect(openIncidentsFrom(quietSources({ latest: ok(latest([], null)) })).emptyText).toBe("확인된 범위에서는 열린 문제가 없습니다");
  });
});

describe("목록이 확인한 범위를 드러낸다(scopeNotes — 감시 대상 줄 · 배포 줄 차례)", () => {
  const DEPLOY_NOTE_ALL_BUT_FRONT = "배포: 최근 200건 안에서만 확인 — backend, llm, alert, observe, admin 은 확인하지 못함";

  function frontDeployments(count: number) {
    return Array.from({ length: count }, (_, index) => deployment({ service: "front", acceptedAt: iso(NOW - HOUR - index * MINUTE) }));
  }

  it("배포 이력이 200건이고 그 안에 보이지 않은 서비스가 있으면 그 서비스들(DEPLOY_SERVICES 차례)을 적는다", () => {
    const list = openIncidentsFrom(quietSources({ deployments: ok(frontDeployments(200)) }));
    expect(list.scopeNotes).toEqual([DEPLOY_NOTE_ALL_BUT_FRONT]);
  });

  it("보이지 않은 서비스의 차례는 받은 차례가 아니라 정해진 차례", () => {
    const deployments = [...frontDeployments(197), deployment({ service: "admin" }), deployment({ service: "llm" }), deployment({ service: "backend" })];
    const list = openIncidentsFrom(quietSources({ deployments: ok(deployments) }));
    expect(list.scopeNotes).toEqual(["배포: 최근 200건 안에서만 확인 — alert, observe 은 확인하지 못함"]);
  });

  it("200건이어도 모든 서비스가 보였으면 배포 줄이 없다", () => {
    const services = ["front", "backend", "llm", "alert", "observe", "admin"];
    const deployments = Array.from({ length: 200 }, (_, index) => deployment({ service: services[index % services.length] }));
    expect(openIncidentsFrom(quietSources({ deployments: ok(deployments) })).scopeNotes).toEqual([]);
  });

  it("199건이면(상한을 채우지 않았다) 배포 줄이 없다", () => {
    expect(openIncidentsFrom(quietSources({ deployments: ok(frontDeployments(199)) })).scopeNotes).toEqual([]);
  });

  it("감시 대상 가운데 상태를 아직 모르는 것(UNKNOWN)이 N개면 그 수를 적는다", () => {
    const list = openIncidentsFrom(quietSources({ monitors: ok(monitors([
      monitor({ name: "front", status: "UNKNOWN" }), monitor({ name: "backend", status: "UP" }), monitor({ name: "llm", status: "UNKNOWN", reason: "연결 실패" }),
    ])) }));
    expect(list.scopeNotes).toEqual(["감시 대상 2개는 아직 상태를 모름"]);
  });

  it("둘 다 있으면 감시 대상 줄 · 배포 줄 차례", () => {
    const list = openIncidentsFrom(quietSources({
      monitors: ok(monitors([monitor({ name: "front", status: "UNKNOWN" })])), deployments: ok(frontDeployments(200)),
    }));
    expect(list.scopeNotes).toEqual(["감시 대상 1개는 아직 상태를 모름", DEPLOY_NOTE_ALL_BUT_FRONT]);
  });

  it("확인한 범위의 줄이 있고 문제가 없으면 빈 목록의 말은 '확인된 범위에서는 열린 문제가 없습니다'", () => {
    expect(openIncidentsFrom(quietSources({ deployments: ok(frontDeployments(200)) })).emptyText).toBe(INCIDENT_LIST_TEXT.emptyWithinChecked);
    expect(openIncidentsFrom(quietSources({ monitors: ok(monitors([monitor({ name: "front", status: "UNKNOWN" })])) })).emptyText)
      .toBe("확인된 범위에서는 열린 문제가 없습니다");
  });

  it("출처가 모두 성공이고 범위의 줄도 없으면 그대로 '열린 문제가 없습니다' · 줄 없음", () => {
    const list = openIncidentsFrom(quietSources());
    expect(list.scopeNotes).toEqual([]);
    expect(list.emptyText).toBe("열린 문제가 없습니다");
  });

  it("출처가 실패했으면 그 출처의 범위 줄은 없다(확인하지 못함 줄이 이미 있다)", () => {
    expect(openIncidentsFrom(quietSources({ monitors: UNREACHABLE, deployments: UNREACHABLE })).scopeNotes).toEqual([]);
  });
});

// ── 덮지 못한 범위(명세 ⑫ §12 1) ─────────────────────────

const NONE = { all: false, names: [] };
function scopes(overrides: Partial<Record<keyof UncoveredScopes, { all: boolean; names: string[] }>> = {}): UncoveredScopes {
  return { monitor_down: NONE, deploy_failed: NONE, resource_threshold: NONE, error_logs: NONE, ...overrides };
}

function serviceDeployments(services: string[], count: number) {
  return Array.from({ length: count }, (_, index) => deployment({ service: services[index % services.length], acceptedAt: iso(NOW - HOUR - index * MINUTE) }));
}

const FULL_ERROR_PAGE = logPage(Array.from({ length: 500 }, () => logLine({ service: "llm" })), { nextBefore: "cursor" });

describe("uncoveredScopes — 출처마다 덮지 못한 범위를 한 값으로", () => {
  it("출처가 모두 성공이고 상한 · 모르는 상태가 없으면 어느 종류도 덮지 못한 범위가 없다", () => {
    expect(uncoveredScopes(quietSources())).toEqual(scopes());
  });

  it("출처 전체 실패 → 그 종류 all · firing 칸이 없어도 자원 임계값 all", () => {
    expect(uncoveredScopes(quietSources({ monitors: UNREACHABLE }))).toEqual(scopes({ monitor_down: { all: true, names: [] } }));
    expect(uncoveredScopes(quietSources({ deployments: UNREACHABLE }))).toEqual(scopes({ deploy_failed: { all: true, names: [] } }));
    expect(uncoveredScopes(quietSources({ latest: UNREACHABLE }))).toEqual(scopes({ resource_threshold: { all: true, names: [] } }));
    expect(uncoveredScopes(quietSources({ latest: ok(latest([], null)) }))).toEqual(scopes({ resource_threshold: { all: true, names: [] } }));
    expect(uncoveredScopes(quietSources({ errorLogs: UNREACHABLE }))).toEqual(scopes({ error_logs: { all: true, names: [] } }));
  });

  it("오류 로그가 상한을 채웠으면 오류 로그 all(목록에 없는 서비스는 셈에서 빠졌을 수 있다)", () => {
    expect(uncoveredScopes(quietSources({ errorLogs: ok(FULL_ERROR_PAGE) }))).toEqual(scopes({ error_logs: { all: true, names: [] } }));
  });

  it("배포 이력이 200건이면 그 안에 보이지 않은 서비스(DEPLOY_SERVICES 차례) · 199건이면 없음 · 모두 보였으면 없음", () => {
    expect(uncoveredScopes(quietSources({ deployments: ok(serviceDeployments(["observe", "front"], 200)) })).deploy_failed)
      .toEqual({ all: false, names: ["backend", "llm", "alert", "admin"] });
    expect(uncoveredScopes(quietSources({ deployments: ok(serviceDeployments(["front"], 199)) })).deploy_failed).toEqual(NONE);
    expect(uncoveredScopes(quietSources({ deployments: ok(serviceDeployments(["front", "backend", "llm", "alert", "observe", "admin"], 200)) })).deploy_failed).toEqual(NONE);
  });

  it("상태를 모르는 감시 대상(UNKNOWN)의 이름(받은 차례) — UP · DOWN 은 아니다", () => {
    const sources = quietSources({ monitors: ok(monitors([
      monitor({ name: "llm", status: "UNKNOWN" }), monitor({ name: "front", status: "UP" }), monitor({ name: "backend", status: "DOWN" }), monitor({ name: "alert", status: "UNKNOWN" }),
    ])) });
    expect(uncoveredScopes(sources).monitor_down).toEqual({ all: false, names: ["llm", "alert"] });
  });

  it("목록은 같은 값을 싣는다(list.uncovered = uncoveredScopes(sources))", () => {
    const sources = quietSources({ monitors: ok(monitors([monitor({ name: "front", status: "UNKNOWN" })])), deployments: ok(serviceDeployments(["front"], 200)), errorLogs: UNREACHABLE });
    expect(openIncidentsFrom(sources).uncovered).toEqual(uncoveredScopes(sources));
  });
});

describe("scopeNotesFrom — 목록의 범위 줄은 덮지 못한 범위의 값에서 나온다", () => {
  it("값이 비면 줄이 없다", () => {
    expect(scopeNotesFrom(scopes())).toEqual([]);
  });

  it("감시 대상 이름 수 → '감시 대상 N개는 아직 상태를 모름'(값을 바꾸면 글이 바뀐다)", () => {
    expect(scopeNotesFrom(scopes({ monitor_down: { all: false, names: ["a"] } }))).toEqual(["감시 대상 1개는 아직 상태를 모름"]);
    expect(scopeNotesFrom(scopes({ monitor_down: { all: false, names: ["a", "b", "c"] } }))).toEqual(["감시 대상 3개는 아직 상태를 모름"]);
  });

  it("배포의 이름 → 그 서비스들(DEPLOY_SERVICES 차례), 감시 대상 줄 다음", () => {
    expect(scopeNotesFrom(scopes({ deploy_failed: { all: false, names: ["llm"] } }))).toEqual(["배포: 최근 200건 안에서만 확인 — llm 은 확인하지 못함"]);
    expect(scopeNotesFrom(scopes({ monitor_down: { all: false, names: ["x", "y"] }, deploy_failed: { all: false, names: ["admin", "backend"] } }))).toEqual([
      "감시 대상 2개는 아직 상태를 모름", "배포: 최근 200건 안에서만 확인 — backend, admin 은 확인하지 못함",
    ]);
  });

  it("종류 전체(all)는 범위 줄이 아니라 확인하지 못한 출처의 줄로 드러난다 — scopeNotes 에 더하지 않는다", () => {
    expect(scopeNotesFrom(scopes({ monitor_down: { all: true, names: [] }, deploy_failed: { all: true, names: [] }, error_logs: { all: true, names: [] } }))).toEqual([]);
  });

  it("목록의 scopeNotes = scopeNotesFrom(list.uncovered)", () => {
    const sources = quietSources({ monitors: ok(monitors([monitor({ name: "front", status: "UNKNOWN" }), monitor({ name: "llm", status: "UNKNOWN" })])), deployments: ok(serviceDeployments(["front"], 200)) });
    const list = openIncidentsFrom(sources);
    expect(list.scopeNotes).toEqual(scopeNotesFrom(list.uncovered));
    expect(list.scopeNotes).toEqual(["감시 대상 2개는 아직 상태를 모름", "배포: 최근 200건 안에서만 확인 — backend, llm, alert, observe, admin 은 확인하지 못함"]);
  });
});

describe("isUncovered — 고른 식별자가 덮지 못한 범위에 드는가", () => {
  it.each([
    ["종류 전체 — 그 종류의 어떤 식별자든", scopes({ deploy_failed: { all: true, names: [] } }), deployIncidentId("front", "r1"), true],
    ["종류 전체 — 다른 종류는 아니다", scopes({ deploy_failed: { all: true, names: [] } }), monitorIncidentId("front"), false],
    ["보이지 않은 서비스의 배포", scopes({ deploy_failed: { all: false, names: ["llm"] } }), deployIncidentId("llm", "r999"), true],
    ["보인 서비스의 배포", scopes({ deploy_failed: { all: false, names: ["llm"] } }), deployIncidentId("front", "r1"), false],
    ["해시 꼴 배포(서비스를 알 수 없음) · 보이지 않은 서비스가 있다", scopes({ deploy_failed: { all: false, names: ["llm"] } }), deployIncidentId("front", "r".repeat(70)), true],
    ["해시 꼴 배포 · 보이지 않은 서비스가 없다", scopes(), deployIncidentId("front", "r".repeat(70)), false],
    ["상태를 모르는 감시 대상", scopes({ monitor_down: { all: false, names: ["front"] } }), monitorIncidentId("front"), true],
    ["상태를 아는 다른 감시 대상", scopes({ monitor_down: { all: false, names: ["front"] } }), monitorIncidentId("backend"), false],
    ["해시 꼴 감시 대상 이름도 그 이름이면", scopes({ monitor_down: { all: false, names: ["front app"] } }), monitorIncidentId("front app"), true],
    ["오류 로그 all", scopes({ error_logs: { all: true, names: [] } }), errorLogsIncidentId("backend"), true],
    ["자원 임계값 all", scopes({ resource_threshold: { all: true, names: [] } }), resourceIncidentId("s9", "cpu", null), true],
    ["아무 범위도 없음", scopes(), errorLogsIncidentId("backend"), false],
  ] as [string, UncoveredScopes, string, boolean][])("%s", (_label, value, id, expected) => {
    expect(isUncovered(value, id)).toBe(expected);
  });
});

describe("목록과 판정이 어긋나지 않는다 — 목록이 '확인하지 못함'이라 말한 범위의 식별자는 덮지 못한 범위, 말하지 않았으면 덮었다", () => {
  const MONITOR_CHOICES: [string, IncidentSources["monitors"], string[]][] = [
    ["감시 대상 모두 앎", ok(monitors([monitor({ name: "front" }), monitor({ name: "backend" })])), []],
    ["front 상태 모름", ok(monitors([monitor({ name: "front", status: "UNKNOWN" }), monitor({ name: "backend" })])), ["front"]],
    ["감시 대상 실패", UNREACHABLE, []],
  ];
  const DEPLOY_CHOICES: [string, IncidentSources["deployments"]][] = [
    ["배포 2건", ok([deployment({ service: "front" }), deployment({ service: "backend" })])],
    ["배포 200건 front 만", ok(serviceDeployments(["front"], 200))],
    ["배포 200건 모든 서비스", ok(serviceDeployments(["front", "backend", "llm", "alert", "observe", "admin"], 200))],
    ["배포 199건 front 만", ok(serviceDeployments(["front"], 199))],
    ["배포 실패", UNREACHABLE],
  ];
  const ERROR_CHOICES: [string, IncidentSources["errorLogs"]][] = [
    ["오류 로그 1건", ok(logPage([logLine({ service: "llm" })]))], ["오류 로그 500건", ok(FULL_ERROR_PAGE)], ["오류 로그 실패", UNREACHABLE],
  ];
  const LATEST_CHOICES: [string, IncidentSources["latest"]][] = [
    ["임계값 정상", ok(latest([serverLatest("s158")], []))], ["firing 칸 없음", ok(latest([serverLatest("s158")], null))], ["latest 실패", UNREACHABLE],
  ];
  /** 목록에 없는 문제의 식별자 — 감시 대상(이름) · 배포(서비스) · 해시 꼴 배포 · 오류 로그 · 자원 임계값. */
  const CANDIDATES: { id: string; kind: OpenIncident["kind"]; name: string | null }[] = [
    { id: monitorIncidentId("front"), kind: "monitor_down", name: "front" }, { id: monitorIncidentId("backend"), kind: "monitor_down", name: "backend" },
    { id: deployIncidentId("front", "r-old"), kind: "deploy_failed", name: "front" }, { id: deployIncidentId("llm", "r999"), kind: "deploy_failed", name: "llm" },
    { id: deployIncidentId("admin", "r".repeat(70)), kind: "deploy_failed", name: null },
    { id: errorLogsIncidentId("backend"), kind: "error_logs", name: "backend" }, { id: resourceIncidentId("s9", "cpu", null), kind: "resource_threshold", name: null },
  ];
  const SOURCE_OF_KIND = { monitor_down: "monitors", deploy_failed: "deployments", resource_threshold: "thresholds", error_logs: "errorLogs" } as const;

  /** 목록이 말한 것만으로 — 그 식별자의 범위를 확인하지 못했다고 말했는가. */
  function listSaysUnchecked(list: IncidentList, unknownMonitors: string[], candidate: (typeof CANDIDATES)[number]): boolean {
    if (list.unchecked.some((failure) => failure.source === SOURCE_OF_KIND[candidate.kind])) return true;
    if (candidate.kind === "error_logs") return list.errorLogsTruncated;
    if (candidate.kind === "monitor_down") {
      return list.scopeNotes.includes(`감시 대상 ${unknownMonitors.length}개는 아직 상태를 모름`) && unknownMonitors.includes(candidate.name!);
    }
    if (candidate.kind === "deploy_failed") {
      const note = list.scopeNotes.find((line) => line.startsWith("배포: 최근 200건 안에서만 확인 — "));
      if (note === undefined) return false;
      const unseen = note.slice("배포: 최근 200건 안에서만 확인 — ".length, -" 은 확인하지 못함".length).split(", ");
      return candidate.name === null || unseen.includes(candidate.name);
    }
    return false;
  }

  const combinations = MONITOR_CHOICES.flatMap((monitorChoice) => DEPLOY_CHOICES.flatMap((deployChoice) => ERROR_CHOICES.flatMap((errorChoice) =>
    LATEST_CHOICES.map((latestChoice) => [monitorChoice, deployChoice, errorChoice, latestChoice] as const))));

  it(`조합이 비지 않았다(${combinations.length}개)`, () => {
    expect(combinations.length).toBe(135);
  });

  it.each(combinations.map((combination) => [combination.map(([label]) => label).join(" · "), combination] as const))("%s", (_label, combination) => {
    const [[, monitorsResult, unknownMonitors], [, deploymentsResult], [, errorLogsResult], [, latestResult]] = combination;
    const list = openIncidentsFrom({ monitors: monitorsResult, deployments: deploymentsResult, errorLogs: errorLogsResult, latest: latestResult });
    const listSaysNothing = list.unchecked.length === 0 && !list.errorLogsTruncated && list.scopeNotes.length === 0;
    for (const candidate of CANDIDATES) {
      if (list.incidents.some((incident) => incident.id === candidate.id)) continue;
      const expected = listSaysUnchecked(list, unknownMonitors, candidate);
      expect(isUncovered(list.uncovered, candidate.id), candidate.id).toBe(expected);
      if (listSaysNothing) expect(isUncovered(list.uncovered, candidate.id), `${candidate.id} — 목록이 아무 범위도 말하지 않았다`).toBe(false);
    }
  });
});

describe("정렬 — 위험 먼저, 그 안에서 오래된 것 먼저(언제부터를 모르면 뒤)", () => {
  it("정해진 순서", () => {
    const failed = deployment({ service: "backend", state: "failed", acceptedAt: iso(NOW - 4 * HOUR), finishedAt: iso(NOW - 4 * HOUR + MINUTE) });
    const list = openIncidentsFrom({
      monitors: ok(monitors([
        monitor({ name: "front", status: "DOWN", downSince: iso(NOW - 10 * MINUTE) }),
        monitor({ name: "llm", status: "DOWN", downSince: null }),
        monitor({ name: "admin", status: "DOWN", downSince: iso(NOW - HOUR) }),
      ])),
      latest: ok(latest([], [
        firing({ server: "s1", rule: "cpu", severity: "warning", since: iso(NOW - 5 * HOUR) }),
        firing({ server: "s2", rule: "disk_critical", severity: "critical", since: iso(NOW - 30 * MINUTE) }),
      ])),
      deployments: ok([failed]),
      errorLogs: ok(logPage([logLine({ service: "observe" })])),
    });
    expect(ids(list)).toEqual([
      monitorIncidentId("admin"),                        // 위험 · 1시간 전
      resourceIncidentId("s2", "disk_critical", null),   // 위험 · 30분 전
      monitorIncidentId("front"),                        // 위험 · 10분 전
      monitorIncidentId("llm"),                          // 위험 · 언제부터 모름
      resourceIncidentId("s1", "cpu", null),             // 경고 · 5시간 전
      deployIncidentId("backend", failed.requestId),     // 경고 · 4시간 전
      errorLogsIncidentId("observe"),                    // 경고 · 언제부터 모름
    ]);
  });

  it("같은 심한 정도 · 같은 시각이면 종류 순서(감시 대상 · 배포 · 임계값 · 오류 로그), 그다음 식별자 순", () => {
    const at = iso(NOW - 15 * MINUTE);
    const failed = deployment({ service: "front", state: "failed", acceptedAt: iso(NOW - 16 * MINUTE), finishedAt: at });
    const list = openIncidentsFrom(quietSources({
      latest: ok(latest([], [firing({ server: "s2", rule: "cpu", since: at }), firing({ server: "s1", rule: "cpu", since: at })])),
      deployments: ok([failed]),
    }));
    expect(ids(list)).toEqual([deployIncidentId("front", failed.requestId), resourceIncidentId("s1", "cpu", null), resourceIncidentId("s2", "cpu", null)]);
  });
});
