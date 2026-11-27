/** 통신 지도 — 프로세스가 멈출 때(T8 리뷰 1). SIGTERM · SIGINT 를 받으면 허브를 멈추고(타이머 · 조회) 열린 흐름을 모두 닫는다 —
 * 닫기 전에 사건을 보내지 않는다(브라우저는 끊김을 보고 5초 뒤 새 자리에 다시 붙는다) · 주석 줄 · 세션 타이머가 남지 않는다 · 구독을 거둔다 ·
 * 멈춘 뒤에 온 새 연결은 503 `shutting_down`(Retry-After 5 — 받지 않는다) · 흐름을 100번 열어도 프로세스의 신호 리스너는 늘지 않는다 ·
 * 등록은 프로세스에 한 번(instrumentation 의 register() — 기존 멈춤 처리(로그인 대기열의 줄)는 그대로 돈다).
 * 이음매: registerTrafficMapShutdown(registrar = process.once) · shutdownTrafficMap(hub, streams) · trafficStreamResponse 의 streams. */
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
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD_HASH, FAKE_SIGNING_KEY, createFakeScheduler } from "@/features/auth/lib/test-fakes";
import type { TrafficDependencyHub } from "@/features/traffic-map/lib/traffic-dependency-hub";
import type { TrafficMapHub, TrafficMapListener } from "@/features/traffic-map/lib/traffic-map-hub";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import { chatMapEdges, trafficMapEventOf } from "@/features/traffic-map/lib/traffic-map-test-fakes";
import { createTrafficStreamRegistry } from "@/features/traffic-map/lib/traffic-stream-registry";
import {
  defaultTrafficStreamRegistry, registerTrafficMapShutdown, shutdownTrafficMap, trafficStreamResponse, type ShutdownSignal,
} from "@/features/traffic-map/server/traffic-map";
import { register } from "@/instrumentation";
import { FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL } from "@/shared/lib/upstream-test-fakes";


/** 의존의 선(⑬ T9d)의 조용한 허브 — 이 파일은 통신 지도의 흐름만 본다(의존의 사건은 traffic-map-dependencies.test 가 본다). */
function quietDependencyHub(): TrafficDependencyHub {
  return { subscribe: () => () => {}, snapshot: () => null, stop: () => {} };
}
const consoleLines: string[] = [];

function recordingHub() {
  const listeners = new Map<TrafficMapListener, TrafficMapRange>();
  const unsubscribeCalls: TrafficMapRange[] = [];
  const hub: TrafficMapHub = {
    subscribe: vi.fn((range: TrafficMapRange, listener: TrafficMapListener) => {
      listeners.set(listener, range);
      listener(trafficMapEventOf(1, chatMapEdges(), { range }));
      let left = false;
      return () => { if (!left) { left = true; listeners.delete(listener); unsubscribeCalls.push(range); } };
    }),
    snapshot: vi.fn(async (range: TrafficMapRange) => trafficMapEventOf(1, chatMapEdges(), { range })),
    clear: vi.fn(),
    stop: vi.fn(),
  };
  return { hub, listeners, unsubscribeCalls };
}

const controllers: AbortController[] = [];
function streamRequest(search = ""): Request {
  const controller = new AbortController();
  controllers.push(controller);
  return new Request(new URL(`/api/traffic/stream${search}`, FAKE_ORIGIN), { method: "GET", headers: { origin: FAKE_ORIGIN }, signal: controller.signal });
}

