/** 통신 지도의 서버 쪽 — 의존의 선(⑬ T9d): 흐름에 `event: dependencies`(id 줄 없음) · 통신 지도의 사건과 따로 나간다 · 끊기면 두 구독 모두 거둔다 ·
 * 조회가 설정(BACKEND_URL · LLM_URL · OBSERVE_URL)을 그때 읽는다 · 설정이 없으면 부르지 않는다 · 모름인 서비스마다 앱 로그 1줄(주소 · 비밀값 · detail 없음) ·
 * 멈출 때 의존의 허브도 멈춘다 · 화면의 첫 그림은 의존의 마지막 확인(기다리지 않는다). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ cookieValues: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (navigation.cookieValues.has(name) ? { name, value: navigation.cookieValues.get(name)! } : undefined),
    has: (name: string) => navigation.cookieValues.has(name),
    getAll: () => [...navigation.cookieValues].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import { SESSION_COOKIE_NAME, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY, createFakeScheduler } from "@/features/auth/lib/test-fakes";
import type { DependencyLine } from "@/features/traffic-map/lib/dependency-lines";
import {
  DEPENDENCY_DETAIL_MARKER, DEPENDENCY_LEAKED_ADDRESS, FAKE_LLM_URL, createFakeDependencyServices,
} from "@/features/traffic-map/lib/dependency-test-fakes";
import type { TrafficDependencyEvent, TrafficDependencyHub, TrafficDependencyListener } from "@/features/traffic-map/lib/traffic-dependency-hub";
import type { TrafficMapEvent, TrafficMapHub, TrafficMapListener } from "@/features/traffic-map/lib/traffic-map-hub";
import { chatMapEdges, trafficMapEventOf } from "@/features/traffic-map/lib/traffic-map-test-fakes";
import { createTrafficStreamRegistry } from "@/features/traffic-map/lib/traffic-stream-registry";
import {
  loadTrafficDependencies, loadTrafficMapScreen, shutdownTrafficMap, trafficStreamResponse,
} from "@/features/traffic-map/server/traffic-map";
import { FAKE_BACKEND_URL, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL } from "@/shared/lib/upstream-test-fakes";

const MINUTE = 60_000;
const LINES: DependencyLine[] = [
  { service: "backend", dependency: "redis", state: "up", tookMs: 1, reason: null },
  { service: "llm-wrapper", dependency: "ollama", state: "down", tookMs: null, reason: null },
];

const consoleLines: string[] = [];
const openStreams: AbortController[] = [];

function streamRequest(controller = new AbortController()): Request {
  openStreams.push(controller);
  return new Request(new URL("/api/traffic/stream?range=5m", FAKE_ORIGIN), { method: "GET", headers: { origin: FAKE_ORIGIN }, signal: controller.signal });
}

function reader(response: Response) {
  const stream = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const blocks: string[] = [];
  return {
    blocks,
    async until(predicate: (blocks: string[]) => boolean) {
      const deadline = Date.now() + 1000;
      while (!predicate(blocks)) {
        const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now())));
        const read = stream.read().then((chunk) => {
          if (chunk.done) throw new Error("흐름이 끝났다");
          buffer += decoder.decode(chunk.value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index !== -1) { blocks.push(buffer.slice(0, index)); buffer = buffer.slice(index + 2); index = buffer.indexOf("\n\n"); }
          return "read" as const;
        });
        if ((await Promise.race([read, timeout])) === "timeout") throw new Error(`1초 안에 받지 못했다(받은 것 ${JSON.stringify(blocks)})`);
      }
      return blocks;
    },
    cancel: () => stream.cancel().catch(() => undefined),
  };
}

const dependencyBlocks = (blocks: string[]) => blocks.filter((block) => /^event: dependencies$/m.test(block));

function recordingMapHub() {
  const listeners = new Set<TrafficMapListener>();
  const hub: TrafficMapHub = {
    subscribe: vi.fn((_range, listener: TrafficMapListener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    snapshot: vi.fn(async () => trafficMapEventOf(1, chatMapEdges())),
    clear: vi.fn(),
    stop: vi.fn(),
  };
  return { hub, listeners, send: (event: TrafficMapEvent) => { for (const listener of [...listeners]) listener(event); } };
}

function recordingDependencyHub(last: TrafficDependencyEvent | null = null) {
  const listeners = new Set<TrafficDependencyListener>();
  const leaves: number[] = [];
  const hub: TrafficDependencyHub = {
    subscribe: vi.fn((listener: TrafficDependencyListener) => { listeners.add(listener); return () => { listeners.delete(listener); leaves.push(1); }; }),
    snapshot: vi.fn(() => last),
    stop: vi.fn(),
  };
  return { hub, listeners, leaves, send: (event: TrafficDependencyEvent) => { for (const listener of [...listeners]) listener(event); } };
}

const dependencyEvent = (sequence: number): TrafficDependencyEvent => ({ sequence, checkedAt: new Date(Date.UTC(2026, 10, 30, 4, 0, 0)).toISOString(), lines: LINES });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("BACKEND_URL", FAKE_BACKEND_URL);
  vi.stubEnv("LLM_URL", FAKE_LLM_URL);
  vi.stubEnv("LOG_REDIS_URL", "");
  navigation.cookieValues.clear();
  navigation.cookieValues.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, Date.now() - MINUTE));
  consoleLines.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  for (const controller of openStreams.splice(0)) controller.abort();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("4 흐름 — event: dependencies", () => {
  it("의존의 사건마다 `event: dependencies` · `data: <사건 JSON 한 줄>` · id 줄 없음 · 통신 지도의 사건과 따로", async () => {
    const map = recordingMapHub();
    const dependencies = recordingDependencyHub();
    const response = await trafficStreamResponse(streamRequest(), { hub: map.hub, dependencyHub: dependencies.hub, scheduler: createFakeScheduler().scheduler });
    const stream = reader(response);
    expect(dependencies.hub.subscribe).toHaveBeenCalledTimes(1);
    dependencies.send(dependencyEvent(1));
    const blocks = await stream.until((received) => dependencyBlocks(received).length === 1);
    const [block] = dependencyBlocks(blocks);
    expect(block).not.toMatch(/^id:/m);
    expect(JSON.parse(/^data: (.*)$/m.exec(block)![1])).toEqual(dependencyEvent(1));
    expect(blocks.some((received) => /^event: map$/m.test(received))).toBe(false);   // 통신 지도의 사건을 기다리지 않는다
    map.send(trafficMapEventOf(2, chatMapEdges()));
    await stream.until((received) => received.some((each) => /^event: map$/m.test(each)));
    stream.cancel();
  });

  it("클라이언트가 끊으면 두 구독 모두 거둔다", async () => {
    const map = recordingMapHub();
    const dependencies = recordingDependencyHub();
    const controller = new AbortController();
    await trafficStreamResponse(streamRequest(controller), { hub: map.hub, dependencyHub: dependencies.hub, scheduler: createFakeScheduler().scheduler });
    controller.abort();
    expect(map.listeners.size).toBe(0);
    expect(dependencies.listeners.size).toBe(0);
    expect(dependencies.leaves).toHaveLength(1);
  });

  it("세션이 없으면 401 — 의존의 허브에도 구독하지 않는다", async () => {
    navigation.cookieValues.clear();
    const dependencies = recordingDependencyHub();
    const response = await trafficStreamResponse(streamRequest(), { hub: recordingMapHub().hub, dependencyHub: dependencies.hub });
    expect(response.status).toBe(401);
    expect(dependencies.hub.subscribe).not.toHaveBeenCalled();
  });
});

describe("5 화면의 첫 그림 · 멈춤", () => {
  it("loadTrafficMapScreen — initialDependencies = 의존 허브의 마지막 확인(부르지 않는다) · 없으면 null", async () => {
    const withLast = recordingDependencyHub(dependencyEvent(4));
    expect((await loadTrafficMapScreen({}, recordingMapHub().hub, withLast.hub)).initialDependencies).toEqual(dependencyEvent(4));
    expect((await loadTrafficMapScreen({}, recordingMapHub().hub, recordingDependencyHub().hub)).initialDependencies).toBeNull();
  });

  it("shutdownTrafficMap — 의존의 허브도 멈춘다", () => {
    const map = recordingMapHub();
    const dependencies = recordingDependencyHub();
    shutdownTrafficMap(map.hub, createTrafficStreamRegistry(), dependencies.hub);
    expect(map.hub.stop).toHaveBeenCalledTimes(1);
    expect(dependencies.hub.stop).toHaveBeenCalledTimes(1);
  });
});

describe("2 · 6 조회 한 번(loadTrafficDependencies) — 설정 · 로그", () => {
  it("세 설정이 있으면 세 경로를 부르고 선 일곱 · 비밀값 머리글 없음", async () => {
    const services = createFakeDependencyServices();
    vi.stubGlobal("fetch", services.fetch);
    const lines = await loadTrafficDependencies();
    expect(lines).toHaveLength(7);
    expect(services.requests.map((request) => request.service).sort()).toEqual(["backend", "llm", "observe"]);
    for (const request of services.requests) expect(new Headers(request.init.headers ?? {}).get("x-observe-secret")).toBeNull();
  });

  it("LLM_URL 이 비면 llm 을 부르지 않고 not_configured · 로그 1줄 `screen:traffic cell=dependencies:llm-wrapper upstream=not_configured`", async () => {
    vi.stubEnv("LLM_URL", "");
    const services = createFakeDependencyServices();
    vi.stubGlobal("fetch", services.fetch);
    const lines = await loadTrafficDependencies();
    expect(lines.find((line) => line.service === "llm-wrapper")).toEqual({ service: "llm-wrapper", dependency: "ollama", state: "unknown", tookMs: null, reason: "not_configured" });
    expect(services.requests.map((request) => request.service)).not.toContain("llm");
    expect(consoleLines.filter((line) => line.includes("cell=dependencies:"))).toEqual([expect.stringContaining("screen:traffic cell=dependencies:llm-wrapper upstream=not_configured")]);
  });

  it("닿지 못한 서비스 · 끊긴 의존 — 로그는 모름인 서비스마다 한 줄(끊김은 로그가 아니다) · 주소 · 비밀값 · detail 없음", async () => {
    const services = createFakeDependencyServices();
    services.responders.observe = () => Promise.reject(new TypeError(`fetch failed ${DEPENDENCY_LEAKED_ADDRESS}`));
    vi.stubGlobal("fetch", services.fetch);
    await loadTrafficDependencies();
    const dependencyLines = consoleLines.filter((line) => line.includes("cell=dependencies:"));
    expect(dependencyLines).toHaveLength(1);
    expect(dependencyLines[0]).toContain("cell=dependencies:observe upstream=unreachable");
    const everything = consoleLines.join("\n");
    for (const word of [DEPENDENCY_DETAIL_MARKER, DEPENDENCY_LEAKED_ADDRESS, FAKE_OBSERVE_SECRET, "backend.example.test", "llm.example.test", "observe.example.test", "Connection refused"]) {
      expect(everything, word).not.toContain(word);
    }
  });
});
