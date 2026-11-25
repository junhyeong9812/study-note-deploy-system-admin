/** 감시 대상 이름 → 서비스(로그의 service 이름 = 배포 서비스 이름)의 대응 표(순수 — 코드 상수).
 * 감시 대상 이름은 알림 서버 저장소의 `src/main/resources/monitors.yml` 에 있다(배치마다 다르지 않다 — 주소만 환경 변수).
 * 서버는 표에 두지 않는다 — 서버 이름은 배치마다 다르므로, 그 서비스의 컨테이너가 그때 보인 서버를 관측 서버에서 찾는다(로그 추적의 자원 칸과 같은 방법).
 * 표에 없는 대상(배포 마스터 · 배포 agent 들, 그 밖의 새 이름)은 "서비스 · 서버를 모름" — 짐작하지 않는다. */

export const MONITOR_SERVICES: Readonly<Record<string, string>> = {
  front: "front", backend: "backend", "backend-deps": "backend", llm: "llm", observe: "observe", admin: "admin",
};

/** 표에 있으면 그 서비스, 없으면 null(객체의 기본 속성 이름 — constructor · __proto__ 등 — 도 null). */
export function serviceForMonitor(monitor: string): string | null {
  return Object.hasOwn(MONITOR_SERVICES, monitor) ? MONITOR_SERVICES[monitor] : null;
}
