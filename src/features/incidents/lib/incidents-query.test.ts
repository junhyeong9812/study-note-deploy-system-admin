/** 문제 화면의 주소 — `incident` 하나. 틀린 입력은 다른 서버를 부르기 전에 거절한다(field "incident"). */
import { describe, expect, it } from "vitest";
import { INCIDENTS_PATH, incidentHref, parseIncidentsQuery } from "@/features/incidents/lib/incidents-query";
import { monitorIncidentId, resourceIncidentId } from "@/features/incidents/lib/incident-id";
import { expectFailure } from "@/shared/lib/upstream-test-fakes";

describe("incidentHref", () => {
  it("목록 = /incidents, 문제 하나 = ?incident=<식별자>(`:` 는 %3A)", () => {
    expect(INCIDENTS_PATH).toBe("/incidents");
    expect(incidentHref(null)).toBe("/incidents");
    expect(incidentHref("monitor:front")).toBe("/incidents?incident=monitor%3Afront");
  });

  it("주소에서 다시 읽으면 같은 식별자(줄인 꼴 포함)", () => {
    for (const id of [monitorIncidentId("front"), resourceIncidentId("a".repeat(63), "restarts", "c".repeat(128))]) {
      const url = new URL(incidentHref(id), "https://admin.example.test");
      const parsed = parseIncidentsQuery({ incident: url.searchParams.get("incident")! });
      expect(parsed).toEqual({ ok: true, query: { incidentId: id } });
    }
  });
});

describe("parseIncidentsQuery", () => {
  it("없음 · 빈 글자 → 목록만", () => {
    expect(parseIncidentsQuery({})).toEqual({ ok: true, query: { incidentId: null } });
    expect(parseIncidentsQuery({ incident: "" })).toEqual({ ok: true, query: { incidentId: null } });
  });

  it("맞는 식별자 → 그대로", () => {
    expect(parseIncidentsQuery({ incident: "deploy:front:req-1" })).toEqual({ ok: true, query: { incidentId: "deploy:front:req-1" } });
  });

  it.each([
    ["모르는 종류", "other:front"], ["허용 밖 글자", "monitor:front app"], ["태그", "monitor:<script>"], ["너무 김", `monitor:${"a".repeat(57)}`],
    ["종류만", "monitor"],
  ])("%s → invalid_input(incident)", (_label, value) => {
    const parsed = parseIncidentsQuery({ incident: value });
    expectFailure(parsed as never, "invalid_input");
    expect((parsed as { field?: string }).field).toBe("incident");
  });

  it("같은 이름이 여러 번 → invalid_input(incident)", () => {
    const parsed = parseIncidentsQuery({ incident: ["monitor:front", "monitor:backend"] });
    expectFailure(parsed as never, "invalid_input");
    expect((parsed as { field?: string }).field).toBe("incident");
  });
});
