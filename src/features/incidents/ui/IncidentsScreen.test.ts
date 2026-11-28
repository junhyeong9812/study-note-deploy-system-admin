/** 문제 화면의 자원 칸 — 화면에 보이는 것은 글에도 있다(명세 ⑫ §11 6 · §2 "보낸 묶음과 사람이 보는 묶음이 같다").
 * 같은 묶음을 화면(IncidentsScreen → HTML)과 글(incidentEvidenceText)로 만들어, 화면에 나오는 줄마다 글에도 같은 낱말의 줄이 있는지 본다.
 * 화면의 문구는 TraceResourcesBlock.tsx · IncidentsScreen.tsx 의 것 그대로다(글이 화면의 낱말을 따른다). */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { IncidentsScreen } from "@/features/incidents/ui/IncidentsScreen";
import { incidentEvidenceText } from "@/features/incidents/lib/incident-evidence-text";
import type { EvidenceResourcesView, IncidentEvidence } from "@/features/incidents/lib/incident-evidence";
import { openIncidentsFrom } from "@/features/incidents/lib/incident-list";
import type { TraceResourcesView, TraceSeriesView, TraceServerLocation } from "@/features/log-trace/lib/trace-resources";
import { MINUTE, NOW, SECOND, iso, monitor, monitors, ok, quietSources } from "@/features/incidents/lib/incidents-test-fakes";

const DOWN_AT = NOW - 20 * MINUTE;

function sources() {
  return quietSources({ monitors: ok(monitors([monitor({ name: "front", status: "DOWN", downSince: iso(DOWN_AT), reason: "status 502" })])) });
}

function series(source: TraceSeriesView["source"], stepMilliseconds: number): TraceSeriesView {
  return { source, stepMilliseconds, pointCount: 20, noRecord: false, values: [
    { label: "CPU", unit: "percent", atLogValue: 97.5, atLogText: "97.5%", maximumValue: 99, maximumText: "99.0%" },
  ] };
}

function found(overrides: Partial<Extract<TraceServerLocation, { kind: "found" }>> = {}): TraceServerLocation {
  return {
    kind: "found", server: "s158", matchedBy: "container", serviceContainer: "front-app", containers: ["front-app"], alsoSeenOn: [], uncheckedServers: [],
    skippedServerCount: 0, unreadableServerNameCount: 0, ...overrides,
  };
}

function traceResources(location: TraceServerLocation, host: TraceSeriesView = series("raw", 30_000)): EvidenceResourcesView {
  const trace: TraceResourcesView = {
    service: "front", atMilliseconds: DOWN_AT, fromMilliseconds: DOWN_AT - 5 * MINUTE, toMilliseconds: DOWN_AT + 5 * MINUTE,
    location: ok(location), host: ok(host), container: null,
  };
  return { kind: "trace", trace };
}

function evidenceWith(resources: EvidenceResourcesView): IncidentEvidence {
  const incident = openIncidentsFrom(sources()).incidents[0];
  return {
    incident, facts: [{ label: "대상", value: "front" }], alertHistory: { state: "not_applicable" }, logs: { state: "unmapped" },
    deployments: { state: "value", value: { kind: "window", from: iso(DOWN_AT - 60 * MINUTE), to: iso(DOWN_AT), coversWindow: true, deployments: [] } },
    resources: { state: "value", value: resources }, reductions: [],
  };
}

async function screenAndText(evidence: IncidentEvidence): Promise<{ screen: string; text: string }> {
  const text = incidentEvidenceText(evidence);
  const element = createElement(IncidentsScreen, { outcome: { kind: "screen", data: {
    checkedAt: iso(NOW), list: openIncidentsFrom(sources()), selected: { kind: "evidence", evidence, text },
  } } });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  const html = renderer.renderToStaticMarkup(element);
  const section = /<section[^>]*aria-labelledby="evidence-resources"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  expect(section, "자원 구역이 없다").not.toBeNull();
  const screen = section![1].replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  const start = text.indexOf("\n## 자원\n");
  expect(start, "글에 자원 구역이 없다").toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + "\n## 자원\n".length);
  const end = rest.indexOf("\n## ");
  return { screen, text: end < 0 ? rest : rest.slice(0, end) };
}

