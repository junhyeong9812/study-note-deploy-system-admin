/** 근거 묶음 → 글(다음 조각이 Claude 에게 넘길 것)과 크기 상한(명세 ⑫ §9 가정 2). 화면과 같은 내용인지는 app/incidents/incidents-page.test.ts 가 본다.
 * 줄인 것은 글 안에 적는다(조용히 자르지 않는다). 가짜 장애(오류 로그 수백 줄 · 긴 스택 글)로 상한 안에 드는지 잰다. */
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH, INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES, evidenceTextBytes, fitIncidentEvidence, incidentEvidenceText,
} from "@/features/incidents/lib/incident-evidence-text";
import {
  buildIncidentEvidence, type EvidenceLogLine, type IncidentEvidence, type IncidentEvidenceDependencies,
} from "@/features/incidents/lib/incident-evidence";
import { openIncidentsFrom, type IncidentSources, type OpenIncident } from "@/features/incidents/lib/incident-list";
import { upstreamFailure } from "@/shared/lib/upstream-result";
import {
  HOUR, MINUTE, NOW, SECOND, alertRecord, deployment, firing, iso, latest, logPage, monitor, monitors, ok, quietSources, serverLatest,
} from "@/features/incidents/lib/incidents-test-fakes";

const DOWN_AT = NOW - 20 * MINUTE;

function downIncident() {
  const list = openIncidentsFrom(quietSources({ monitors: ok(monitors([monitor({ name: "front", status: "DOWN", downSince: iso(DOWN_AT), reason: "status 502" })])) }));
  return list.incidents[0];
}

function logLines(count: number, message: (index: number) => string): EvidenceLogLine[] {
  return Array.from({ length: count }, (_, index) => {
    const at = iso(DOWN_AT - 10 * MINUTE + index * SECOND);
    const id = `${Date.parse(at)}-0`;
    return { id, at, level: index % 2 === 0 ? "error" : "warning", service: "front", requestId: index % 3 === 0 ? `req-${index}` : "", message: message(index), href: `/logs?selected=${id}` };
  });
}

/** 칸이 모두 값인 감시 대상 DOWN 묶음. */
function evidenceWith(lines: EvidenceLogLine[], overrides: Partial<IncidentEvidence> = {}): IncidentEvidence {
  const recent = deployment({ requestId: "req-deploy-7", service: "backend", commitSha: "e".repeat(40), state: "failed", failedStage: "cd_health", acceptedAt: iso(DOWN_AT - 30 * MINUTE) });
  return {
    incident: downIncident(),
    facts: [
      { label: "대상", value: "front" }, { label: "상태", value: "DOWN" }, { label: "이유", value: "status 502" },
      { label: "DOWN 시각", value: iso(DOWN_AT) }, { label: "서비스", value: "front" },
    ],
    alertHistory: { state: "value", value: { from: iso(DOWN_AT - HOUR), to: iso(DOWN_AT + HOUR), coversWindow: true, records: [
      alertRecord({ at: iso(DOWN_AT), kind: "monitor_down", key: "front", title: "응답 없음: front" }),
    ] } },
    logs: { state: "value", value: {
      scope: "levels", from: iso(DOWN_AT - 10 * MINUTE), to: iso(DOWN_AT + 10 * MINUTE), services: ["front"], requestId: null,
      lines, truncated: false, noticeText: null,
    } },
    deployments: { state: "value", value: { kind: "window", from: iso(DOWN_AT - HOUR), to: iso(DOWN_AT), coversWindow: true, deployments: [{ ...recent, href: "/deploys?selected=req-deploy-7" }] } },
    resources: { state: "value", value: { kind: "trace", trace: {
      service: "front", atMilliseconds: DOWN_AT, fromMilliseconds: DOWN_AT - 5 * MINUTE, toMilliseconds: DOWN_AT + 5 * MINUTE,
      location: ok({ kind: "found", server: "s158", matchedBy: "container", serviceContainer: "front-app", containers: ["front-app"], alsoSeenOn: [], uncheckedServers: [], skippedServerCount: 0, unreadableServerNameCount: 0 }),
      host: ok({ source: "raw", stepMilliseconds: 30_000, pointCount: 20, noRecord: false, values: [
        { label: "CPU", unit: "percent", atLogValue: 97.5, atLogText: "97.5%", maximumValue: 99, maximumText: "99.0%" },
      ] }),
      container: null,
    } } },
    reductions: [],
    ...overrides,
  };
}

