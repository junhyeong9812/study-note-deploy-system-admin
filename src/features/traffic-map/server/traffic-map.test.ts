/** 통신 지도의 서버 쪽 진입(T8) — 중계(SSE) `GET /api/traffic/stream`: 세션이 먼저(없으면 401 · 관측 서버를 부르지 않는다) · 머리(text/event-stream ·
 * 캐시 금지 · 버퍼링 끔) · 사건의 꼴(`retry` → `event: map` · `id` · `data`) · 여러 연결이 열려도 관측 서버의 조회는 주기당 한 번(화면의 첫 그림도 나눠 쓴다) ·
 * 기간(range) · 연결마다의 주석 줄(15초) · 세션이 끝나면 `event: session` 을 보내고 닫는다 · 클라이언트가 끊으면 구독과 타이머를 거둔다 ·
 * 사건 · 로그에 주소 · 비밀값 · 관측 서버의 오류 글이 없다 · 실패는 조회마다 앱 로그 1줄 · 어드민 nginx 의 이 경로는 버퍼링을 끈다.
 * 전역 fetch 를 가짜 관측 서버(실제 규칙 흉내)로 바꾼다. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public location: string) { super(`redirect:${location}`); }
  }
  return { RedirectSignal, cookieValues: new Map<string, string>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (navigation.cookieValues.has(name) ? { name, value: navigation.cookieValues.get(name)! } : undefined),
    has: (name: string) => navigation.cookieValues.has(name),
    getAll: () => [...navigation.cookieValues].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers({ host: "evil.example.test" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (location: string) => { throw new navigation.RedirectSignal(location); },
  permanentRedirect: (location: string) => { throw new navigation.RedirectSignal(location); },
  notFound: () => { throw new Error("notFound"); },
}));

import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY, createFakeScheduler } from "@/features/auth/lib/test-fakes";
import type { TrafficMapEvent, TrafficMapHub, TrafficMapListener } from "@/features/traffic-map/lib/traffic-map-hub";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import { LEAKED_ADDRESS, chatMapEdges, createFakeObserveMap, fakeMapServer, trafficMapEventOf } from "@/features/traffic-map/lib/traffic-map-test-fakes";
import {
  TRAFFIC_STREAM_HEARTBEAT_MILLISECONDS, defaultTrafficMapHub, loadTrafficMapScreen, trafficStreamResponse,
} from "@/features/traffic-map/server/traffic-map";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  SECRET_HEADER_NAMES, createRoutedFetch, expectNoForbiddenText, expectReadOnlyRequest, headersOf, leakyErrorBody, okValue, textResponse,
  type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";
import { UPSTREAM_FAILURE_MESSAGES } from "@/shared/lib/upstream-result";

const MINUTE = 60_000;
const ADMIN_DIRECTORY = fileURLToPath(new URL("../../../..", import.meta.url));

let observe: ReturnType<typeof createFakeObserveMap>;
let observeHandler: RoutedFetchHandler;
const upstreamFetch = createRoutedFetch((url, init) => {
  if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected upstream ${url.hostname}`);
  return observeHandler(url, init);
});

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
function everythingLogged(): string {
  const consoleText = consoleSpies.flatMap((spy) => spy.mock.calls.flat()).map((part) => String(part));
  const streamText = [process.stdout.write, process.stderr.write].flatMap((write) =>
    (vi.isMockFunction(write) ? write.mock.calls.map((call) => String(call[0])) : []));
  return [...consoleText, ...streamText].join("\n");
}

function setSession(issuedAt: number | null) {
  navigation.cookieValues.clear();
  if (issuedAt !== null) navigation.cookieValues.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, issuedAt));
}

const openStreams: AbortController[] = [];
function streamRequest(search = "", controller = new AbortController()): Request {
  openStreams.push(controller);
  return new Request(new URL(`/api/traffic/stream${search}`, FAKE_ORIGIN), { method: "GET", headers: { origin: FAKE_ORIGIN, accept: "text/event-stream" }, signal: controller.signal });
}

/** 흐름을 읽어 덩어리(빈 줄로 끝나는 SSE 묶음)를 모은다. */
function reader(response: Response) {
  const stream = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const blocks: string[] = [];
  async function pump() {
    const chunk = await stream.read();
    if (chunk.done) { done = true; return; }
    buffer += decoder.decode(chunk.value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      blocks.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
    }
  }
  return {
    blocks,
    isDone: () => done,
    /** 덩어리가 count 개가 될 때까지(또는 흐름이 끝날 때까지) 읽는다 — 1초를 넘으면 사례 실패 */
    async until(count: number) {
      const deadline = Date.now() + 1000;
      while (blocks.length < count && !done) {
        const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now())));
        if ((await Promise.race([pump().then(() => "read" as const), timeout])) === "timeout") throw new Error(`덩어리 ${count}개를 1초 안에 받지 못했다(받은 것 ${blocks.length})`);
      }
      return blocks;
    },
    cancel: () => stream.cancel().catch(() => undefined),
  };
}

