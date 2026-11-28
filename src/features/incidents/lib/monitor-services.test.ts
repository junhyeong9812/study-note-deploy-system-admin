/** 감시 대상 이름 → 서비스의 대응 표(명세 ⑫ §7). 감시 대상 이름은 알림 서버 main 의 src/main/resources/monitors.yml 그대로:
 * front · backend · backend-deps · llm · deploy-master · deploy-agent-front · deploy-agent-backend · deploy-agent-llm · observe · admin.
 * 표에 없는 대상은 서비스를 짐작하지 않는다(null). */
import { describe, expect, it } from "vitest";
import { MONITOR_SERVICES, serviceForMonitor } from "@/features/incidents/lib/monitor-services";

describe("대응 표 — 알림 서버 monitors.yml 의 대상 이름", () => {
  it.each([
    ["front", "front"], ["backend", "backend"], ["backend-deps", "backend"], ["llm", "llm"], ["observe", "observe"], ["admin", "admin"],
  ])("%s → 서비스 %s", (name, service) => {
    expect(serviceForMonitor(name)).toBe(service);
  });

  it.each(["deploy-master", "deploy-agent-front", "deploy-agent-backend", "deploy-agent-llm"])(
    "%s → 표에 없음(null) — 배포 서버의 로그 이름 · 위치를 짐작하지 않는다", (name) => {
      expect(serviceForMonitor(name)).toBeNull();
    });

  it.each(["frontend", "Front", "front ", "brand-new-monitor", "", "constructor", "__proto__", "toString", "hasOwnProperty"])(
    "%j → 표에 없음(null) — 비슷한 이름 · 객체 기본 속성 이름을 서비스로 읽지 않는다", (name) => {
      expect(serviceForMonitor(name)).toBeNull();
    });

  it("표의 서비스는 배포 서비스 이름과 같은 낱말이다(로그의 service · 배포 이력의 service 로 그대로 쓴다)", () => {
    expect(Object.keys(MONITOR_SERVICES).sort()).toEqual(["admin", "backend", "backend-deps", "front", "llm", "observe"]);
    for (const service of Object.values(MONITOR_SERVICES)) expect(["front", "backend", "llm", "alert", "observe", "admin"]).toContain(service);
  });
});
