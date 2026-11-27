/** 의존의 선 — 부르기(명세 T9d "부르는 곳"). 세 경로를 나란히 · 경로마다 기한 4초(본문까지 — 하나가 붙잡혀도 다른 둘의 결과가 나온다) ·
 * 상태 코드를 보지 않는다(503 + 본문도 읽는다) · 닿지 못함 · 기한 · 설정 없음의 까닭 · 호출자 머리글 · 요청 ID · 비밀값 머리글 없음 · 거부하지 않는다. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEPENDENCY_CALLER_SERVICE, DEPENDENCY_CHECK_TIMEOUT_MILLISECONDS, createDependencyClient } from "@/features/traffic-map/lib/dependency-client";
import type { DependencyLine } from "@/features/traffic-map/lib/dependency-lines";
import {
  DEPENDENCY_DETAIL_MARKER, DEPENDENCY_LEAKED_ADDRESS, FAKE_LLM_URL, backendBody, createFakeDependencyServices, llmBody, observeBody, oldLlmBody,
} from "@/features/traffic-map/lib/dependency-test-fakes";
import {
  FAKE_BACKEND_URL, FAKE_OBSERVE_URL, SECRET_HEADER_NAMES, createTimerTimeoutSignal, hangUntilAborted, headersOf, headersThenStalledBody, jsonBody,
  leakyNetworkError, respondAfter, textResponse,
} from "@/shared/lib/upstream-test-fakes";

function clientWith(services: ReturnType<typeof createFakeDependencyServices>, overrides: Partial<{ backendUrl: string; llmUrl: string; observeUrl: string }> = {},
                    timeoutSignal?: (milliseconds: number) => AbortSignal) {
  let counter = 0;
  return createDependencyClient({
    backendUrl: FAKE_BACKEND_URL, llmUrl: FAKE_LLM_URL, observeUrl: FAKE_OBSERVE_URL, ...overrides,
    fetch: (input, init) => services.fetch(input, init), timeoutSignal,
    newRequestId: () => { counter += 1; return `${"0".repeat(31)}${counter}`; },
  });
}

const byService = (lines: DependencyLine[], service: string) => lines.filter((line) => line.service === service);
const states = (lines: DependencyLine[]) => lines.map((line) => `${line.service}/${line.dependency}:${line.state}:${line.tookMs ?? "-"}:${line.reason ?? "-"}`);

afterEach(() => {
  vi.useRealTimers();
});

describe("2 세 경로를 부른다", () => {
  it("정상 — 선 일곱(backend 넷 · llm-wrapper 하나 · observe 둘)의 차례 · 경로마다 한 번 · GET", async () => {
    const services = createFakeDependencyServices();
    const lines = await clientWith(services).readDependencies();
    expect(states(lines)).toEqual([
      "backend/elasticsearch:up:12:-", "backend/embedding:down:-:-", "backend/redis:up:1:-", "backend/postgres:up:3:-",
      "llm-wrapper/ollama:up:12:-", "observe/redis:up:2:-", "observe/postgres:up:5:-",
    ]);
    expect(services.requests.map((request) => `${request.url.origin}${request.url.pathname}`).sort()).toEqual([
      `${FAKE_BACKEND_URL}/api/health/dependencies`, `${FAKE_LLM_URL}/health`, `${FAKE_OBSERVE_URL}/health`,
    ].sort());
    for (const request of services.requests) {
      expect((request.init.method ?? "GET").toUpperCase()).toBe("GET");
      expect(request.init.redirect).toBe("manual");
    }
  });

  it("머리글 — X-Caller-Service: admin · X-Request-Id(호출마다 새 값) · 비밀값 머리글 없음", async () => {
    expect(DEPENDENCY_CALLER_SERVICE).toBe("admin");
    const services = createFakeDependencyServices();
    await clientWith(services).readDependencies();
    const requestIds = services.requests.map((request) => headersOf(request.init).get("x-request-id"));
    expect(new Set(requestIds).size).toBe(3);
    for (const request of services.requests) {
      const headers = headersOf(request.init);
      expect(headers.get("x-caller-service")).toBe("admin");
      expect(headers.get("x-request-id")).toMatch(/^[0-9a-f]{32}$/);
      for (const name of [...SECRET_HEADER_NAMES, "x-claude-runner-settings-secret", "authorization"]) expect(headers.get(name), name).toBeNull();
    }
  });

  it("기본 요청 ID 는 16진수 소문자 32자 난수(규약 1.4)", async () => {
    const services = createFakeDependencyServices();
    await createDependencyClient({ backendUrl: FAKE_BACKEND_URL, llmUrl: FAKE_LLM_URL, observeUrl: FAKE_OBSERVE_URL, fetch: (input, init) => services.fetch(input, init) }).readDependencies();
    const requestIds = services.requests.map((request) => headersOf(request.init).get("x-request-id"));
    for (const requestId of requestIds) expect(requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(requestIds).size).toBe(3);
  });

  it("상태 코드를 보지 않는다 — llm · observe 의 503 + 본문도 읽는다", async () => {
    const services = createFakeDependencyServices();
    services.responders.llm = () => jsonBody(llmBody({ status: "DOWN", took_ms: null, detail: "unreachable" }), 503);
    services.responders.observe = () => jsonBody(observeBody({ redis: { status: "DOWN", took_ms: null, detail: "x" }, postgres: { status: "UP", took_ms: 5 } }), 503);
    const lines = await clientWith(services).readDependencies();
    expect(states(byService(lines, "llm-wrapper"))).toEqual(["llm-wrapper/ollama:down:-:-"]);
    expect(states(byService(lines, "observe"))).toEqual(["observe/redis:down:-:-", "observe/postgres:up:5:-"]);
  });

  it("detail 은 결과에 없다(서비스가 준 예외의 글 · 주소)", async () => {
    const services = createFakeDependencyServices();
    const text = JSON.stringify(await clientWith(services).readDependencies());
    for (const word of [DEPENDENCY_DETAIL_MARKER, DEPENDENCY_LEAKED_ADDRESS, "detail"]) expect(text).not.toContain(word);
  });
});

describe("2 실패의 까닭 — 그 서비스만", () => {
  it("닿지 못함 → unreachable(예외 글 없음) · 다른 서비스는 그대로", async () => {
    const services = createFakeDependencyServices();
    services.responders.backend = () => Promise.reject(leakyNetworkError());
    const lines = await clientWith(services).readDependencies();
    expect(states(byService(lines, "backend"))).toEqual([
      "backend/elasticsearch:unknown:-:unreachable", "backend/embedding:unknown:-:unreachable", "backend/redis:unknown:-:unreachable", "backend/postgres:unknown:-:unreachable",
    ]);
    expect(states(byService(lines, "llm-wrapper"))).toEqual(["llm-wrapper/ollama:up:12:-"]);
  });

  it("JSON 이 아닌 답(502 의 HTML 등) → unparseable", async () => {
    const services = createFakeDependencyServices();
    services.responders.observe = () => textResponse("<html>bad gateway</html>", 502, "text/html");
    expect(states(byService(await clientWith(services).readDependencies(), "observe"))).toEqual(["observe/redis:unknown:-:unparseable", "observe/postgres:unknown:-:unparseable"]);
  });

  it("옛 판의 llm(components 없음) → unparseable", async () => {
    const services = createFakeDependencyServices();
    services.responders.llm = () => jsonBody(oldLlmBody());
    expect(states(byService(await clientWith(services).readDependencies(), "llm-wrapper"))).toEqual(["llm-wrapper/ollama:unknown:-:unparseable"]);
  });

  it.each([["빈 값", ""], ["http(s) 가 아님", "ftp://llm.example.test"], ["주소가 아님", "llm.example.test:8000"]])(
    "LLM_URL 이 %s → llm-wrapper 는 not_configured · 부르지 않는다", async (_label, llmUrl) => {
      const services = createFakeDependencyServices();
      const lines = await clientWith(services, { llmUrl }).readDependencies();
      expect(states(byService(lines, "llm-wrapper"))).toEqual(["llm-wrapper/ollama:unknown:-:not_configured"]);
      expect(services.requests.map((request) => request.service).sort()).toEqual(["backend", "observe"]);
    });

  it("셋 모두 설정 없음 → 아무것도 부르지 않고 선 일곱 모두 not_configured", async () => {
    const services = createFakeDependencyServices();
    const lines = await clientWith(services, { backendUrl: "", llmUrl: "", observeUrl: "" }).readDependencies();
    expect(lines).toHaveLength(7);
    expect(lines.every((line) => line.state === "unknown" && line.reason === "not_configured")).toBe(true);
    expect(services.fetch).not.toHaveBeenCalled();
  });

  it("fetch 가 동기로 던져도 거부하지 않는다(unreachable)", async () => {
    const services = createFakeDependencyServices();
    const client = createDependencyClient({
      backendUrl: FAKE_BACKEND_URL, llmUrl: FAKE_LLM_URL, observeUrl: FAKE_OBSERVE_URL,
      fetch: () => { throw new Error(`boom ${DEPENDENCY_LEAKED_ADDRESS}`); },
    });
    const lines = await client.readDependencies();
    expect(lines.every((line) => line.state === "unknown" && line.reason === "unreachable")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(DEPENDENCY_LEAKED_ADDRESS);
    expect(services.fetch).not.toHaveBeenCalled();
  });
});

describe("2 경로마다 기한 4초(셋 모두 한 값) — 하나가 붙잡혀도 다른 둘의 결과가 나온다", () => {
  it(`observe 가 답하지 않으면 ${DEPENDENCY_CHECK_TIMEOUT_MILLISECONDS}ms 에 timeout · backend · llm 은 그대로 · 기한은 경로마다 하나씩`, async () => {
    vi.useFakeTimers();
    expect(DEPENDENCY_CHECK_TIMEOUT_MILLISECONDS).toBe(4_000);
    const services = createFakeDependencyServices();
    services.responders.observe = (init) => hangUntilAborted(init);
    const timer = createTimerTimeoutSignal();
    let settled = false;
    const pending = clientWith(services, {}, timer.factory).readDependencies().then((lines) => { settled = true; return lines; });
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CHECK_TIMEOUT_MILLISECONDS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const lines = await pending;
    expect(states(byService(lines, "observe"))).toEqual(["observe/redis:unknown:-:timeout", "observe/postgres:unknown:-:timeout"]);
    expect(states(byService(lines, "backend"))[0]).toBe("backend/elasticsearch:up:12:-");
    expect(states(byService(lines, "llm-wrapper"))).toEqual(["llm-wrapper/ollama:up:12:-"]);
    expect(timer.requestedMilliseconds).toEqual([4_000, 4_000, 4_000]);
  });

  it("머리글만 주고 본문을 끝내지 않아도(관측 서버가 Redis 를 기다리는 20초) 4초에 timeout", async () => {
    vi.useFakeTimers();
    const services = createFakeDependencyServices();
    services.responders.observe = (init) => headersThenStalledBody(init, 503);
    const timer = createTimerTimeoutSignal();
    const pending = clientWith(services, {}, timer.factory).readDependencies();
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CHECK_TIMEOUT_MILLISECONDS);
    expect(states(byService(await pending, "observe"))).toEqual(["observe/redis:unknown:-:timeout", "observe/postgres:unknown:-:timeout"]);
  });

  /** backend 는 의존 하나가 멈추면 전체 예산 3초를 다 쓰고 답한다(실측: PostgreSQL 멈춤의 첫 호출 3.02초) — 그 답을 받아야 끊긴 쪽을 보인다. */
  const slowBackend = () => jsonBody(backendBody({ postgres: { status: "DOWN", took_ms: null, detail: "3초 안에 응답 없음" } }));

  it("3.2초 뒤에 답하는 backend(의존 하나가 예산 초과로 DOWN · took_ms null) 를 읽는다 — 선 넷이 모름이 아니다", async () => {
    vi.useFakeTimers();
    const services = createFakeDependencyServices();
    services.responders.backend = (init) => respondAfter(3_200, slowBackend, init);
    const timer = createTimerTimeoutSignal();
    const pending = clientWith(services, {}, timer.factory).readDependencies();
    await vi.advanceTimersByTimeAsync(3_200);
    expect(states(byService(await pending, "backend"))).toEqual([
      "backend/elasticsearch:up:12:-", "backend/embedding:down:-:-", "backend/redis:up:1:-", "backend/postgres:down:-:-",
    ]);
  });

  it("4초를 넘겨 답하는 backend 는 timeout", async () => {
    vi.useFakeTimers();
    const services = createFakeDependencyServices();
    services.responders.backend = (init) => respondAfter(4_100, slowBackend, init);
    const timer = createTimerTimeoutSignal();
    const pending = clientWith(services, {}, timer.factory).readDependencies();
    await vi.advanceTimersByTimeAsync(4_100);
    expect(states(byService(await pending, "backend")).every((line) => line.endsWith(":unknown:-:timeout"))).toBe(true);
  });

  it("셋을 나란히 부른다 — 첫 경로의 답을 기다리지 않고 셋 모두 나간다", async () => {
    const services = createFakeDependencyServices();
    const gates: (() => void)[] = [];
    for (const service of ["backend", "llm", "observe"] as const) {
      const original = services.responders[service];
      services.responders[service] = (init) => new Promise<Response>((resolve) => { gates.push(() => resolve(original(init) as Response)); });
    }
    const pending = clientWith(services).readDependencies();
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(services.requests).toHaveLength(3);
    for (const open of gates) open();
    expect(await pending).toHaveLength(7);
  });

  it("backendBody 의 같은 꼴(테스트의 기준)", () => {
    expect(Object.keys(backendBody().components as object)).toEqual(["elasticsearch", "embedding", "redis", "postgres"]);
  });
});