function sectionOf(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  expect(start, `${title} 구역이 없다`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + title.length + 5);
  const end = rest.indexOf("\n## ");
  return end < 0 ? rest : rest.slice(0, end);
}

/** 자바 예외처럼 긴 스택 글(한글 · 영문 섞임 — UTF-8 바이트로 잰다). */
function stackTrace(index: number, frames: number): string {
  const header = `java.lang.IllegalStateException: 요청 처리 실패 #${index} — 연결 풀이 비었습니다`;
  const lines = Array.from({ length: frames }, (_, frame) => `\tat xyz.junproject.backend.service.SearchService.query$${frame}(SearchService.kt:${100 + frame})`);
  return [header, ...lines].join("\n");
}

describe("글의 꼴", () => {
  it("머리 — 문제 · 식별자 · 심한 정도 · 언제부터, 그 뒤 칸 다섯이 이 차례로", () => {
    const text = incidentEvidenceText(evidenceWith(logLines(2, (index) => `메시지 ${index}`)));
    expect(text.split("\n").slice(0, 4)).toEqual([
      "# 문제: 감시 대상 DOWN — front", "- 식별자: monitor:front", "- 심한 정도: 위험", `- 언제부터: ${iso(DOWN_AT)}`,
    ]);
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## 무엇이 · 언제부터", "## 관련 알림", "## 로그", "## 배포", "## 자원"]);
  });

  it("무엇이 · 언제부터 — facts 순서대로 `- <label>: <value>`", () => {
    const section = sectionOf(incidentEvidenceText(evidenceWith([])), "무엇이 · 언제부터");
    expect(section.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- 대상: front", "- 상태: DOWN", "- 이유: status 502", `- DOWN 시각: ${iso(DOWN_AT)}`, "- 서비스: front",
    ]);
  });

  it("관련 알림 · 로그 · 배포 · 자원의 값이 빠짐없이 줄로", () => {
    const lines = logLines(2, (index) => `메시지 ${index}`);
    const text = incidentEvidenceText(evidenceWith(lines));
    expect(sectionOf(text, "관련 알림")).toContain(`- ${iso(DOWN_AT)} monitor_down front 응답 없음: front`);
    const logs = sectionOf(text, "로그");
    expect(logs).toContain(`기간: ${iso(DOWN_AT - 10 * MINUTE)} ~ ${iso(DOWN_AT + 10 * MINUTE)}`);
    expect(logs).toContain(`- ${lines[0].at} error front req-0 메시지 0`);
    expect(logs).toContain(`- ${lines[1].at} warning front - 메시지 1`);
    expect(sectionOf(text, "배포")).toContain(`- ${iso(DOWN_AT - 30 * MINUTE)} backend ${"e".repeat(40)} failed cd_health req-deploy-7`);
    const resources = sectionOf(text, "자원");
    expect(resources).toContain("s158");
    expect(resources).toContain("- CPU: 그때 97.5% · 창의 최대 99.0%");
  });

  it("줄바꿈이 든 로그 글은 이어지는 줄마다 앞에 `| ` — 로그 글이 `## ` 구역을 흉내 내지 못한다(칸마다의 검사는 incident-evidence-text-structure.test.ts)", () => {
    const text = incidentEvidenceText(evidenceWith(logLines(1, () => "첫 줄\n\tat a.b(C.kt:1)\n## 가짜 제목")));
    const logs = sectionOf(text, "로그");
    expect(logs).toMatch(/첫 줄\n\| [\t ]at a\.b\(C\.kt:1\)\n\| ## 가짜 제목/);   // 글 안의 탭은 그대로든 빈칸이든 된다
    expect(text.split("\n").filter((line) => /^ {0,3}#/.test(line))).toEqual([
      "# 문제: 감시 대상 DOWN — front", "## 무엇이 · 언제부터", "## 관련 알림", "## 로그", "## 배포", "## 자원",
    ]);
  });

  it("칸이 값이 아니면 그 칸의 한 줄 — 확인하지 못함 · 대응 표에 없음 · 해당 없음", () => {
    const text = incidentEvidenceText(evidenceWith([], {
      alertHistory: { state: "not_applicable" }, logs: { state: "unmapped" },
      deployments: { state: "failed", failure: upstreamFailure("unreachable") }, resources: { state: "failed", failure: upstreamFailure("unavailable", { status: 503 }) },
    }));
    expect(sectionOf(text, "관련 알림").trim()).toBe("해당 없음");
    expect(sectionOf(text, "로그").trim()).toBe("확인할 수 없음 — 대응 표에 없음");
    expect(sectionOf(text, "배포").trim()).toBe("확인하지 못함 — 닿지 않음");
    expect(sectionOf(text, "자원").trim()).toBe("확인하지 못함 — 서버 일시 장애");
  });

  it("창의 앞쪽에 닿지 못한 알림 · 배포, 더 있는 로그는 그 사실을 글에 적는다", () => {
    const base = evidenceWith(logLines(3, (index) => `m${index}`));
    const text = incidentEvidenceText({
      ...base,
      alertHistory: base.alertHistory.state === "value" ? { state: "value", value: { ...base.alertHistory.value, coversWindow: false } } : base.alertHistory,
      logs: base.logs.state === "value" ? { state: "value", value: { ...base.logs.value, truncated: true, noticeText: "최근 100줄만 보입니다 — 더 있음" } } : base.logs,
      deployments: base.deployments.state === "value" && base.deployments.value.kind === "window"
        ? { state: "value", value: { ...base.deployments.value, coversWindow: false } } : base.deployments,
    });
    expect(sectionOf(text, "관련 알림")).toContain("알림 기록 최근 200건이 이 창의 앞쪽까지 닿지 않습니다");
    expect(sectionOf(text, "로그")).toContain("최근 100줄만 보입니다 — 더 있음");
    expect(sectionOf(text, "배포")).toContain("배포 이력 최근 200건이 이 창의 앞쪽까지 닿지 않습니다");
  });

  it("줄인 것이 없으면 '줄인 것' 구역이 없다", () => {
    expect(incidentEvidenceText(evidenceWith(logLines(3, (index) => `m${index}`)))).not.toContain("## 줄인 것");
  });

  it("evidenceTextBytes 는 UTF-8 바이트", () => {
    expect(evidenceTextBytes("abc")).toBe(3);
    expect(evidenceTextBytes("가나")).toBe(6);
    expect(evidenceTextBytes("😀")).toBe(4);
  });
});

