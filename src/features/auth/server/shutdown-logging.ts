/** 세부 2 — 종료 때의 대기열. SIGTERM 을 받으면 대기 중 건수와 누적 유실 건수를 앱 로그 1줄로 남긴다.
 * 줄 형식(계약): `queued=<대기 건수>` 와 `dropped=<누적 유실 건수>` 를 담는다. IP · ID · 비밀번호 · UA 는 없다. */
import "server-only";

/** 지금의 로그인 서비스 대기열 상태를 앱 로그 1줄로 남긴다(SIGTERM 처리기의 본체). 로그인 서비스가 없으면 queued=0 dropped=0. */
export function logQueueOnShutdown(): void {
  throw new Error("not implemented");
}

/** instrumentation 의 register() 가 Node 런타임에서 1회 부른다 — SIGTERM 에 logQueueOnShutdown 을 물린다. */
export function registerShutdownLogging(): void {
  throw new Error("not implemented");
}
