/** 세 서비스의 의존 상태 경로를 부르는 클라이언트(순수 — 설정을 읽지 않는다. 주소는 부르는 쪽이 준다).
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 몸은 구현 워커가 채운다.
 * - 세 경로(DEPENDENCY_SOURCES)를 **나란히** 부른다 · 경로마다 기한 DEPENDENCY_CHECK_TIMEOUT_MILLISECONDS(본문까지 — 하나가 붙잡혀도 다른 둘의 결과가 나온다).
 * - 주소가 비었거나 http(s) 로 해석되지 않으면 그 서비스는 부르지 않고 not_configured.
 * - 머리글: `Accept: application/json` · `X-Caller-Service: admin` · `X-Request-Id: <호출마다 새 16진수 소문자 32자>`(규약 1.4 — 들어온 요청 없이 스스로 시작하는 호출) ·
 *   비밀값 머리글은 싣지 않는다(상태 화면이 이 경로들을 부를 때와 같다). GET · redirect:"manual" · no-store.
 * - 결과는 dependencyLinesFromBody 그대로(상태 코드를 보지 않는다) · 닿지 못함 unreachable · 기한 timeout. 거부(reject)하지 않는다. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { DependencyLine } from "@/features/traffic-map/lib/dependency-lines";

/** 경로마다 한 값(셋 모두) — backend 가 의존 하나가 멈췄을 때 전체 예산 3초를 다 쓰고 답하는 것을 받는다(메인 11-30). */
export const DEPENDENCY_CHECK_TIMEOUT_MILLISECONDS = 4_000;
export const DEPENDENCY_CALLER_SERVICE = "admin";

export interface DependencyClientOptions {
  backendUrl: string;
  llmUrl: string;
  observeUrl: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
  /** 호출마다의 요청 ID — 기본은 16진수 소문자 32자 난수 */
  newRequestId?: () => string;
}

export interface DependencyClient {
  /** 선 전부(DEPENDENCY_SOURCES 의 차례) */
  readDependencies(): Promise<DependencyLine[]>;
}

export function createDependencyClient(_options: DependencyClientOptions): DependencyClient {
  throw new Error("not implemented: createDependencyClient");
}
