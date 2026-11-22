/** 서버 시작 때 한 번 — 설정 검사(Node.js 런타임에서만). Next 문서의 권장 형태: 런타임 조건 안에서 Node 전용 모듈을 동적 임포트한다. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportMissingConfiguration } = await import("@/shared/config/startup-check");
    reportMissingConfiguration();
  }
}
