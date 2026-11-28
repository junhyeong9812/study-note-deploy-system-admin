/** 의존의 선 — 읽기(순수 · 명세 T9d "읽는 것"). 세 서비스의 본문 → {service, dependency, state, tookMs, reason}.
 * 상태 코드를 보지 않는다(이 함수는 본문만 받는다) · 모르는 칸 무시 · components 없음(옛 판) → 그 서비스 모두 모름(unparseable) ·
 * 의존 하나의 칸만 틀리면 그 하나만 모름 · 표의 의존이 없으면 not_reported · 표 밖의 이름은 버린다 · detail 은 싣지 않는다. */
import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_NAMES, DEPENDENCY_SOURCES, DEPENDENCY_STALE_MILLISECONDS, dependencyLinesFromBody, unknownDependencyLines, type DependencyLine,
} from "@/features/traffic-map/lib/dependency-lines";
import {
  DEPENDENCY_DETAIL_MARKER, DEPENDENCY_LEAKED_ADDRESS, backendBody, llmBody, observeBody, oldBackendBody, oldLlmBody, oldObserveBody,
} from "@/features/traffic-map/lib/dependency-test-fakes";

const up = (service: string, dependency: string, tookMs: number | null): DependencyLine => ({ service, dependency, state: "up", tookMs, reason: null } as DependencyLine);
const down = (service: string, dependency: string, tookMs: number | null): DependencyLine => ({ service, dependency, state: "down", tookMs, reason: null } as DependencyLine);
const unknown = (service: string, dependency: string, reason: string): DependencyLine => ({ service, dependency, state: "unknown", tookMs: null, reason } as DependencyLine);

function expectNoDetail(value: unknown) {
  const text = JSON.stringify(value);
  for (const word of [DEPENDENCY_DETAIL_MARKER, DEPENDENCY_LEAKED_ADDRESS, "detail", "Connection refused"]) expect(text, word).not.toContain(word);
}

describe("닫힌 표", () => {
  it("의존 이름 다섯 · 서비스 셋(통신 지도의 마디 이름) · 경로 · 짝 · 낡음 90초", () => {
    expect([...DEPENDENCY_NAMES]).toEqual(["elasticsearch", "embedding", "redis", "postgres", "ollama"]);
    expect(DEPENDENCY_SOURCES.map((source) => [source.service, source.path, [...source.dependencies]])).toEqual([
      ["backend", "/api/health/dependencies", ["elasticsearch", "embedding", "redis", "postgres"]],
      ["llm-wrapper", "/health", ["ollama"]],
      ["observe", "/health", ["redis", "postgres"]],
    ]);
    expect(DEPENDENCY_STALE_MILLISECONDS).toBe(90_000);
  });
});

describe("1 지금 판의 본문", () => {
  it("backend — UP 은 연결됨(걸린 시간) · DOWN 은 끊김(took_ms null 이면 null) · 표의 차례 · detail 없음", () => {
    const lines = dependencyLinesFromBody("backend", backendBody());
    expect(lines).toEqual([up("backend", "elasticsearch", 12), down("backend", "embedding", null), up("backend", "redis", 1), up("backend", "postgres", 3)]);
    expectNoDetail(lines);
  });

  it("끊김에도 걸린 시간이 있으면 함께(응답은 받았으나 쓸 수 없는 답)", () => {
    expect(dependencyLinesFromBody("backend", backendBody({ elasticsearch: { status: "DOWN", took_ms: 41, detail: "red" } }))[0]).toEqual(down("backend", "elasticsearch", 41));
  });

  it("llm — 정상 · 끊김(503 과 함께 오는 본문도 같은 함수로 읽는다 — 상태 코드는 보지 않는다)", () => {
    expect(dependencyLinesFromBody("llm-wrapper", llmBody())).toEqual([up("llm-wrapper", "ollama", 12)]);
    const lines = dependencyLinesFromBody("llm-wrapper", llmBody({ status: "DOWN", took_ms: null, detail: `unreachable ${DEPENDENCY_DETAIL_MARKER}` }));
    expect(lines).toEqual([down("llm-wrapper", "ollama", null)]);
    expectNoDetail(lines);
  });

  it("observe — redis · postgres · metrics · traffic 같은 모르는 칸은 무시", () => {
    const lines = dependencyLinesFromBody("observe", observeBody({ redis: { status: "DOWN", took_ms: null, detail: "RedisConnectionFailureException" }, postgres: { status: "UP", took_ms: 5 } }));
    expect(lines).toEqual([down("observe", "redis", null), up("observe", "postgres", 5)]);
    expect(JSON.stringify(lines)).not.toContain("RedisConnectionFailureException");
    expectNoDetail(lines);
  });

  it("components 의 칸 안 모르는 칸(extra)도 무시", () => {
    expect(dependencyLinesFromBody("llm-wrapper", llmBody({ status: "UP", took_ms: 0, extra: DEPENDENCY_LEAKED_ADDRESS }))).toEqual([up("llm-wrapper", "ollama", 0)]);
  });
});