describe("크기 상한 — 넘으면 로그의 줄 수부터 줄이고, 줄였음을 글에 적는다", () => {
  it(`상한은 ${INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES} 바이트 · 상한 안이면 묶음을 바꾸지 않는다`, () => {
    expect(INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES).toBe(48_000);
    const evidence = evidenceWith(logLines(5, (index) => `m${index}`));
    const fitted = fitIncidentEvidence(evidence);
    expect(fitted).toEqual(evidence);
    expect(fitted.reductions).toEqual([]);
  });

  it("상한 경계 — 글이 정확히 상한이면 그대로, 1바이트 넘으면 줄인다", () => {
    const evidence = evidenceWith(logLines(20, (index) => `메시지-${index}-${"x".repeat(200)}`));
    const bytes = evidenceTextBytes(incidentEvidenceText(evidence));
    expect(fitIncidentEvidence(evidence, bytes).reductions).toEqual([]);
    const fitted = fitIncidentEvidence(evidence, bytes - 1);
    expect(fitted.reductions.length).toBeGreaterThan(0);
    expect(evidenceTextBytes(incidentEvidenceText(fitted))).toBeLessThanOrEqual(bytes - 1);
  });

  it("오래된 로그 줄부터 뺀다 — 최신 줄이 남고, 글과 묶음이 같이 줄며, 뺀 수가 글에 있다", () => {
    const lines = logLines(100, (index) => `#${index} ${"가".repeat(400)}`);   // 줄마다 1.2KB 남짓
    const evidence = evidenceWith(lines);
    expect(evidenceTextBytes(incidentEvidenceText(evidence))).toBeGreaterThan(INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES);
    const fitted = fitIncidentEvidence(evidence);
    const text = incidentEvidenceText(fitted);
    expect(evidenceTextBytes(text)).toBeLessThanOrEqual(INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES);
    if (fitted.logs.state !== "value") throw new Error("logs");
    const kept = fitted.logs.value.lines;
    const removed = 100 - kept.length;
    expect(removed).toBeGreaterThan(0);
    expect(kept.map((line) => line.id)).toEqual(lines.slice(removed).map((line) => line.id));   // 최신 줄들이 시간순 그대로
    expect(fitted.reductions).toEqual([`로그 100줄 중 오래된 ${removed}줄을 뺐습니다(크기 상한)`]);
    expect(sectionOf(text, "줄인 것")).toContain(`- 로그 100줄 중 오래된 ${removed}줄을 뺐습니다(크기 상한)`);
    // 다른 칸은 그대로
    expect(fitted.alertHistory).toEqual(evidence.alertHistory);
    expect(fitted.deployments).toEqual(evidence.deployments);
    // 받은 묶음을 바꾸지 않는다
    expect(evidence.logs.state === "value" && evidence.logs.value.lines).toHaveLength(100);
  });

  it("줄 수를 10줄까지 줄여도 넘으면(긴 스택 글) 한 줄의 글을 앞 1000자로 자른다 — 줄 수보다 먼저 줄이지 않는다", () => {
    expect(EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH).toBe(1_000);
    const lines = logLines(10, (index) => `${stackTrace(index, 400)}`);   // 한 줄이 30KB 남짓
    const fitted = fitIncidentEvidence(evidenceWith(lines));
    const text = incidentEvidenceText(fitted);
    expect(evidenceTextBytes(text)).toBeLessThanOrEqual(INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES);
    if (fitted.logs.state !== "value") throw new Error("logs");
    expect(fitted.logs.value.lines).toHaveLength(10);
    for (const line of fitted.logs.value.lines) expect(Array.from(line.message)).toHaveLength(1_000);
    expect(fitted.logs.value.lines[0].message).toBe(Array.from(lines[0].message).slice(0, 1_000).join(""));
    expect(fitted.reductions).toEqual(["로그 10줄의 글을 앞 1000자로 잘랐습니다(크기 상한)"]);
  });

  it("가짜 장애 — 오류 로그 100줄(받은 500줄 중 최신) · 줄마다 긴 스택 · 알림 200건 · 커밋 100개 → 상한 안, 줄인 것이 글에 있다", () => {
    const lines = logLines(100, (index) => stackTrace(index, 40));   // 줄마다 3KB 남짓
    const records = Array.from({ length: 200 }, (_, index) => alertRecord({ at: iso(DOWN_AT - index * 10 * SECOND), key: "front", title: `응답 없음: front ${"x".repeat(100)} ${index}` }));
    const evidence = evidenceWith(lines, {
      alertHistory: { state: "value", value: { from: iso(DOWN_AT - HOUR), to: iso(DOWN_AT + HOUR), coversWindow: true, records } },
      logs: { state: "value", value: { scope: "levels", from: iso(DOWN_AT - 10 * MINUTE), to: iso(DOWN_AT + 10 * MINUTE), services: ["front"], requestId: null,
        lines, truncated: true, noticeText: "최근 100줄만 보입니다 — 더 있음" } },
    });
    const before = evidenceTextBytes(incidentEvidenceText(evidence));
    const fitted = fitIncidentEvidence(evidence);
    const after = evidenceTextBytes(incidentEvidenceText(fitted));
    expect(before).toBeGreaterThan(300_000);
    expect(after).toBeLessThanOrEqual(INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES);
    expect(fitted.reductions[0]).toMatch(/^로그 100줄 중 오래된 \d+줄을 뺐습니다\(크기 상한\)$/);
    expect(incidentEvidenceText(fitted)).toContain("## 줄인 것");
  });

  it("로그 칸이 값이 아니면(대응 표에 없음) 다음 차례 — 알림 기록을 오래된 것부터 뺀다", () => {
    const records = Array.from({ length: 200 }, (_, index) => alertRecord({ at: iso(DOWN_AT - index * SECOND), title: `${"제".repeat(110)} ${index}` }));
    const evidence = evidenceWith([], {
      logs: { state: "unmapped" },
      alertHistory: { state: "value", value: { from: iso(DOWN_AT - HOUR), to: iso(DOWN_AT + HOUR), coversWindow: true, records } },
    });
    const fitted = fitIncidentEvidence(evidence, 20_000);
    expect(evidenceTextBytes(incidentEvidenceText(fitted))).toBeLessThanOrEqual(20_000);
    if (fitted.alertHistory.state !== "value") throw new Error("alerts");
    const kept = fitted.alertHistory.value.records;
    expect(kept).toEqual(records.slice(0, kept.length));   // 알림 서버 순서(최신 먼저) — 앞쪽(최신)이 남는다
    expect(fitted.reductions).toEqual([`관련 알림 200건 중 오래된 ${200 - kept.length}건을 뺐습니다(크기 상한)`]);
  });
});

