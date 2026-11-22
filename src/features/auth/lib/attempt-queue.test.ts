import { describe, expect, it, vi } from "vitest";
import { createAttemptQueue, type QueuedRecord } from "@/features/auth/lib/attempt-queue";
import { FAKE_IP, FAKE_USER_AGENT } from "@/features/auth/lib/test-fakes";

function attemptRecord(index: number): QueuedRecord {
  return {
    kind: "attempt",
    body: {
      attempt_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      credential_ok: false, ip: FAKE_IP, user_agent: FAKE_USER_AGENT, replayed: false,
    },
  };
}

describe("시도 기록 대기열", () => {
  it("기본 상한은 500 — 501번째는 버리고 건수를 센다", () => {
    const queue = createAttemptQueue();
    for (let index = 0; index < 500; index += 1) expect(queue.enqueue(attemptRecord(index))).toBe(true);
    expect(queue.size()).toBe(500);
    expect(queue.droppedCount()).toBe(0);
    expect(queue.enqueue(attemptRecord(500))).toBe(false);
    expect(queue.enqueue(attemptRecord(501))).toBe(false);
    expect(queue.size()).toBe(500);
    expect(queue.droppedCount()).toBe(2);
  });

  it("들어온 순서대로 보내고 다 보내면 비어 있다", async () => {
    const queue = createAttemptQueue({ capacity: 10 });
    [1, 2, 3].forEach((index) => queue.enqueue(attemptRecord(index)));
    const sent: QueuedRecord[] = [];
    const result = await queue.flush(async (record) => { sent.push(record); return true; });
    expect(result).toEqual({ sent: 3, remaining: 0 });
    expect(sent).toEqual([attemptRecord(1), attemptRecord(2), attemptRecord(3)]);
    expect(queue.size()).toBe(0);
  });

  it("전송 실패(false)면 그 항목부터 대기열에 남기고, 다음에 이어서 보낸다", async () => {
    const queue = createAttemptQueue({ capacity: 10 });
    [1, 2, 3].forEach((index) => queue.enqueue(attemptRecord(index)));
    const send = vi.fn<(record: QueuedRecord) => Promise<boolean>>()
      .mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await queue.flush(send)).toEqual({ sent: 1, remaining: 2 });
    expect(queue.size()).toBe(2);
    const sent: QueuedRecord[] = [];
    expect(await queue.flush(async (record) => { sent.push(record); return true; })).toEqual({ sent: 2, remaining: 0 });
    expect(sent).toEqual([attemptRecord(2), attemptRecord(3)]);
  });

  it("전송이 예외를 던져도 항목을 잃지 않는다", async () => {
    const queue = createAttemptQueue({ capacity: 10 });
    [1, 2].forEach((index) => queue.enqueue(attemptRecord(index)));
    const result = await queue.flush(async () => { throw new Error("observe down (fake)"); });
    expect(result).toEqual({ sent: 0, remaining: 2 });
    expect(queue.size()).toBe(2);
  });

  it("보낸 뒤 비면 다시 상한까지 받는다(버린 건수는 누적 유지)", async () => {
    const queue = createAttemptQueue({ capacity: 2 });
    queue.enqueue(attemptRecord(1)); queue.enqueue(attemptRecord(2)); queue.enqueue(attemptRecord(3));
    await queue.flush(async () => true);
    expect(queue.enqueue(attemptRecord(4))).toBe(true);
    expect(queue.droppedCount()).toBe(1);
  });

  it("보내는 동안 들어온 항목도 잃지 않는다", async () => {
    const queue = createAttemptQueue({ capacity: 10 });
    queue.enqueue(attemptRecord(1));
    const sent: string[] = [];
    await queue.flush(async (record) => {
      sent.push(record.body.attempt_id);
      if (sent.length === 1) queue.enqueue(attemptRecord(2));
      return true;
    });
    const total = sent.length + queue.size();
    expect(total).toBe(2);
  });
});
