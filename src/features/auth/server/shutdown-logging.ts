/** 세부 2 — 종료 때의 대기열. SIGTERM 을 받으면 대기 중 건수와 누적 유실 건수를 앱 로그 1줄로 남긴다.
 * 분석(문제 화면)이 이 프로세스에서 뒤에서 돌고 있으면 그 수도 한 줄로(`incident-analysis:shutdown running=<N>` — 분석 서비스가 만들어졌을 때만).
 * 줄 형식(계약): `queued=<대기 건수>` 와 `dropped=<누적 유실 건수>` 를 담는다. IP · ID · 비밀번호 · UA 는 없다.
 * 종료 자체는 Next standalone 서버의 SIGTERM 처리기(연결 정리 뒤 process.exit(0))가 한다 — 여기서는 로그만 남긴다.
 * NEXT_MANUAL_SIG_HANDLE 이 켜져 Next 처리기가 없으면 로그 뒤 직접 끝낸다(리스너를 단 탓에 기본 종료가 사라지지 않게). */
import "server-only";
import { existingLoginService } from "@/features/auth/server/login-service";
import { logIncidentAnalysisOnShutdown } from "@/features/incident-analysis/server/incident-analysis";
import { log } from "@/shared/lib/logger";

/** 지금의 로그인 서비스 대기열 상태를 앱 로그 1줄로 남긴다(SIGTERM 처리기의 본체). 로그인 서비스가 없으면 queued=0 dropped=0. */
export function logQueueOnShutdown(): void {
  // 세부 4: 아직 내보내지 않은 "기록하지 않은 거절" 건수도 남긴다
  existingLoginService()?.flow?.flushUnrecordedCounts();
  const attemptQueue = existingLoginService()?.attemptQueue ?? null;
  const queued = attemptQueue?.size() ?? 0;
  const dropped = attemptQueue?.droppedCount() ?? 0;
  void log("shutdown", `login:shutdown queued=${queued} dropped=${dropped}`, queued > 0 || dropped > 0 ? "warning" : "info");
  logIncidentAnalysisOnShutdown();
}

let registered = false;

/** instrumentation 의 register() 가 Node 런타임에서 1회 부른다 — SIGTERM 에 logQueueOnShutdown 을 물린다. */
export function registerShutdownLogging(): void {
  if (registered) return;
  registered = true;
  process.once("SIGTERM", () => {
    logQueueOnShutdown();
    if (process.env.NEXT_MANUAL_SIG_HANDLE) process.exit(0);
  });
}