describe("1 옛 판의 본문", () => {
  it("took_ms 가 없는 backend — 상태는 읽고 걸린 시간은 null", () => {
    expect(dependencyLinesFromBody("backend", oldBackendBody())).toEqual([
      up("backend", "elasticsearch", null), down("backend", "embedding", null), up("backend", "redis", null), up("backend", "postgres", null),
    ]);
  });

  it.each([
    ["components 가 없는 llm", "llm-wrapper", oldLlmBody(), ["ollama"]],
    ["components 가 없는 observe", "observe", oldObserveBody(), ["redis", "postgres"]],
  ] as const)("%s → 그 서비스의 선 모두 모름(unparseable)", (_label, service, body, dependencies) => {
    expect(dependencyLinesFromBody(service, body)).toEqual(dependencies.map((dependency) => unknown(service, dependency, "unparseable")));
  });
});

describe("1 꼴이 틀림", () => {
  it.each([
    ["JSON 이 아님(풀지 못함)", undefined],
    ["본문이 배열", [backendBody()]],
    ["본문이 글", "UP"],
    ["components 가 배열", { status: "UP", components: [] }],
    ["components 가 null", { status: "UP", components: null }],
  ] as [string, unknown][])("%s → backend 넷 모두 모름(unparseable)", (_label, body) => {
    expect(dependencyLinesFromBody("backend", body)).toEqual(["elasticsearch", "embedding", "redis", "postgres"].map((dependency) => unknown("backend", dependency, "unparseable")));
  });

  it.each([
    ["값이 객체가 아님", "UP"],
    ["status 가 다른 글(up)", { status: "up", took_ms: 1 }],
    ["status 가 OK", { status: "OK", took_ms: 1 }],
    ["status 없음", { took_ms: 1 }],
    ["took_ms 음수", { status: "UP", took_ms: -1 }],
    ["took_ms 소수", { status: "UP", took_ms: 1.5 }],
    ["took_ms 글", { status: "UP", took_ms: "12" }],
  ] as [string, unknown][])("부분만 틀림 — redis 의 %s → redis 하나만 모름(unparseable), 나머지는 그대로", (_label, redis) => {
    expect(dependencyLinesFromBody("backend", backendBody({ redis }))).toEqual([
      up("backend", "elasticsearch", 12), down("backend", "embedding", null), unknown("backend", "redis", "unparseable"), up("backend", "postgres", 3),
    ]);
  });
});

describe("1 표와 다른 이름", () => {
  it("표의 의존이 본문에 없으면 그 선은 모름(not_reported)", () => {
    const body = backendBody();
    delete (body.components as Record<string, unknown>).embedding;
    expect(dependencyLinesFromBody("backend", body)[1]).toEqual(unknown("backend", "embedding", "not_reported"));
  });

  it("표 밖의 이름(kafka · 그 서비스의 짝이 아닌 ollama)은 버린다 — 선이 생기지 않는다", () => {
    const lines = dependencyLinesFromBody("backend", backendBody({ kafka: { status: "UP", took_ms: 1 }, ollama: { status: "UP", took_ms: 1 } }));
    expect(lines.map((line) => line.dependency)).toEqual(["elasticsearch", "embedding", "redis", "postgres"]);
    expect(JSON.stringify(lines)).not.toContain("kafka");
  });

  it("observe 가 elasticsearch 를 알려도 버린다(짝이 아니다)", () => {
    const lines = dependencyLinesFromBody("observe", observeBody({ redis: { status: "UP", took_ms: 2 }, postgres: { status: "UP", took_ms: 5 }, elasticsearch: { status: "DOWN", took_ms: null } }));
    expect(lines.map((line) => line.dependency)).toEqual(["redis", "postgres"]);
  });
});

describe("unknownDependencyLines — 그 서비스의 선 모두 모름", () => {
  it.each(["not_configured", "unreachable", "timeout"] as const)("%s", (reason) => {
    expect(unknownDependencyLines("observe", reason)).toEqual([unknown("observe", "redis", reason), unknown("observe", "postgres", reason)]);
    expect(unknownDependencyLines("llm-wrapper", reason)).toEqual([unknown("llm-wrapper", "ollama", reason)]);
  });
});