// ── 깨끗한 작은 입력 · 크기의 상한(명세 ⑫ §11 4) ─────────────

/** 칸마다 기본 답(빈 목록 · 자원 칸은 부르지 않음)인 가짜 클라이언트 — 실제 조립(buildIncidentEvidence)을 거친 묶음을 만든다. */
function quietDependencies(overrides: Partial<IncidentEvidenceDependencies> = {}): IncidentEvidenceDependencies {
  return {
    alertRecords: { listIncidents: async () => ok([]) },
    logs: { searchLogs: async (query) => ok(logPage([], { from: query.from!, to: query.to! })) },
    deployGit: { listCommits: async () => ok({ commits: [], truncated: false, rangeComplete: true, relation: "ancestor" }), getCommit: async () => upstreamFailure("not_found") },
    traceResources: async () => null,
    ...overrides,
  };
}

async function builtEvidence(sources: IncidentSources, kind: OpenIncident["kind"], dependencies: IncidentEvidenceDependencies = quietDependencies()): Promise<IncidentEvidence> {
  const incident = openIncidentsFrom(sources).incidents.find((candidate) => candidate.kind === kind);
  expect(incident, kind).toBeDefined();
  return buildIncidentEvidence(dependencies, { incident: incident!, sources, nowMilliseconds: NOW });
}