/** 첫 덩어리 둘(retry · map)을 읽고 흐름을 열어 둔 채로 돌려준다. */
async function openStream(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n\n").filter(Boolean).length < 2) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return {
    async rest() {
      let rest = "";
      const deadline = Date.now() + 1000;
      for (;;) {
        const chunk = await Promise.race([reader.read(), new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now())))]);
        if (chunk === "timeout") return { text: rest, done: false };
        if (chunk.done) return { text: rest, done: true };
        rest += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_USER", FAKE_ADMIN_ID);
  vi.stubEnv("ADMIN_PASSWORD_HASH", FAKE_PASSWORD_HASH);
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  navigation.cookieValues.clear();
  navigation.cookieValues.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
  consoleLines.length = 0;
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("멈추면 — shutdownTrafficMap(hub, streams)", () => {
  it("허브를 멈추고 열린 흐름을 모두 닫는다 — 닫기 전에 사건을 보내지 않는다 · 구독 · 주석 줄 · 세션 타이머가 남지 않는다", async () => {
    const { hub, unsubscribeCalls } = recordingHub();
    const streams = createTrafficStreamRegistry();
    const scheduler = createFakeScheduler();
    const first = await openStream(await trafficStreamResponse(streamRequest(), { dependencyHub: quietDependencyHub(), hub, streams, scheduler: scheduler.scheduler }));
    const second = await openStream(await trafficStreamResponse(streamRequest("?range=24h"), { dependencyHub: quietDependencyHub(), hub, streams, scheduler: scheduler.scheduler }));
    expect(streams.size()).toBe(2);
    expect(scheduler.pendingCount()).toBe(4);                 // 흐름마다 주석 줄 · 세션 끝
    shutdownTrafficMap(hub, streams);
    expect(hub.stop).toHaveBeenCalledTimes(1);
    for (const stream of [first, second]) {
      const rest = await stream.rest();
      expect(rest.done, "흐름이 닫히지 않았다").toBe(true);
      expect(rest.text).toBe("");                             // 마지막 사건 · 주석 줄 없이 닫는다
    }
    expect(unsubscribeCalls.sort()).toEqual(["24h", "5m"]);
    expect(scheduler.pendingCount()).toBe(0);
    expect(streams.size()).toBe(0);
    expect(streams.closed).toBe(true);
  });

  it("멈춘 뒤에 온 새 연결은 503 shutting_down · Retry-After 5 · 구독하지 않는다", async () => {
    const { hub } = recordingHub();
    const streams = createTrafficStreamRegistry();
    shutdownTrafficMap(hub, streams);
    const response = await trafficStreamResponse(streamRequest(), { dependencyHub: quietDependencyHub(), hub, streams, scheduler: createFakeScheduler().scheduler });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    expect(await response.json()).toEqual({ success: false, error: { code: "shutting_down" } });
    expect(hub.subscribe).not.toHaveBeenCalled();
  });

  it("두 번 멈춰도 같다(예외 없음)", () => {
    const { hub } = recordingHub();
    const streams = createTrafficStreamRegistry();
    shutdownTrafficMap(hub, streams);
    expect(() => shutdownTrafficMap(hub, streams)).not.toThrow();
  });

  it("평소에 끊긴 흐름은 목록에서 빠진다(쌓이지 않는다)", async () => {
    const { hub } = recordingHub();
    const streams = createTrafficStreamRegistry();
    const request = streamRequest();
    await openStream(await trafficStreamResponse(request, { dependencyHub: quietDependencyHub(), hub, streams, scheduler: createFakeScheduler().scheduler }));
    expect(streams.size()).toBe(1);
    controllers.at(-1)!.abort();
    await vi.waitFor(() => expect(streams.size()).toBe(0));
  });

  it("흐름을 100번 열어도 프로세스의 신호 리스너를 더하지 않는다(MaxListenersExceededWarning 없음)", async () => {
    const { hub } = recordingHub();
    const streams = createTrafficStreamRegistry();
    const before = ["SIGTERM", "SIGINT"].map((signal) => process.listenerCount(signal));
    const added = [vi.spyOn(process, "on"), vi.spyOn(process, "once"), vi.spyOn(process, "addListener"), vi.spyOn(process, "prependListener")];
    const warnings: string[] = [];
    const onWarning = (warning: Error) => { warnings.push(warning.name); };
    process.prependListener("warning", onWarning);
    try {
      for (let index = 0; index < 100; index += 1) await trafficStreamResponse(streamRequest(), { dependencyHub: quietDependencyHub(), hub, streams, scheduler: createFakeScheduler().scheduler });
      for (const spy of added) expect(spy.mock.calls.filter(([event]) => event === "SIGTERM" || event === "SIGINT")).toEqual([]);
      expect(["SIGTERM", "SIGINT"].map((signal) => process.listenerCount(signal))).toEqual(before);
      expect(warnings).not.toContain("MaxListenersExceededWarning");
    } finally {
      process.removeListener("warning", onWarning);
    }
  });
});

describe("등록 — 프로세스에 한 번(instrumentation 의 register())", () => {
  it("register() 가 SIGTERM · SIGINT 에 멈춤을 물린다 — SIGTERM 을 받으면 기본 흐름 목록이 닫히고, 기존의 로그인 대기열 줄도 그대로 남는다", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    const capture = (event: string | symbol, handler: (...args: unknown[]) => void) => {
      handlers.set(String(event), [...(handlers.get(String(event)) ?? []), handler]);
      return process;
    };
    vi.spyOn(process, "on").mockImplementation(capture as typeof process.on);
    vi.spyOn(process, "once").mockImplementation(capture as typeof process.once);
    vi.spyOn(process, "addListener").mockImplementation(capture as typeof process.addListener);
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    await register();
    expect((handlers.get("SIGINT") ?? []).length).toBeGreaterThanOrEqual(1);
    const sigterm = handlers.get("SIGTERM") ?? [];
    expect(sigterm.length).toBeGreaterThanOrEqual(2);         // 로그인 대기열의 줄 + 지도의 멈춤
    expect(defaultTrafficStreamRegistry().closed).toBe(false);
    consoleLines.length = 0;
    for (const handler of sigterm) handler("SIGTERM");
    expect(defaultTrafficStreamRegistry().closed).toBe(true);
    expect(consoleLines.filter((line) => /\bqueued=\d+/.test(line) && /\bdropped=\d+/.test(line))).toHaveLength(1);
  });

  it("두 번째 등록은 아무것도 하지 않는다 — 신호마다 처리기 하나(register() 가 이미 등록했다)", () => {
    const registrar = vi.fn((_signal: ShutdownSignal, _handler: () => void) => undefined);
    registerTrafficMapShutdown(registrar);
    registerTrafficMapShutdown(registrar);
    expect(registrar).not.toHaveBeenCalled();
  });
});
