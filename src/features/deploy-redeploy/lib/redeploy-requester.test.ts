/** 접수의 requested_by — `admin:<계정>`, 명세 §10 의 허용 글자(`@` 없음) 안이어야 하고 아니면 master 를 부르기 전에 거절한다(null). */
import { describe, expect, it } from "vitest";
import { REQUESTED_BY_PATTERN, incidentRequestedByFor, requestedByFor } from "@/features/deploy-redeploy/lib/redeploy-requester";
import { INCIDENT_ID_MAXIMUM_LENGTH, resourceIncidentId } from "@/features/incidents/lib/incident-id";

describe("requestedByFor", () => {
  it.each(["fake-admin-id-zq", "jun", "jun.kim_01", "A-Z.a-z_0-9"])("%s → admin:%s", (account) => {
    expect(requestedByFor(account)).toBe(`admin:${account}`);
    expect(`admin:${account}`).toMatch(REQUESTED_BY_PATTERN);
  });

  it.each([
    ["@ (메신저 멘션)", "jun@example.com"],
    ["@everyone", "@everyone"],
    ["공백", "jun kim"],
    ["한글", "준형"],
    ["콜론(⑫ 의 자리)", "jun:incident:1"],
    ["빈 값", ""],
    ["줄바꿈", "jun\nadmin"],
    ["슬래시", "jun/x"],
  ])("%s → null", (_label, account) => {
    expect(requestedByFor(account)).toBeNull();
  });

  it("전체 128자까지 — 계정 122자는 받고 123자는 거절", () => {
    expect(requestedByFor("a".repeat(122))).toBe(`admin:${"a".repeat(122)}`);
    expect(requestedByFor("a".repeat(123))).toBeNull();
  });

  it("허용 글자는 명세 §10 그대로 — @ 를 받지 않는다", () => {
    expect(REQUESTED_BY_PATTERN.source).toBe("^[A-Za-z0-9._:-]{1,128}$");
    expect("admin:a@b").not.toMatch(REQUESTED_BY_PATTERN);
  });
});

/** ci-cd 의 검증(feat/deploy-failure-output · internal/master/master.go:52 `^[A-Za-z0-9._:-]{1,128}$` · :147 접수 전에 422 invalid_requested_by) 그대로. */
const CICD_REQUESTED_BY = /^[A-Za-z0-9._:-]{1,128}$/;

describe("incidentRequestedByFor — 문제에서 온 접수(명세 ⑫ §24)", () => {
  it.each([
    ["jun", "monitor:front", "admin:jun:incident:monitor:front"],
    ["fake-admin-id-zq", "deploy:backend:req-1", "admin:fake-admin-id-zq:incident:deploy:backend:req-1"],
    ["jun", "resource:sha256-0123456789abcdef", "admin:jun:incident:resource:sha256-0123456789abcdef"],
  ])("%s · %s → %s", (account, incidentId, expected) => {
    expect(incidentRequestedByFor(account, incidentId)).toBe(expected);
    expect(expected).toMatch(CICD_REQUESTED_BY);
  });

  it("경계 — 가장 긴 문제의 ID(64자) + 계정 48자 = 128자는 받고, 계정 49자는 거절(master 를 부르기 전에)", () => {
    const longestId = resourceIncidentId("s".repeat(33), "disk_warning", "t".repeat(8));
    expect(longestId).toHaveLength(INCIDENT_ID_MAXIMUM_LENGTH);
    expect(INCIDENT_ID_MAXIMUM_LENGTH).toBe(64);
    const accepted = incidentRequestedByFor("a".repeat(48), longestId);
    expect(accepted).toBe(`admin:${"a".repeat(48)}:incident:${longestId}`);
    expect(accepted).toHaveLength(128);
    expect(accepted).toMatch(CICD_REQUESTED_BY);
    expect(incidentRequestedByFor("a".repeat(49), longestId)).toBeNull();
  });

  it("사람의 접수로는 되는 긴 계정(122자)도 문제의 접수로는 길이를 넘으면 거절", () => {
    expect(requestedByFor("a".repeat(122))).not.toBeNull();
    expect(incidentRequestedByFor("a".repeat(122), "errors:a")).toBeNull();
  });

  it.each([
    ["계정에 @", "j@n", "monitor:front"], ["계정에 콜론", "jun:x", "monitor:front"], ["빈 계정", "", "monitor:front"],
    ["문제의 ID 꼴이 아님(종류 낱말 없음)", "jun", "front"], ["문제의 ID 에 허용 밖 글자", "jun", "monitor:front app"], ["빈 ID", "jun", ""],
    ["ID 가 65자", "jun", `monitor:${"a".repeat(57)}`],
  ])("%s → null", (_label, account, incidentId) => {
    expect(incidentRequestedByFor(account, incidentId)).toBeNull();
  });
});