/** 깨진 글자 — 바꿈 글자(U+FFFD) · 짝 없는 서로게이트. */
const BROKEN_CHARACTER = /\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const VALUE_CUT_REDUCTION = /^값 \d+개를 앞 500자로 잘랐습니다\(크기 상한\)$/;
const END_CUT_REDUCTION = "상한을 넘어 끝을 잘랐습니다(크기 상한)";

/** 맞춘 묶음의 글 — 상한 이하 · 깨진 글자 없음 · 줄인 것이 있고 그 줄마다 글의 '줄인 것' 구역에 있다. */
function expectFittedText(fitted: IncidentEvidence, maximumBytes: number = INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES): string {
  const text = incidentEvidenceText(fitted);
  expect(evidenceTextBytes(text)).toBeLessThanOrEqual(maximumBytes);
  expect(text).not.toMatch(BROKEN_CHARACTER);
  expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
  expect(fitted.reductions.length).toBeGreaterThan(0);
  const reductionsSection = sectionOf(text, "줄인 것");
  for (const reduction of fitted.reductions) expect(reductionsSection).toContain(`- ${reduction}`);
  return text;
}

function firstCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

describe("깨끗한 작은 입력은 한 글자도 바뀌지 않는다(지금의 글 그대로)", () => {
  it("감시 대상 DOWN — 창의 배포 · 그때 자원", () => {
    const evidence = evidenceWith(logLines(3, (index) => `메시지 ${index}`));
    expect(fitIncidentEvidence(evidence)).toEqual(evidence);
    expect(incidentEvidenceText(fitIncidentEvidence(evidence))).toBe([
      "# 문제: 감시 대상 DOWN — front",
      "- 식별자: monitor:front",
      "- 심한 정도: 위험",
      "- 언제부터: 2026-11-25T05:40:00.000Z",
      "",
      "## 무엇이 · 언제부터",
      "- 대상: front",
      "- 상태: DOWN",
      "- 이유: status 502",
      "- DOWN 시각: 2026-11-25T05:40:00.000Z",
      "- 서비스: front",
      "",
      "## 관련 알림",
      "기간: 2026-11-25T04:40:00.000Z ~ 2026-11-25T06:40:00.000Z",
      "- 2026-11-25T05:40:00.000Z monitor_down front 응답 없음: front",
      "",
      "## 로그",
      "기간: 2026-11-25T05:30:00.000Z ~ 2026-11-25T05:50:00.000Z",
      "서비스: front",
      "- 2026-11-25T05:30:00.000Z error front req-0 메시지 0",
      "- 2026-11-25T05:30:01.000Z warning front - 메시지 1",
      "- 2026-11-25T05:30:02.000Z error front - 메시지 2",
      "",
      "## 배포",
      "기간: 2026-11-25T04:40:00.000Z ~ 2026-11-25T05:40:00.000Z",
      `- 2026-11-25T05:10:00.000Z backend ${"e".repeat(40)} failed cd_health req-deploy-7`,
      "",
      "## 자원",
      "서비스 front · 기준 시각 2026-11-25T05:40:00.000Z · 앞뒤 5분",
      "서버 s158 (front-app)",
      "서버 값:",
      "- CPU: 그때 97.5% · 창의 최대 99.0%",
      "컨테이너 값: 기록 없음",
    ].join("\n"));
  });

  it("자원 임계값 — 범위의 커밋 · 서버의 지금 값", () => {
    const threshold = openIncidentsFrom(quietSources({ latest: ok(latest([serverLatest("s158")], [firing({ server: "s158", rule: "disk_warning", since: iso(NOW - 30 * MINUTE) })])) })).incidents[0];
    const evidence = evidenceWith(logLines(3, (index) => `메시지 ${index}`), {
      incident: threshold,
      facts: [{ label: "서버", value: "s158" }, { label: "규칙", value: "디스크 경고" }],
      deployments: { state: "value", value: { kind: "range", status: "range", baseRequestId: "req-ok-1", baseCommitSha: "c".repeat(40), headCommitSha: "b".repeat(40),
        commits: [{ sha: "b".repeat(40), authorName: "jun", authoredAt: iso(NOW - HOUR), subject: "검색 수정", body: "", bodyTruncated: false }], truncated: true, relation: "ancestor", detailHref: "/deploys" } },
      resources: { state: "value", value: { kind: "server", server: "s158", found: true, cpuText: "3.4%", memoryText: "12.5%", diskText: "86.0%", receivedAt: iso(NOW - 19 * SECOND), resourcesHref: "/resources" } },
    });
    expect(fitIncidentEvidence(evidence)).toEqual(evidence);
    const text = incidentEvidenceText(fitIncidentEvidence(evidence));
    expect(text.split("\n").slice(0, 8)).toEqual([
      "# 문제: 자원 임계값 — 서버 s158 디스크 경고", "- 식별자: resource:s158:disk_warning", "- 심한 정도: 경고", "- 언제부터: 2026-11-25T05:30:00.000Z",
      "", "## 무엇이 · 언제부터", "- 서버: s158", "- 규칙: 디스크 경고",
    ]);
    expect(sectionOf(text, "배포")).toBe([
      "앞 성공 배포: req-ok-1 " + "c".repeat(40), "이번 배포 커밋: " + "b".repeat(40), `- ${"b".repeat(40)} 검색 수정`, "(더 있음)", "",
    ].join("\n"));
    expect(sectionOf(text, "자원")).toBe("서버 s158: CPU 3.4% · 메모리 12.5% · 디스크 86.0%\n마지막 수신: 2026-11-25T05:59:41.000Z");
  });
});

