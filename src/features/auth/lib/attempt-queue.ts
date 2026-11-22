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
}

export interface AttemptQueue {
  /** 넣었으면 true, 상한이라 버렸으면 false(버린 건수 +1). */
  enqueue(record: QueuedRecord): boolean;
  size(): number;
  droppedCount(): number;
  /** 들어온 순서대로 send 한다. send 가 false 를 돌려주거나 예외면 그 항목부터 대기열에 남기고 멈춘다. */
  flush(send: (record: QueuedRecord) => Promise<boolean>): Promise<FlushResult>;
}

export function createAttemptQueue(options?: AttemptQueueOptions): AttemptQueue {
  throw new Error("not implemented");
}
