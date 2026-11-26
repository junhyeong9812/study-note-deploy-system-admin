/** 리뷰 C1 — `claude` 가 배포 서비스가 된 뒤의 컨테이너 → 서비스 판정. 실행 자리의 compose 는 `container_name: claude-runner` 로 고정한다.
 * `claude` 의 컨테이너는 `claude-runner` 와 `claude-runner-` 로 시작하는 것뿐 — 옛 통로의 중계(`claude-bridge-relay`) 같은 `claude-` 이름을 잡지 않는다.
 * 잘못 잡으면 그 서버의 서비스가 둘이 되어(`[backend, claude]`) 문제 화면이 backend 의 조치를 내지 못하거나, 틀린 대상(claude)을 고른다. */
import { describe, expect, it } from "vitest";
import { incidentActionServiceOf } from "@/features/incidents/lib/incident-actions";
import { servicesOnServer } from "@/features/incidents/lib/incident-evidence";
import type { OpenIncident } from "@/features/incidents/lib/incident-list";
import { containerBelongsToService, serviceContainerName } from "@/features/log-trace/lib/trace-resources";
import type { LatestResources } from "@/features/resources/lib/resource-metrics-client";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

/** servicesOnServer 가 읽는 것만 — 서버 이름과 컨테이너의 계열 이름. */
function latestWith(server: string, seriesNames: string[]): UpstreamResult<LatestResources> {
  return { ok: true, value: { servers: [{ server, containers: seriesNames.map((seriesName) => ({ seriesName })) }] } } as unknown as UpstreamResult<LatestResources>;
}

const RESOURCE_INCIDENT = { kind: "resource_threshold" } as OpenIncident;

describe("1 claude 의 컨테이너는 claude-runner(와 claude-runner-…)뿐", () => {
  it.each([
    ["claude-runner", true], ["claude-runner-1", true], ["claude-runner-test", true],
    ["claude-bridge-relay", false], ["claude-bridge", false], ["claude", false], ["claudette", false], ["claude-app", false],
    ["claude-runnerx", false], ["Claude-runner", false], ["x-claude-runner", false],
  ] as const)("%s → %s", (seriesName, expected) => {
    expect(containerBelongsToService(seriesName, "claude")).toBe(expected);
  });

  it("claude-runner 는 다른 서비스의 컨테이너가 아니다", () => {
    for (const service of ["front", "backend", "llm", "alert", "observe", "admin"]) expect(containerBelongsToService("claude-runner", service), service).toBe(false);
  });

  it.each([
    ["backend-app", "backend", true], ["backend-embedding", "backend", true], ["backend", "backend", true], ["front-app", "front", true],
    ["front-nginx", "front", true], ["observe-engine", "observe", true], ["observe-postgres", "observe", true], ["llm-ollama", "llm", true],
    ["llm-wrapper", "llm", true], ["admin-app", "admin", true], ["alert-app", "alert", true], ["frontier-app", "front", false], ["admin-app", "alert", false],
  ] as const)("다른 여섯 서비스는 그대로(이름이 같거나 <서비스>- 로 시작) — %s 는 %s → %s", (seriesName, service, expected) => {
    expect(containerBelongsToService(seriesName, service)).toBe(expected);
  });
});

describe("2 그 서버의 서비스와 조치의 대상", () => {
  it.each([
    ["backend-app · backend-embedding · claude-bridge-relay", ["backend-app", "backend-embedding", "claude-bridge-relay"], ["backend"], { ok: true, service: "backend" }],
    ["backend-app · claude-runner", ["backend-app", "claude-runner"], ["backend", "claude"], { ok: false, reason: "several_services" }],
    ["claude-runner 만", ["claude-runner"], ["claude"], { ok: true, service: "claude" }],
    ["claude-bridge-relay 만", ["claude-bridge-relay"], [], { ok: false, reason: "services_not_found" }],
  ] as [string, string[], string[], unknown][])("%s", (_label, containers, services, action) => {
    const found = servicesOnServer(latestWith("158", containers), "158");
    expect(found).toEqual(services);
    expect(incidentActionServiceOf(RESOURCE_INCIDENT, found)).toEqual(action);
  });
});

describe("3 값을 보일 컨테이너의 이름", () => {
  it("claude → claude-runner(짐작한 claude-app 이 아니다) · 다른 서비스는 그대로", () => {
    expect(serviceContainerName("claude")).toBe("claude-runner");
    expect(serviceContainerName("backend")).toBe("backend-app");
    expect(serviceContainerName("llm")).toBe("llm-wrapper");
    expect(serviceContainerName("claude-runner")).toBe("claude-runner-app");   // 로그 이름으로 들어온 짐작은 건드리지 않는다(범위 밖)
  });
});
