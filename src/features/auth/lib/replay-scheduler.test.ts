/** 세부 4 — 기본 스케줄러는 프로세스 종료를 막지 않는다(unref). */
import { describe, expect, it, vi } from "vitest";
import { unrefScheduler } from "@/features/auth/lib/replay-scheduler";

describe("unrefScheduler", () => {
  it("걸린 타이머는 프로세스를 붙잡지 않는다(keepsProcessAlive false), cancel 하면 실행되지 않는다", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const callback = vi.fn();
      const task = unrefScheduler(callback, 30_000);
      expect(task.keepsProcessAlive()).toBe(false);
      task.cancel();
      vi.advanceTimersByTime(60_000);
      expect(callback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("주어진 시간 뒤에 한 번 실행한다(가짜 타이머)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const callback = vi.fn();
      unrefScheduler(callback, 30_000);
      vi.advanceTimersByTime(29_999);
      expect(callback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("실제 Node 타이머에서도 hasRef 가 false(관찰 가능한 unref)", () => {
    const task = unrefScheduler(() => undefined, 30_000);
    try {
      expect(task.keepsProcessAlive()).toBe(false);
    } finally {
      task.cancel();
    }
  });
});
