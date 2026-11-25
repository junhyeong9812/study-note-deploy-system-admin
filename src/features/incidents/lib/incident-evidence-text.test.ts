/** 근거 묶음 → 글(다음 조각이 Claude 에게 넘길 것)과 크기 상한(명세 ⑫ §9 가정 2). 화면과 같은 내용인지는 app/incidents/incidents-page.test.ts 가 본다.
 * 줄인 것은 글 안에 적는다(조용히 자르지 않는다). 가짜 장애(오류 로그 수백 줄 · 긴 스택 글)로 상한 안에 드는지 잰다. */
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH, INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES, evidenceTextBytes, fitIncidentEvidence, incidentEvidenceText,
} from "@/features/incidents/lib/incident-evidence-text";
import type { EvidenceLogLine, IncidentEvidence } from "@/features/incidents/lib/incident-evidence";
import { openIncidentsFrom } from "@/features/incidents/lib/incident-list";
import { upstreamFailure } from "@/shared/lib/upstream-result";
import { HOUR, MINUTE, NOW, SECOND, alertRecord, deployment, iso, monitor, monitors, ok, quietSources } from "@/features/incidents/lib/incidents-test-fakes";

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

  it("줄바꿈이 든 로그 글은 이어지는 줄을 두 칸 들여 쓴다(글의 줄 구조가 깨지지 않게)", () => {
    const text = incidentEvidenceText(evidenceWith(logLines(1, () => "첫 줄\n\tat a.b(C.kt:1)\n## 가짜 제목")));
    const logs = sectionOf(text, "로그");
    expect(logs).toContain("첫 줄\n  \tat a.b(C.kt:1)\n  ## 가짜 제목");
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(5);
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
