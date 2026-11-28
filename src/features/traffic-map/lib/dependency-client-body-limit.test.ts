/** T9d 리뷰 R1 — 의존 상태의 본문에 크기 상한 64KB(65,536바이트 — 바이트로 센다).
 * 꼭 65,536 은 읽는다 · 65,537 은 끊는다(여러 바이트 글자로 — 글자 수로 세면 틀린다) · 넘으면 다 받지 않고 끊는다(흘린 바이트를 센다 · 읽기를 취소한다) ·
 * Content-Length 가 없거나 거짓이어도 지킨다 · 그 서비스의 선만 unparseable(다른 서비스는 그대로) · 기한 · 머리글은 그대로. */
import { describe, expect, it } from "vitest";
import { DEPENDENCY_BODY_MAX_BYTES, createDependencyClient } from "@/features/traffic-map/lib/dependency-client";
import type { DependencyLine } from "@/features/traffic-map/lib/dependency-lines";
import { FAKE_LLM_URL, createFakeDependencyServices, llmBodyOfBytes, streamingBody } from "@/features/traffic-map/lib/dependency-test-fakes";
import { FAKE_BACKEND_URL, FAKE_OBSERVE_URL, headersOf, textResponse } from "@/shared/lib/upstream-test-fakes";

const MEGABYTE = 1_048_576;

function clientWith(services: ReturnType<typeof createFakeDependencyServices>) {
  return createDependencyClient({
    backendUrl: FAKE_BACKEND_URL, llmUrl: FAKE_LLM_URL, observeUrl: FAKE_OBSERVE_URL, fetch: (input, init) => services.fetch(input, init),
  });
}

const llmLines = (lines: DependencyLine[]) => lines.filter((line) => line.service === "llm-wrapper").map((line) => `${line.state}:${line.reason ?? "-"}`);
const otherLines = (lines: DependencyLine[]) => lines.filter((line) => line.service !== "llm-wrapper").map((line) => `${line.service}/${line.dependency}:${line.state}`);
const NORMAL_OTHERS = ["backend/elasticsearch:up", "backend/embedding:down", "backend/redis:up", "backend/postgres:up", "observe/redis:up", "observe/postgres:up"];

describe("R1 경계 — 바이트로 센다", () => {
  it("상한은 65,536바이트", () => {
    expect(DEPENDENCY_BODY_MAX_BYTES).toBe(65_536);
  });

  it("꼭 65,536바이트(여러 바이트 글자로 채운 맞는 JSON)는 읽는다", async () => {
    const services = createFakeDependencyServices();
    const body = llmBodyOfBytes(65_536);
    services.responders.llm = () => textResponse(body, 200);
    expect(llmLines(await clientWith(services).readDependencies())).toEqual(["up:-"]);
  });

  it("65,537바이트(글자 수로는 상한보다 훨씬 적다)는 끊는다 → unparseable · 다른 서비스는 그대로", async () => {
    const services = createFakeDependencyServices();
    const body = llmBodyOfBytes(65_537);
    expect(body.length).toBeLessThan(65_536);   // 글자 수로 세면 상한 안이다
    services.responders.llm = () => textResponse(body, 200);
    const lines = await clientWith(services).readDependencies();
    expect(llmLines(lines)).toEqual(["unknown:unparseable"]);
    expect(otherLines(lines)).toEqual(NORMAL_OTHERS);
  });
});

describe("R1 넘으면 다 받지 않고 끊는다", () => {
  it.each([
    ["Content-Length 없음", {}],
    ["Content-Length 가 거짓(작게 말하고 크게 보냄)", { "Content-Length": "120" }],
    ["Content-Length 가 상한을 넘는다고 말함", { "Content-Length": String(32 * MEGABYTE) }],
  ] as [string, Record<string, string>][])("32MB 를 흘리는 llm(%s) → 상한 근처에서 읽기를 멈추고 취소 · unparseable · 다른 서비스는 그대로", async (_label, headers) => {
    const services = createFakeDependencyServices();
    const stream = streamingBody({ totalBytes: 32 * MEGABYTE, headers });
    services.responders.llm = () => stream.response;
    const lines = await clientWith(services).readDependencies();
    expect(llmLines(lines)).toEqual(["unknown:unparseable"]);
    expect(otherLines(lines)).toEqual(NORMAL_OTHERS);
    expect(stream.counter.sentBytes, "끝까지 받았다").toBeLessThanOrEqual(DEPENDENCY_BODY_MAX_BYTES + 4 * 16_384);
    expect(stream.counter.cancelled, "읽기를 취소하지 않았다").toBe(true);
  });

  it("503 과 함께 오는 큰 본문도 같다(상태 코드를 보지 않는 것은 그대로)", async () => {
    const services = createFakeDependencyServices();
    const stream = streamingBody({ totalBytes: 8 * MEGABYTE, status: 503 });
    services.responders.observe = () => stream.response;
    const lines = await clientWith(services).readDependencies();
    expect(lines.filter((line) => line.service === "observe").map((line) => line.reason)).toEqual(["unparseable", "unparseable"]);
    expect(stream.counter.sentBytes).toBeLessThanOrEqual(DEPENDENCY_BODY_MAX_BYTES + 4 * 16_384);
  });

  it("한 덩어리가 상한을 넘는 본문(64KB + 1 을 한 번에)도 끊는다", async () => {
    const services = createFakeDependencyServices();
    const stream = streamingBody({ totalBytes: 4 * MEGABYTE, chunkBytes: DEPENDENCY_BODY_MAX_BYTES + 1 });
    services.responders.backend = () => stream.response;
    const lines = await clientWith(services).readDependencies();
    expect(lines.filter((line) => line.service === "backend").every((line) => line.reason === "unparseable")).toBe(true);
    expect(stream.counter.sentBytes).toBeLessThanOrEqual(4 * (DEPENDENCY_BODY_MAX_BYTES + 1));
  });

  it("머리글 · GET · 리다이렉트는 그대로", async () => {
    const services = createFakeDependencyServices();
    services.responders.llm = () => streamingBody({ totalBytes: 2 * MEGABYTE }).response;
    await clientWith(services).readDependencies();
    for (const request of services.requests) {
      expect(headersOf(request.init).get("x-caller-service")).toBe("admin");
      expect(request.init.redirect).toBe("manual");
    }
  });
});
