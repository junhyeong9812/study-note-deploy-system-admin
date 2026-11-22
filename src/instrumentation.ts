/** 서버 시작 때 한 번 — 설정 검사(필수 키 — 로그인 + 화면 넷 · 알림 — 가 없으면 끝낸다) · 선택 설정(LOG_REDIS_URL) 알림 · 종료 로그 등록(Node.js 런타임에서만).
 * Next 문서의 권장 형태: 런타임 조건 안에서 Node 전용 모듈을 동적 임포트한다. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkStartupConfiguration, reportMissingConfiguration } = await import("@/shared/config/startup-check");
    const { registerShutdownLogging } = await import("@/features/auth/server/shutdown-logging");
    checkStartupConfiguration();
    reportMissingConfiguration();
    registerShutdownLogging();
  }
}
