/** 세부 4 — 대기열의 주기 재전송 타이머. 대기열이 비어 있지 않은 동안 30초마다 재전송을 시도한다.
 * 흐름(login-flow)은 이 모양의 스케줄러를 주입받는다 — 테스트는 직접 돌리는 Fake 를 준다(실제 대기 없음). */

export const REPLAY_INTERVAL_MILLISECONDS = 30_000;

export interface ScheduledTask {
  cancel(): void;
  /** 이 타이머가 프로세스 종료를 붙잡는가 — 기본 스케줄러는 false 여야 한다(unref). */
  keepsProcessAlive(): boolean;
}

export type Scheduler = (callback: () => void, milliseconds: number) => ScheduledTask;

/** 기본 스케줄러 — setTimeout + unref(프로세스 종료를 막지 않는다). */
export const unrefScheduler: Scheduler = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  const unrefable = timer as unknown as { unref?: () => void; hasRef?: () => boolean };
  unrefable.unref?.();
  return {
    cancel: () => clearTimeout(timer),
    keepsProcessAlive: () => (typeof unrefable.hasRef === "function" ? unrefable.hasRef() : false),
  };
};