describe("자원 칸 — 화면에 나오는 줄은 글에도 같은 낱말로", () => {
  it.each([
    ["같은 서비스가 보인 다른 서버", traceResources(found({ alsoSeenOn: ["s10", "s9"] })), "같은 서비스가 서버 s10 · s9 에도 보였습니다"],
    ["확인하지 못한 서버", traceResources(found({ uncheckedServers: ["s7", "s8"] })), "서버 s7 · s8 는 확인하지 못함"],
    ["묻지 않은 서버 수(상한 밖)", traceResources(found({ skippedServerCount: 3 })), "확인하지 못한 서버 3대(묻는 서버는 앞 10대까지)"],
    ["이름을 읽지 못한 서버 수", traceResources(found({ unreadableServerNameCount: 2 })), "이름을 읽지 못한 서버 2대"],
    ["5분 평균에서 읽은 값(rollup)", traceResources(found(), series("rollup", 300_000)), "5분 평균 값(고른 로그가 7일보다 오래됨)"],
    ["5분 평균에서 읽은 값(step 5분)", traceResources(found(), series("raw", 300_000)), "5분 평균 값(고른 로그가 7일보다 오래됨)"],
    ["어느 서버였는지 모름 — 묻지 못한 · 묻지 않은 · 이름을 읽지 못한 서버",
      traceResources({ kind: "unknown", failedServers: ["s7"], skippedServerCount: 1, unreadableServerNameCount: 1 }),
      "어느 서버였는지 확인하지 못함 — 서버 s7 에 묻지 못했습니다 · 확인하지 못한 서버 1대(묻는 서버는 앞 10대까지) · 이름을 읽지 못한 서버 1대"],
  ])("%s", async (_label, resources, phrase) => {
    const { screen, text } = await screenAndText(evidenceWith(resources));
    expect(screen).toContain(phrase);
    expect(text).toContain(phrase);
  });

  it("묻지 못한 서버와 묻지 않은 서버가 함께면 둘 다", async () => {
    const { screen, text } = await screenAndText(evidenceWith(traceResources(found({ uncheckedServers: ["s7"], skippedServerCount: 3, unreadableServerNameCount: 2 }))));
    for (const phrase of ["서버 s7 는 확인하지 못함", "확인하지 못한 서버 3대(묻는 서버는 앞 10대까지)", "이름을 읽지 못한 서버 2대"]) {
      expect(screen, phrase).toContain(phrase);
      expect(text, phrase).toContain(phrase);
    }
  });

  it("서버의 지금 값 — 마지막 수신을 모르면 화면은 '마지막 수신(KST) 없음', 글은 '마지막 수신: 없음'", async () => {
    const resources: EvidenceResourcesView = {
      kind: "server", server: "s158", found: false, cpuText: "없음", memoryText: "없음", diskText: "없음", receivedAt: null, resourcesHref: "/resources?range=1h#resource-server-s158",
    };
    const { screen, text } = await screenAndText(evidenceWith(resources));
    expect(screen).toContain("마지막 수신(KST)없음");
    expect(text.split("\n")).toContain("마지막 수신: 없음");
    expect(text).toContain("지금 지표를 보낸 서버 목록에 없음");
  });

  it("서버의 지금 값 — 마지막 수신이 있으면 글은 그 시각(지금 그대로)", async () => {
    const receivedAt = iso(NOW - 19 * SECOND);
    const resources: EvidenceResourcesView = {
      kind: "server", server: "s158", found: true, cpuText: "3.4%", memoryText: "12.5%", diskText: "86.0%", receivedAt, resourcesHref: "/resources?range=1h#resource-server-s158",
    };
    const { text } = await screenAndText(evidenceWith(resources));
    expect(text.split("\n")).toContain(`마지막 수신: ${receivedAt}`);
  });

  it("아무 사정이 없으면 화면에도 글에도 그런 줄이 없다(빈 경우를 꾸며 내지 않는다)", async () => {
    const { screen, text } = await screenAndText(evidenceWith(traceResources(found())));
    for (const word of ["에도 보였습니다", "는 확인하지 못함", "확인하지 못한 서버", "이름을 읽지 못한 서버", "5분 평균"]) {
      expect(screen, word).not.toContain(word);
      expect(text, word).not.toContain(word);
    }
  });
});
