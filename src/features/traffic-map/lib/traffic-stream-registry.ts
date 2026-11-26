/** 열린 흐름의 목록(순수) — 뼈대(T8 리뷰 1 테스트가 컴파일되게 하는 꼴만, 구현 전).
 * 흐름은 열릴 때 닫는 함수를 넣고(add — 돌려준 함수로 뺀다), 프로세스가 멈출 때 closeAll 이 모두 닫는다.
 * closeAll 뒤에는 closed 가 참 — 그 뒤에 넣는 흐름은 곧바로 닫는다(새 연결은 받지 않는다 — 진입이 503 으로 먼저 거절한다). */
export interface TrafficStreamRegistry {
  /** 넣는다 — 돌려주는 함수를 부르면 뺀다(두 번 불러도 한 번) */
  add(close: () => void): () => void;
  /** 넣어 둔 흐름을 모두 닫고(닫는 함수가 던져도 나머지를 닫는다) closed 로 둔다. 두 번 불러도 같다 */
  closeAll(): void;
  readonly closed: boolean;
  size(): number;
}

export function createTrafficStreamRegistry(): TrafficStreamRegistry {
  throw new Error("T8 리뷰 1: 구현 전");
}
