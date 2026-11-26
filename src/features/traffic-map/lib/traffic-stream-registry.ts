/** 열린 흐름의 목록(순수) — 흐름은 열릴 때 닫는 함수를 넣고(add — 돌려준 함수로 뺀다), 프로세스가 멈출 때 closeAll 이 모두 닫는다.
 * closeAll 뒤에는 closed 가 참 — 그 뒤에 넣는 흐름은 곧바로 닫는다(새 연결은 받지 않는다 — 진입이 503 으로 먼저 거절한다). */
export interface TrafficStreamRegistry {
  /** 넣는다 — 돌려주는 함수를 부르면 뺀다(두 번 불러도 한 번) */
  add(close: () => void): () => void;
  /** 넣어 둔 흐름을 모두 닫고(닫는 함수가 던져도 나머지를 닫는다) closed 로 둔다. 두 번 불러도 같다 */
  closeAll(): void;
  readonly closed: boolean;
  size(): number;
}

/** 닫는 함수 하나 — 던져도 다음으로 간다(멈추는 중이다 — 하나 때문에 나머지를 남기지 않는다). */
function closeQuietly(close: () => void): void {
  try {
    close();
  } catch {
    // 이미 닫힌 흐름 등 — 멈춤을 이어 간다
  }
}

export function createTrafficStreamRegistry(): TrafficStreamRegistry {
  const entries = new Set<{ close: () => void }>();
  let closed = false;
  return {
    add(close) {
      if (closed) {
        closeQuietly(close);
        return () => {};
      }
      const entry = { close };
      entries.add(entry);
      return () => { entries.delete(entry); };
    },
    closeAll() {
      closed = true;
      // 닫는 함수 안에서 스스로를 빼도 빠짐없이 — 먼저 떠 두고 비운다
      const toClose = [...entries];
      entries.clear();
      for (const entry of toClose) closeQuietly(entry.close);
    },
    get closed() {
      return closed;
    },
    size: () => entries.size,
  };
}
