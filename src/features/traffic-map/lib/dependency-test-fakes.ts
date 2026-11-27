/** 테스트 전용 — 의존의 선(⑬ T9d)의 가짜 세 서비스. 본문은 각 저장소가 실제로 주는 꼴 그대로(읽기만 한 출처):
 * - backend `GET /api/health/dependencies` — 늘 200 · `{status, components:{elasticsearch|embedding|redis|postgres:{status, took_ms, detail?}}}`
 *   (backend README "의존 서비스 상태" · shared/api/DependencyHealthController.kt — detail 은 DOWN 일 때만 · 예외의 글이 든다 · 옛 판은 took_ms 가 없다)
 * - llm `GET /health` — 정상 200 · 그 밖 503 · `{status:"ok"|"model_missing"|"ollama_unreachable", model, components:{ollama:{…}}}`(llm README 헬스 절 — 옛 판은 components 가 없다)
 * - observe `GET /health` — `ok` 만 200 · `components:{redis, postgres}` + metrics · traffic 칸(observe README 헬스 표 — 옛 판은 components 가 없다)
 * detail 과 계약 밖 칸에는 일부러 표식 · 주소를 심는다 — 결과 · 화면 · 흐름 · 로그 어디에 나와도 실패다. */
import { vi } from "vitest";
import { FAKE_BACKEND_URL, FAKE_OBSERVE_URL, UPSTREAM_RAW_MARKER, jsonBody, textResponse } from "@/shared/lib/upstream-test-fakes";

export const FAKE_LLM_URL = "http://llm.example.test:8000";
/** 서비스가 준 detail 에 심는 표식 — 어디에도 나오면 안 된다. */
export const DEPENDENCY_DETAIL_MARKER = "dependency-detail-marker-dd7";
/** detail 에 심는 주소(문서용 대역 — RFC 5737). */
export const DEPENDENCY_LEAKED_ADDRESS = "203.0.113.41";
const LEAKY_DETAIL = `${DEPENDENCY_DETAIL_MARKER} Connection refused: ${DEPENDENCY_LEAKED_ADDRESS}:9200`;

export function backendBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "DOWN",
    components: {
      elasticsearch: { status: "UP", took_ms: 12 },
      embedding: { status: "DOWN", took_ms: null, detail: LEAKY_DETAIL },
      redis: { status: "UP", took_ms: 1 },
      postgres: { status: "UP", took_ms: 3 },
      ...overrides,
    },
  };
}

/** 옛 판의 backend — took_ms 칸이 없다. */
export function oldBackendBody(): Record<string, unknown> {
  return {
    status: "DOWN",
    components: {
      elasticsearch: { status: "UP" }, embedding: { status: "DOWN", detail: LEAKY_DETAIL }, redis: { status: "UP" }, postgres: { status: "UP" },
    },
  };
}

export function llmBody(ollama: Record<string, unknown> = { status: "UP", took_ms: 12 }): Record<string, unknown> {
  return { status: ollama.status === "UP" ? "ok" : "ollama_unreachable", model: "qwen2.5:7b", components: { ollama } };
}

/** 옛 판의 llm — components 가 없다. */
export function oldLlmBody(): Record<string, unknown> {
  return { status: "ok", model: "qwen2.5:7b" };
}

export function observeBody(components: Record<string, unknown> = { redis: { status: "UP", took_ms: 2 }, postgres: { status: "UP", took_ms: 5 } }): Record<string, unknown> {
  return {
    status: "ok", unacked: 0, lag: 0, last_log_at: "2026-11-30T01:00:00Z", components,
    metrics: { status: "ok", upstream: `${DEPENDENCY_LEAKED_ADDRESS}:6379` }, traffic: { status: "ok" }, extra: UPSTREAM_RAW_MARKER,
  };
}

/** 옛 판의 observe — components 가 없다. */
export function oldObserveBody(): Record<string, unknown> {
  return { status: "ok", unacked: 0, lag: 0, last_log_at: "2026-11-30T01:00:00Z" };
}

export type DependencyResponder = (init: RequestInit) => Response | Promise<Response>;

/** 세 서비스의 가짜 — 주소(origin + 경로)로 가르고, 받은 요청(주소 · 머리글)을 남긴다. 응답은 서비스마다 바꿔 끼운다. 그 밖의 주소는 던진다. */
export function createFakeDependencyServices() {
  const responders: Record<"backend" | "llm" | "observe", DependencyResponder> = {
    backend: () => jsonBody(backendBody()),
    llm: () => jsonBody(llmBody()),
    observe: () => jsonBody(observeBody()),
  };
  const requests: { service: "backend" | "llm" | "observe"; url: URL; init: RequestInit }[] = [];
  const routes: [string, "backend" | "llm" | "observe"][] = [
    [`${FAKE_BACKEND_URL}/api/health/dependencies`, "backend"], [`${FAKE_LLM_URL}/health`, "llm"], [`${FAKE_OBSERVE_URL}/health`, "observe"],
  ];
  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const route = routes.find(([address]) => address === `${url.origin}${url.pathname}`);
    if (route === undefined) throw new Error(`unexpected upstream ${url.origin}${url.pathname}`);
    requests.push({ service: route[1], url, init });
    return responders[route[1]](init);
  });
  return { responders, requests, fetch };
}

export { jsonBody, textResponse };
