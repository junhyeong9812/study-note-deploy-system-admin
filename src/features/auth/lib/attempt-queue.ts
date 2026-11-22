/** 관측 서버 장애 중의 시도 기록 대기열(인스턴스 메모리, 상한 500). 넘치면 버리고 건수를 센다.
 * 복귀 뒤 보낼 때는 원래 attempt_id · 시각을 유지하고 시도 기록은 replayed:true 로 보낸다(보내는 쪽 책임 — login-flow). */
import type { AttemptRecordBody, RejectedAttemptBody } from "@/features/auth/lib/types";

export type QueuedRecord =
  | { kind: "attempt"; body: AttemptRecordBody }
  | { kind: "rejected"; body: RejectedAttemptBody };

export interface AttemptQueueOptions {
  capacity?: number;   // 기본 500
}

export interface FlushResult {
  sent: number;
  remaining: number;
  /** 세부 3: send 가 "discard" 를 돌려줘 버린 항목 수(관측 서버 422 — 다시 보내도 같은 본문). */
  discarded: number;
}

export interface AttemptQueue {
  /** 넣었으면 true, 상한이라 버렸으면 false(버린 건수 +1). */
  enqueue(record: QueuedRecord): boolean;
  size(): number;
  droppedCount(): number;
  /** 들어온 순서대로 send 한다. send 가 false 를 돌려주거나 예외면 그 항목부터 대기열에 남기고 멈춘다.
   * "discard" 면 그 항목만 버리고(누적 유실 건수와는 따로 센다) 다음 항목으로 이어 간다. */
  flush(send: (record: QueuedRecord) => Promise<boolean | "discard">): Promise<FlushResult>;
}

export function createAttemptQueue(options: AttemptQueueOptions = {}): AttemptQueue {
  const capacity = options.capacity ?? 500;
  const records: QueuedRecord[] = [];
  let dropped = 0;

  return {
    enqueue(record) {
      if (records.length >= capacity) {
        dropped += 1;
        return false;
      }
      records.push(record);
      return true;
    },
    size: () => records.length,
    droppedCount: () => dropped,
    async flush(send) {
      let sent = 0;
      let discarded = 0;
      while (records.length > 0) {
        const head = records[0];
        let outcome: boolean | "discard" = false;
        try {
          outcome = await send(head);
        } catch {
          outcome = false;
        }
        if (outcome !== true && outcome !== "discard") break;
        // 보내는 동안 새 항목은 뒤에 붙었으므로 보낸(또는 버린) 항목만 뺀다
        const headIndex = records.indexOf(head);
        if (headIndex >= 0) records.splice(headIndex, 1);
        if (outcome === "discard") discarded += 1;
        else sent += 1;
      }
      return { sent, remaining: records.length, discarded };
    },
  };
}