describe("크기의 상한은 언제나 지켜진다 — 줄이지 않던 칸도 값 하나에 500자, 그래도 넘으면 끝을 잘라 맞춘다", () => {
  it("감시 대상 이름 6만 자 — 머리의 대상 · 무엇이의 대상을 앞 500자로 자르고, 줄인 것에 적는다", async () => {
    const name = "x".repeat(60_000);
    const sources = quietSources({ monitors: ok(monitors([monitor({ name, status: "DOWN", downSince: iso(DOWN_AT), reason: "status 502" })])) });
    const fitted = fitIncidentEvidence(await builtEvidence(sources, "monitor_down"));
    const text = expectFittedText(fitted);
    expect(text.split("\n")[0]).toBe(`# 문제: 감시 대상 DOWN — ${"x".repeat(500)}`);
    expect(sectionOf(text, "무엇이 · 언제부터").split("\n")).toContain(`- 대상: ${"x".repeat(500)}`);
    expect(fitted.reductions.filter((reduction) => VALUE_CUT_REDUCTION.test(reduction))).toHaveLength(1);
    expect(fitted.reductions).not.toContain(END_CUT_REDUCTION);
  });

  it("값 하나의 500자는 코드 포인트로 센다 — 이모지 이름도 깨지지 않는다", async () => {
    const name = "😀".repeat(30_000);
    const sources = quietSources({ monitors: ok(monitors([monitor({ name, status: "DOWN", downSince: iso(DOWN_AT) })])) });
    const text = expectFittedText(fitIncidentEvidence(await builtEvidence(sources, "monitor_down")));
    expect(sectionOf(text, "무엇이 · 언제부터").split("\n")).toContain(`- 대상: ${"😀".repeat(500)}`);
  });

  it("firing 대상 6만 자 — 머리의 대상(`서버 … <대상>`)과 무엇이의 대상을 앞 500자로", async () => {
    const target = "t".repeat(60_000);
    const sources = quietSources({ latest: ok(latest([serverLatest("s158")], [firing({ server: "s158", rule: "restarts", target, since: iso(NOW - 30 * MINUTE) })])) });
    const fitted = fitIncidentEvidence(await builtEvidence(sources, "resource_threshold"));
    const text = expectFittedText(fitted);
    expect(text.split("\n")[0]).toBe(`# 문제: 자원 임계값 — ${firstCodePoints(`서버 s158 컨테이너 재시작 반복 ${target}`, 500)}`);
    expect(sectionOf(text, "무엇이 · 언제부터").split("\n")).toContain(`- 대상: ${"t".repeat(500)}`);
    expect(fitted.reductions.some((reduction) => VALUE_CUT_REDUCTION.test(reduction))).toBe(true);
  });

  it("알림 종류 6만 자 — 상한 안 · 줄인 것이 글에 있다", async () => {
    const sources = quietSources({ latest: ok(latest([serverLatest("s158")], [firing({ server: "s158", rule: "cpu", since: iso(NOW - 30 * MINUTE) })])) });
    const records = [alertRecord({ at: iso(NOW - 5 * MINUTE), kind: "k".repeat(60_000), key: "resource:s158:cpu", title: "CPU 넘음" })];
    const fitted = fitIncidentEvidence(await builtEvidence(sources, "resource_threshold", quietDependencies({ alertRecords: { listIncidents: async () => ok(records) } })));
    expectFittedText(fitted);
  });

  /** 앞 1시간의 배포 200건 — 실패 단계마다 한글 · 이모지가 섞인 긴 글(500자로 잘라도 200건이면 상한을 넘는다). */
  function longStageDeployments(): IncidentEvidence {
    const failedStage = "가😀".repeat(1_000);
    const deployments = Array.from({ length: 200 }, (_, index) => {
      const summary = deployment({ requestId: `req-${String(index).padStart(3, "0")}`, service: "backend", commitSha: "e".repeat(40), state: "failed", failedStage, acceptedAt: iso(DOWN_AT - (index + 1) * 10 * SECOND) });
      return { ...summary, href: `/deploys?selected=${summary.requestId}` };
    });
    return evidenceWith(logLines(3, (index) => `메시지 ${index}`), {
      deployments: { state: "value", value: { kind: "window", from: iso(DOWN_AT - HOUR), to: iso(DOWN_AT), coversWindow: true, deployments } },
    });
  }

  it("배포 200건 × 긴 실패 단계 — 값마다 500자로 자르고, 그래도 넘으면 끝을 잘라 맞춘다(둘 다 줄인 것에)", () => {
    const fitted = fitIncidentEvidence(longStageDeployments());
    const text = expectFittedText(fitted);
    expect(fitted.reductions.some((reduction) => VALUE_CUT_REDUCTION.test(reduction))).toBe(true);
    expect(fitted.reductions).toContain(END_CUT_REDUCTION);
    expect(sectionOf(text, "배포").split("\n")).toContain(`- ${iso(DOWN_AT - 10 * SECOND)} backend ${"e".repeat(40)} failed ${"가😀".repeat(250)} req-000`);
  });

  it.each([0, 1, 2, 3, 4, 5, 6])("끝을 자른 자리가 멀티바이트 글자의 어느 바이트여도 깨진 글자가 없다(상한 30000 + %i)", (offset) => {
    const maximumBytes = 30_000 + offset;
    const fitted = fitIncidentEvidence(longStageDeployments(), maximumBytes);
    expectFittedText(fitted, maximumBytes);
    expect(fitted.reductions).toContain(END_CUT_REDUCTION);
  });
});
