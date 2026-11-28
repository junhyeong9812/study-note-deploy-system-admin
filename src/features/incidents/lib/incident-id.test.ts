/** 열린 문제의 식별자 — 주소에 실려 같은 문제를 다시 열고, 다음 조각이 배포 접수의 "누가"(`admin:<계정>:incident:<식별자>`)에 싣는다.
 * 배포 마스터의 requested_by 꼴 `^[A-Za-z0-9._:-]{1,128}$` 안이어야 하고, 길이 상한 64 를 넘지 않는다. */
import { describe, expect, it } from "vitest";
import {
  INCIDENT_ID_MAXIMUM_LENGTH, INCIDENT_ID_PATTERN, deployIncidentId, errorLogsIncidentId, incidentId, incidentKindOfId, isIncidentId,
  monitorIncidentId, resourceIncidentId,
} from "@/features/incidents/lib/incident-id";

/** 배포 마스터가 받는 requested_by 의 꼴(ci-cd feat/version-redeploy internal/master/master.go:48). */
const REQUESTED_BY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const HASHED_PATTERN = (prefix: string) => new RegExp(`^${prefix}:sha256-[0-9a-f]{16}$`);

function expectUsableId(id: string) {
  expect(id).toMatch(INCIDENT_ID_PATTERN);
  expect(id.length).toBeLessThanOrEqual(INCIDENT_ID_MAXIMUM_LENGTH);
  expect(isIncidentId(id)).toBe(true);
  // 계정 이름 48자까지는 requested_by 128자 안에 든다
  expect(`admin:${"a".repeat(48)}:incident:${id}`).toMatch(REQUESTED_BY_PATTERN);
}

describe("식별자의 꼴 — 종류 + 대상, 사람이 읽을 수 있게", () => {
  it("감시 대상 DOWN = monitor:<대상>", () => {
    expect(monitorIncidentId("front")).toBe("monitor:front");
    expect(monitorIncidentId("deploy-agent-backend")).toBe("monitor:deploy-agent-backend");
  });

  it("배포 실패 = deploy:<서비스>:<요청 ID>", () => {
    expect(deployIncidentId("backend", "3f2b9c1e-req")).toBe("deploy:backend:3f2b9c1e-req");
  });

  it("자원 임계값 = resource:<서버>:<규칙>[:<대상>]", () => {
    expect(resourceIncidentId("s158", "disk_critical", null)).toBe("resource:s158:disk_critical");
    expect(resourceIncidentId("s9", "restarts", "front-app-green")).toBe("resource:s9:restarts:front-app-green");
  });

  it("오류 로그 = errors:<서비스>", () => {
    expect(errorLogsIncidentId("llm")).toBe("errors:llm");
  });

  it("incidentId 는 종류 낱말과 부분을 `:` 로 잇는다", () => {
    expect(incidentId("monitor_down", ["front"])).toBe("monitor:front");
    expect(incidentId("resource_threshold", ["s1", "cpu"])).toBe("resource:s1:cpu");
  });

  it.each([
    ["monitor:front"], ["deploy:backend:abc"], ["resource:s158:disk_warning"], ["errors:llm"],
  ])("%s 는 쓸 수 있는 식별자 — requested_by 꼴 안", (id) => {
    expectUsableId(id);
  });
});