function mapEventsOf(blocks: string[]): { id: string | null; event: TrafficMapEvent }[] {
  return blocks.filter((block) => /^event: map$/m.test(block)).map((block) => ({
    id: /^id: (.*)$/m.exec(block)?.[1] ?? null,
    event: JSON.parse(/^data: (.*)$/m.exec(block)![1]) as TrafficMapEvent,
  }));
}

/** 구독을 기록하는 가짜 허브 — 사건을 직접 보낼 수 있다. */
function recordingHub() {
  const listeners = new Map<TrafficMapListener, TrafficMapRange>();
  const unsubscribeCalls: TrafficMapRange[] = [];
  const hub: TrafficMapHub = {
    subscribe: vi.fn((range: TrafficMapRange, listener: TrafficMapListener) => {
      listeners.set(listener, range);
      let left = false;
      return () => { if (!left) { left = true; listeners.delete(listener); unsubscribeCalls.push(range); } };
    }),
    snapshot: vi.fn(async (range: TrafficMapRange) => trafficMapEventOf(1, chatMapEdges(), { range })),
    clear: vi.fn(),
  };
  return { hub, listeners, unsubscribeCalls, send: (event: TrafficMapEvent) => { for (const listener of [...listeners.keys()]) listener(event); } };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("ALERT_URL", FAKE_ALERT_URL);
  vi.stubEnv("ALERT_SECRET", FAKE_ALERT_SECRET);
  vi.stubEnv("BACKEND_URL", FAKE_BACKEND_URL);
  vi.stubEnv("LOG_REDIS_URL", "");
  observe = createFakeObserveMap({ edges: chatMapEdges(), servers: [fakeMapServer()] });
  observeHandler = observe.handler;
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  setSession(Date.now() - MINUTE);
  defaultTrafficMapHub().clear();
  consoleSpies.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  for (const controller of openStreams.splice(0)) controller.abort();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("세션이 먼저", () => {
  it("세션이 없으면 401 JSON · 관측 서버를 부르지 않는다 · 구독하지 않는다", async () => {
    setSession(null);
    const { hub } = recordingHub();
    const response = await trafficStreamResponse(streamRequest(), { hub });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(await response.json()).toEqual({ success: false, error: { code: "unauthorized" } });
    expect(hub.subscribe).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("만료된 세션도 401", async () => {
    setSession(Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000);
    expect((await trafficStreamResponse(streamRequest())).status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("화면용 진입 — 세션이 없으면 /login · 관측 서버를 부르지 않는다", async () => {
    setSession(null);
    await expect(loadTrafficMapScreen({})).rejects.toBeInstanceOf(navigation.RedirectSignal);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("흐름의 머리와 사건", () => {
  it("200 · text/event-stream · 캐시 금지 · 버퍼링 끔(X-Accel-Buffering: no)", async () => {
    const response = await trafficStreamResponse(streamRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    expect(response.headers.get("cache-control") ?? "").toContain("no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("첫 덩어리는 retry: 5000 · 그다음 event: map(id = sequence · data = 사건 JSON 한 줄)", async () => {
    const stream = reader(await trafficStreamResponse(streamRequest()));
    const blocks = await stream.until(2);
    expect(blocks[0]).toBe("retry: 5000");
    const [{ id, event }] = mapEventsOf(blocks);
    expect(id).toBe(String(event.sequence));
    expect(event.range).toBe("5m");
    const map = okValue(event.map);
    expect(map.edges.map((edge) => [edge.caller, edge.service, edge.trafficClass, edge.completeness])).toContainEqual(["front", "backend", "request", "filling"]);
    expect(map.servers.map((server) => server.server)).toEqual(["ci-agent-158"]);
  });

  it("관측 서버를 부르는 법 — GET /traffic/map · 기간 5분(지금까지) · X-Observe-Secret 하나 · no-store", async () => {
    const before = Date.now();
    await reader(await trafficStreamResponse(streamRequest())).until(2);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [input, init] = upstreamFetch.mock.calls[0];
    const url = new URL(input);
    expect(url.pathname).toBe("/traffic/map");
    const from = Date.parse(url.searchParams.get("from")!);
    const to = Date.parse(url.searchParams.get("to")!);
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to - from).toBe(5 * MINUTE);
    expectReadOnlyRequest(init);
    expect(init?.cache).toBe("no-store");
    for (const name of SECRET_HEADER_NAMES) expect(headersOf(init).get(name)).toBe(name === "x-observe-secret" ? FAKE_OBSERVE_SECRET : null);
  });

  it.each([["?range=1h", "1h", 60 * MINUTE], ["?range=24h", "24h", 24 * 60 * MINUTE], ["?range=7d", "5m", 5 * MINUTE], ["?range=", "5m", 5 * MINUTE],
    ["?range=1h&range=24h", "5m", 5 * MINUTE]] as const)("기간 %s → %s(틀리면 기본값 — 거절하지 않는다)", async (search, range, width) => {
    const [{ event }] = mapEventsOf(await reader(await trafficStreamResponse(streamRequest(search))).until(2));
    expect(event.range).toBe(range);
    const url = new URL(upstreamFetch.mock.calls[0][0]);
    expect(Date.parse(url.searchParams.get("to")!) - Date.parse(url.searchParams.get("from")!)).toBe(width);
  });
});

describe("여러 연결 — 관측 서버의 조회는 주기당 한 번", () => {
  it("같은 기간의 흐름 셋 + 화면의 첫 그림 → 관측 서버 /traffic/map 한 번 · 모두 같은 사건", async () => {
    const screen = await loadTrafficMapScreen({});
    const streams = await Promise.all([0, 1, 2].map(async () => reader(await trafficStreamResponse(streamRequest()))));
    const events = await Promise.all(streams.map(async (stream) => mapEventsOf(await stream.until(2))[0].event));
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    for (const event of events) expect(event.sequence).toBe(screen.initial.sequence);
    expect(screen.range).toBe("5m");
  });

  it("기간이 다르면 기간마다 한 번", async () => {
    await reader(await trafficStreamResponse(streamRequest("?range=1h"))).until(2);
    await reader(await trafficStreamResponse(streamRequest("?range=1h"))).until(2);
    await reader(await trafficStreamResponse(streamRequest("?range=24h"))).until(2);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it("관측 서버가 실패하면 — 사건의 map 은 고정 글자의 실패(원문 · 주소 없음) · 앱 로그는 조회마다 1줄(연결 수만큼이 아니다)", async () => {
    observeHandler = () => textResponse(leakyErrorBody(), 503);
    const streams = await Promise.all([0, 1].map(async () => reader(await trafficStreamResponse(streamRequest()))));
    const events = await Promise.all(streams.map(async (stream) => mapEventsOf(await stream.until(2))[0].event));
    for (const event of events) expect(event.map).toEqual({ ok: false, reason: "unavailable", status: 503, message: UPSTREAM_FAILURE_MESSAGES.unavailable });
    await vi.waitFor(() => expect(everythingLogged()).toContain("screen:traffic cell=map upstream=unavailable status=503"));
    expect(everythingLogged().match(/screen:traffic cell=map/g)).toHaveLength(1);
    expectNoForbiddenText(everythingLogged());
    for (const stream of streams) expectNoForbiddenText(stream.blocks.join("\n"));
  });
});

describe("연결마다의 타이머 — 주석 줄 · 세션 끝 · 끊김", () => {
  it(`주석 줄(: keep-alive)을 ${TRAFFIC_STREAM_HEARTBEAT_MILLISECONDS / 1000}초마다(어드민 nginx 의 읽기 제한 30초보다 짧게)`, async () => {
    expect(TRAFFIC_STREAM_HEARTBEAT_MILLISECONDS).toBe(15_000);
    const scheduler = createFakeScheduler();
    const { hub } = recordingHub();
    const stream = reader(await trafficStreamResponse(streamRequest(), { hub, scheduler: scheduler.scheduler, now: () => Date.now() }));
    await stream.until(1);
    expect(scheduler.scheduledDelays).toContain(15_000);
    scheduler.runPending();
    const blocks = await stream.until(2);
    expect(blocks).toContain(": keep-alive");
    expect(scheduler.scheduledDelays.filter((delay) => delay === 15_000).length).toBeGreaterThanOrEqual(2);   // 다음 주석 줄
  });

  it("허브의 사건을 그대로 흘려보낸다 — 순서대로, 모르는 칸 없이", async () => {
    const { hub, send } = recordingHub();
    const stream = reader(await trafficStreamResponse(streamRequest("?range=1h"), { hub, scheduler: createFakeScheduler().scheduler }));
    await stream.until(1);
    expect(hub.subscribe).toHaveBeenCalledWith("1h", expect.any(Function));
    send(trafficMapEventOf(7, chatMapEdges(), { range: "1h" }));
    send(trafficMapEventOf(8, chatMapEdges(), { range: "1h" }));
    const events = mapEventsOf(await stream.until(3));
    expect(events.map(({ id, event }) => [id, event.sequence])).toEqual([["7", 7], ["8", 8]]);
  });

  it("세션이 끝나는 때 event: session 을 보내고 닫는다 · 구독을 거둔다", async () => {
    const now = Date.now();
    setSession(now - SESSION_LIFETIME_MILLISECONDS + 60_000);   // 1분 남음
    const scheduler = createFakeScheduler();
    const { hub, unsubscribeCalls } = recordingHub();
    const stream = reader(await trafficStreamResponse(streamRequest(), { hub, scheduler: scheduler.scheduler, now: () => now }));
    await stream.until(1);
    expect(scheduler.scheduledDelays).toContain(60_000);
    scheduler.runPending();
    const blocks = await stream.until(10);
    expect(blocks).toContain("event: session\ndata: {\"reason\":\"expired\"}");
    expect(stream.isDone()).toBe(true);
    expect(unsubscribeCalls).toEqual(["5m"]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("클라이언트가 끊으면 구독 · 주석 줄 · 세션 타이머를 모두 거둔다(새는 타이머 없음) · 그 뒤의 사건은 쓰지 않는다", async () => {
    const scheduler = createFakeScheduler();
    const { hub, unsubscribeCalls, send } = recordingHub();
    const controller = new AbortController();
    const stream = reader(await trafficStreamResponse(streamRequest("", controller), { hub, scheduler: scheduler.scheduler }));
    await stream.until(1);
    expect(scheduler.pendingCount()).toBeGreaterThan(0);
    controller.abort();
    await vi.waitFor(() => expect(unsubscribeCalls).toEqual(["5m"]));
    expect(scheduler.pendingCount()).toBe(0);
    expect(() => send(trafficMapEventOf(9, chatMapEdges()))).not.toThrow();
  });

  it("읽는 쪽이 흐름을 취소해도(cancel) 같이 거둔다", async () => {
    const scheduler = createFakeScheduler();
    const { hub, unsubscribeCalls } = recordingHub();
    const stream = reader(await trafficStreamResponse(streamRequest(), { hub, scheduler: scheduler.scheduler }));
    await stream.until(1);
    await stream.cancel();
    await vi.waitFor(() => expect(unsubscribeCalls).toEqual(["5m"]));
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("주소 · 비밀값이 새지 않는다", () => {
  it("관측 서버가 계약 밖 칸에 주소를 실어도 사건에 없다 · 비밀값 · 관측 서버 주소도 없다", async () => {
    const blocks = await reader(await trafficStreamResponse(streamRequest())).until(2);
    const text = blocks.join("\n");
    expect(text).not.toContain(LEAKED_ADDRESS);
    expectNoForbiddenText(text);
  });

  it("서버 이름 속의 주소 꼴은 가려 싣는다", async () => {
    observe.store.servers = [fakeMapServer({ server: "edge-203.0.113.9" })];
    const [{ event }] = mapEventsOf(await reader(await trafficStreamResponse(streamRequest())).until(2));
    expect(okValue(event.map).servers[0].server).toBe("edge-(주소)");
  });
});

describe("화면용 진입 — loadTrafficMapScreen", () => {
  it("기간과 첫 그림(허브의 snapshot) · 기간이 틀리면 기본값", async () => {
    const screen = await loadTrafficMapScreen({ range: "24h" });
    expect(screen.range).toBe("24h");
    expect(screen.initial.range).toBe("24h");
    expect(okValue(screen.initial.map).edges.length).toBeGreaterThan(0);
    expect((await loadTrafficMapScreen({ range: ["1h", "24h"] })).range).toBe("5m");
  });

  it("설정이 비면 첫 그림은 not_configured — 부르지 않는다", async () => {
    vi.stubEnv("OBSERVE_SECRET", "");
    defaultTrafficMapHub().clear();
    const screen = await loadTrafficMapScreen({});
    expect(screen.initial.map).toMatchObject({ ok: false, reason: "not_configured" });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

describe("어드민 nginx — 이 경로만 버퍼링을 끈다(규약 3.3)", () => {
  const config = readFileSync(join(ADMIN_DIRECTORY, "deploy", "nginx", "nginx.conf"), "utf8");
  it("location = /api/traffic/stream 에 proxy_buffering off · proxy_cache off · proxy_pass 같은 뒤쪽", () => {
    const block = /location = \/api\/traffic\/stream \{([^}]*)\}/.exec(config);
    expect(block, "SSE location 이 없다").not.toBeNull();
    expect(block![1]).toMatch(/proxy_buffering\s+off;/);
    expect(block![1]).toMatch(/proxy_cache\s+off;/);
    expect(block![1]).toMatch(/proxy_pass\s+http:\/\/\$deploy_upstream;/);
  });

  it("그 location 안에서 proxy_set_header · add_header 를 다시 쓰지 않는다(위 단계의 것을 물려받게)", () => {
    const block = /location = \/api\/traffic\/stream \{([^}]*)\}/.exec(config)?.[1] ?? "";
    expect(block).not.toMatch(/proxy_set_header|add_header/);
  });
});
