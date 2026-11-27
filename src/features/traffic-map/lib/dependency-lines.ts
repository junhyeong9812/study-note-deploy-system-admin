/** 의존의 선(⑬ T9d — 명세 "T9d — 지도에 의존의 선을 그린다") — 세 서비스의 의존 상태 본문 → 선의 목록(순수 — 브라우저 조각도 이 파일을 쓴다:
 * 서버 모듈 · 설정 · fetch 를 값으로 가져오지 않는다).
 * 뼈대: 테스트 설계 워커가 계약(이름 · 꼴 · 상수)만 고정했다. 함수의 몸은 구현 워커가 채운다.
 *
 * - 서비스 · 의존은 닫힌 표(DEPENDENCY_SOURCES)의 짝만 선이 된다 — 서비스 이름은 통신 지도의 마디 이름(llm 은 `llm-wrapper`).
 *   선의 차례는 표의 차례(backend 의 넷 → llm-wrapper 의 하나 → observe 의 둘).
 * - 읽는 것: 본문의 `components.<의존> = {status: "UP"|"DOWN", took_ms: 0 이상 정수|null(칸이 없으면 null — 옛 판의 backend), detail?}` 만.
 *   **상태 코드는 보지 않는다**(503 + 본문도 읽는다). 모르는 칸은 무시. **`detail` 은 결과에 싣지 않는다.**
 * - 본문이 JSON 객체가 아님 · `components` 가 없음(옛 판) · `components` 가 객체가 아님 → 그 서비스의 선 모두 모름(`unparseable`).
 * - **부분만 틀렸을 때**: 그 의존 하나만 모름(`unparseable`) — 값이 객체가 아님 · `status` 가 UP/DOWN 이 아님 · `took_ms` 가 음수 · 소수 · 글.
 *   나머지 의존은 그대로 읽는다.
 * - 표의 의존이 `components` 에 없으면 그 선은 모름(`not_reported`). **표 밖의 의존 이름**(`kafka` · 그 서비스의 짝이 아닌 이름)은 버린다(선 · 노드 · 표 어디에도 없다).
 * - 선의 상태: `UP` → up(걸린 시간) · `DOWN` → down(걸린 시간이 있으면 함께) · 그 밖 → unknown(까닭). up · down 의 reason 은 null. */

export const DEPENDENCY_NAMES = ["elasticsearch", "embedding", "redis", "postgres", "ollama"] as const;
export type DependencyName = (typeof DEPENDENCY_NAMES)[number];

/** 서비스(통신 지도의 마디 이름) → 부르는 경로 · 의존(닫힌 표). */
export const DEPENDENCY_SOURCES = [
  { service: "backend", path: "/api/health/dependencies", dependencies: ["elasticsearch", "embedding", "redis", "postgres"] },
  { service: "llm-wrapper", path: "/health", dependencies: ["ollama"] },
  { service: "observe", path: "/health", dependencies: ["redis", "postgres"] },
] as const;
export type DependencyServiceName = (typeof DEPENDENCY_SOURCES)[number]["service"];

/** 마지막 확인이 이보다 오래되면 낡은 값(통신 쪽의 낡음 표시와 같은 글). */
export const DEPENDENCY_STALE_MILLISECONDS = 90_000;

export type DependencyState = "up" | "down" | "unknown";

/** 모름의 까닭 — not_configured: 그 서비스의 주소 설정이 없음(부르지 않았다) · unreachable: 닿지 못함 · timeout: 4초 안에 답(본문까지)이 끝나지 않음 ·
 * unparseable: 본문의 꼴이 틀림(옛 판 포함) · not_reported: 그 서비스가 이 의존을 알리지 않음. */
export type DependencyUnknownReason = "not_configured" | "unreachable" | "timeout" | "unparseable" | "not_reported";

export interface DependencyLine {
  service: DependencyServiceName;
  dependency: DependencyName;
  state: DependencyState;
  tookMs: number | null;
  /** unknown 일 때만 — up · down 은 null */
  reason: DependencyUnknownReason | null;
}

/** 그 서비스의 본문(JSON 을 푼 값 — 풀지 못했으면 undefined) → 그 서비스의 선(표의 차례). */
export function dependencyLinesFromBody(_service: DependencyServiceName, _body: unknown): DependencyLine[] {
  throw new Error("not implemented: dependencyLinesFromBody");
}

/** 그 서비스의 선 모두를 모름으로(까닭 하나). */
export function unknownDependencyLines(_service: DependencyServiceName, _reason: DependencyUnknownReason): DependencyLine[] {
  throw new Error("not implemented: unknownDependencyLines");
}