describe("길이 상한 · 허용 밖 글자 → 줄인 꼴(sha256-<16자>)", () => {
  it("상한 안쪽 경계 — 정확히 64자면 그대로", () => {
    const server = "s".repeat(64 - "resource::cpu".length);
    const id = resourceIncidentId(server, "cpu", null);
    expect(id).toBe(`resource:${server}:cpu`);
    expect(id).toHaveLength(64);
    expectUsableId(id);
  });

  it("상한 바깥 경계 — 65자가 되면 줄인 꼴", () => {
    const server = "s".repeat(65 - "resource::cpu".length);
    const id = resourceIncidentId(server, "cpu", null);
    expect(id).toMatch(HASHED_PATTERN("resource"));
    expectUsableId(id);
  });

  it("긴 서버 이름(63자) + 긴 컨테이너 이름(128자)도 64자 안", () => {
    const id = resourceIncidentId("a".repeat(63), "restarts", "c".repeat(128));
    expect(id).toMatch(HASHED_PATTERN("resource"));
    expectUsableId(id);
  });

  it.each([
    ["공백", "front app"], ["한글", "프런트"], ["슬래시", "front/app"], ["태그", "<script>"], ["빈 글자", ""], ["콜론이 든 이름", "a:b"],
  ])("허용 밖 글자(%s)가 든 대상 이름은 줄인 꼴 — 허용 밖 글자가 식별자에 들어가지 않는다", (_label, name) => {
    const id = monitorIncidentId(name);
    expect(id).toMatch(HASHED_PATTERN("monitor"));
    expectUsableId(id);
  });

  it("같은 입력은 같은 식별자, 다른 입력은 다른 식별자(줄인 꼴끼리도)", () => {
    expect(monitorIncidentId("front app")).toBe(monitorIncidentId("front app"));
    expect(monitorIncidentId("front app")).not.toBe(monitorIncidentId("front  app"));
    const longServer = "a".repeat(63);
    expect(resourceIncidentId(longServer, "restarts", "c".repeat(128))).not.toBe(resourceIncidentId(longServer, "restarts", "d".repeat(128)));
    expect(resourceIncidentId(longServer, "cpu", null)).not.toBe(resourceIncidentId(longServer, "memory", null));
  });

  it("종류가 다르면 대상이 같아도 다른 식별자", () => {
    expect(monitorIncidentId("front")).not.toBe(errorLogsIncidentId("front"));
  });

  it("부분의 경계가 다르면 다른 식별자(콜론을 품은 부분은 이어 붙인 것과 섞이지 않는다)", () => {
    expect(resourceIncidentId("s1", "restarts", "x")).not.toBe(resourceIncidentId("s1:restarts", "x", null));
  });
});

describe("줄인 꼴의 해시는 부분의 경계를 지킨다(부분 안의 줄바꿈으로 경계가 섞이지 않는다)", () => {
  it("resourceIncidentId(\"a\\nb\", \"c\", null) 과 resourceIncidentId(\"a\", \"b\\nc\", null) 은 다르다", () => {
    const left = resourceIncidentId("a\nb", "c", null);
    const right = resourceIncidentId("a", "b\nc", null);
    expect(left).toMatch(HASHED_PATTERN("resource"));
    expect(right).toMatch(HASHED_PATTERN("resource"));
    expect(left).not.toBe(right);
    expectUsableId(left);
    expectUsableId(right);
  });

  it("대상이 있는 꼴 · 배포 실패의 꼴도 줄바꿈의 자리가 다르면 다른 식별자", () => {
    const ids = [resourceIncidentId("a\nb", "c", null), resourceIncidentId("a", "b\nc", null), resourceIncidentId("a b", "c", "d\ne"), resourceIncidentId("a b", "c\nd", "e")];
    expect(new Set(ids).size).toBe(ids.length);
    expect(deployIncidentId("a\nb", "c")).not.toBe(deployIncidentId("a", "b\nc"));
  });

  it("깨끗한 식별자(해시를 쓰지 않는 것)는 그대로", () => {
    expect(resourceIncidentId("s158", "restarts", "front-app-green")).toBe("resource:s158:restarts:front-app-green");
    expect(deployIncidentId("backend", "req-1")).toBe("deploy:backend:req-1");
    expect(monitorIncidentId("front")).toBe("monitor:front");
  });

  it("같은 입력은 언제나 같은 줄인 꼴", () => {
    expect(resourceIncidentId("a\nb", "c", null)).toBe(resourceIncidentId("a\nb", "c", null));
  });
});

describe("isIncidentId — 주소로 받은 글자의 검사", () => {
  it.each([
    ["monitor:front", true], ["errors:llm", true], ["resource:sha256-0123456789abcdef", true],
    ["", false], ["front", false], ["unknown:front", false], ["monitor:", false], ["monitor:front app", false],
    ["monitor:<script>", false], ["monitor:프런트", false], [`monitor:${"a".repeat(56)}`, true], [`monitor:${"a".repeat(57)}`, false],
  ])("%j → %s", (value, expected) => {
    expect(isIncidentId(value)).toBe(expected);
  });
});

describe("incidentKindOfId — 식별자의 종류", () => {
  it.each([
    ["monitor:front", "monitor_down"], ["deploy:front:r1", "deploy_failed"], ["resource:s1:cpu", "resource_threshold"], ["errors:llm", "error_logs"],
    ["other:x", null], ["monitor", null],
  ])("%s → %s", (value, expected) => {
    expect(incidentKindOfId(value)).toBe(expected);
  });
});
