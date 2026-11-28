/** 재배포 확인 화면의 입력 검증 — service(허용 목록) · commit(전체 SHA 40자 소문자 16진수 — master 이력이 주는 꼴)만, 그 밖은 master 를 부르기 전에 거절. */
import { describe, expect, it } from "vitest";
import { incidentRedeployPreviewHref, parseRedeployPreviewQuery, parseRedeployPreviewRequest } from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import { DEPLOY_SERVICES } from "@/features/deploys/lib/deploy-history-query";
import { expectFailure } from "@/shared/lib/upstream-test-fakes";

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

function expectRejected(input: Record<string, string | string[] | undefined>, field: "service" | "commit") {
  const result = parseRedeployPreviewQuery(input);
  expectFailure(result, "invalid_input");
  expect(result).toMatchObject({ ok: false, field });
}

describe("parseRedeployPreviewQuery — 받는 것", () => {
  it("허용 목록의 서비스 + 전체 SHA 40자 → 그대로", () => {
    for (const service of DEPLOY_SERVICES) {
      expect(parseRedeployPreviewQuery({ service, commit: FULL_SHA })).toEqual({ ok: true, query: { service, commitSha: FULL_SHA } });
    }
  });
});

describe("parseRedeployPreviewQuery — service 거절(field service, service 를 먼저 본다)", () => {
  it.each([[undefined], [""], ["Front"], [" front"], ["front\n"], ["not-a-service"], ["../front"], [["front", "backend"]]])("service %j", (service) => {
    expectRejected({ service, commit: FULL_SHA }, "service");
  });

  it("service 와 commit 이 둘 다 틀리면 field 는 service", () => {
    expectRejected({ service: "nope", commit: "zz" }, "service");
  });
});

describe("parseRedeployPreviewQuery — commit 거절(field commit)", () => {
  it.each([
    ["없음", undefined],
    ["빈 값", ""],
    ["짧은 SHA(7자)", FULL_SHA.slice(0, 7)],
    ["39자", FULL_SHA.slice(0, 39)],
    ["41자", `${FULL_SHA}0`],
    ["64자(SHA-256 — 이 화면은 받지 않는다)", `${FULL_SHA}${FULL_SHA}`.slice(0, 64)],
    ["대문자", FULL_SHA.toUpperCase()],
    ["16진수 아닌 글자", `${FULL_SHA.slice(0, 39)}g`],
    ["앞뒤 공백", ` ${FULL_SHA}`],
    ["끝 줄바꿈", `${FULL_SHA}\n`],
    ["브랜치 이름", "main"],
    ["git 범위 꼴", `${FULL_SHA.slice(0, 7)}..HEAD`],
    ["배열", [FULL_SHA, FULL_SHA]],
  ])("%s", (_label, commit) => {
    expectRejected({ service: "backend", commit }, "commit");
  });
});

describe("parseRedeployPreviewRequest — 버전에서 온 것 · 문제의 조치에서 온 것(명세 ⑫ §24)", () => {
  it("incident 가 없으면 ⑥ 그대로(parseRedeployPreviewQuery 와 같은 결과)", () => {
    expect(parseRedeployPreviewRequest({ service: "backend", commit: FULL_SHA })).toEqual({ ok: true, request: { kind: "version", query: { service: "backend", commitSha: FULL_SHA } } });
    expect(parseRedeployPreviewRequest({ service: "nope", commit: FULL_SHA })).toEqual(parseRedeployPreviewQuery({ service: "nope", commit: FULL_SHA }));
  });

  it("incident · action · service — commit 없이", () => {
    for (const action of ["redeploy", "rollback"] as const) {
      expect(parseRedeployPreviewRequest({ service: "backend", incident: "monitor:backend-deps", action }))
        .toEqual({ ok: true, request: { kind: "incident", service: "backend", incidentId: "monitor:backend-deps", action } });
    }
  });

  it.each([
    ["문제의 ID 꼴이 아님", { service: "backend", incident: "monitor:<b>", action: "rollback" }, "incident"],
    ["문제의 ID 가 65자", { service: "backend", incident: `monitor:${"a".repeat(57)}`, action: "rollback" }, "incident"],
    ["문제의 ID 가 둘", { service: "backend", incident: ["monitor:a", "monitor:b"], action: "rollback" }, "incident"],
    ["빈 ID", { service: "backend", incident: "", action: "rollback" }, "incident"],
    ["조치가 목록 밖", { service: "backend", incident: "monitor:front", action: "restart" }, "action"],
    ["조치가 없음", { service: "backend", incident: "monitor:front" }, "action"],
    ["판을 실어 보냄(서버가 정한다 — 받지 않는다)", { service: "backend", incident: "monitor:front", action: "rollback", commit: FULL_SHA }, "commit"],
    ["서비스가 목록 밖", { service: "nope", incident: "monitor:front", action: "rollback" }, "service"],
  ] as const)("%s → invalid_input(%s)", (_label, input, field) => {
    const result = parseRedeployPreviewRequest(input as Record<string, string | string[]>);
    expectFailure(result, "invalid_input");
    expect(result).toMatchObject({ ok: false, field });
  });

  it("문제의 조치 → 확인 화면의 주소(commit 없음)", () => {
    expect(incidentRedeployPreviewHref("backend", "monitor:front", "rollback")).toBe("/deploys/redeploy?service=backend&incident=monitor%3Afront&action=rollback");
  });
});
