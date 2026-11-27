/** ⑬ T2g 빈 곳 — 통신 지도의 허브 · 의존 허브는 **누가 어떤 범위 안에서 깨워도** 그 범위의 추적 ID 를 물려받지 않는다(통신 규약 §1.2 "들어온 요청 없이 시작되는 호출은
 * 호출마다 새 16진수 소문자 32자"). 진입(쪽 /traffic · SSE)이 범위를 열지 않아도, 범위를 연 요청(`runWithRequestId("outer-request-1", …)`)이 허브를 깨우는 꼴을 직접 만든다.
 * 고정하는 계약(가짜 fetch 가 받은 `X-Request-Id` · 콘솔의 로그 줄로):
 * - 범위 안에서 허브를 깨운다(구독 · snapshot) → 지도 조회 · 의존 조회의 호출에 바깥 범위의 값이 한 번도 실리지 않는다 · 모두 새 32자.
 * - 그 범위 안에서 걸린 타이머로 도는 다음 바퀴도 물려받지 않는다 · 바퀴마다 다른 값.
 *   (Node 의 setTimeout 은 건 때의 AsyncLocalStorage 를 콜백에 잇는다 — 가짜 setTimeout 도 AsyncResource.bind 로 같은 일을 하고, 30초를 기다리지 않고 손으로 터뜨린다.)
 * - 지도 조회 한 바퀴의 실패 로그 줄의 ID = 그 바퀴 호출의 ID(요청 추적 화면에서 찾을 수 있게). 의존 조회는 세 호출이 서로 다른 값 · 로그 줄은 바깥의 값이 아니다(호출과 잇지 않는다). */
import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { FAKE_LLM_URL } from "@/features/traffic-map/lib/dependency-test-fakes";
import { TRAFFIC_MAP_POLL_MILLISECONDS } from "@/features/traffic-map/lib/traffic-map-hub";
import { defaultTrafficDependencyHub, defaultTrafficMapHub } from "@/features/traffic-map/server/traffic-map";
import { runWithRequestId } from "@/shared/lib/request-scope";
import { FAKE_BACKEND_URL, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, jsonBody } from "@/shared/lib/upstream-test-fakes";

const OUTER_ID = "outer-request-1";
const NEW_ID = /^[0-9a-f]{32}$/;
const HUB_KEYS = ["__studyNoteTrafficMapHub", "__studyNoteTrafficDependencyHub"] as const;

interface RecordedCall { url: URL; requestId: string | null }
interface PendingTimer { callback: () => void; milliseconds: number; cancelled: boolean }

const calls: RecordedCall[] = [];
const consoleLines: string[] = [];
const timers: PendingTimer[] = [];

function lineId(line: string): string {
  return line.slice(0, line.indexOf(":"));
}

/** 마이크로태스크 · 응답 읽기가 끝나기까지 몇 바퀴 돌린다(setImmediate 는 가짜로 바꾸지 않았다). */
async function settle() {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 허브가 건 주기 타이머(30초)를 하나씩 터뜨린다 — 건 때의 범위 안에서(AsyncResource.bind). */
async function firePollTimers() {
  const due = timers.filter((timer) => !timer.cancelled && timer.milliseconds >= TRAFFIC_MAP_POLL_MILLISECONDS - 1_000);
  expect(due.length, "다음 바퀴의 타이머가 걸리지 않았다(빈 검사)").toBeGreaterThan(0);
  for (const timer of due) {
    timer.cancelled = true;
    timer.callback();
  }
  await settle();
}

function freshHubs() {
  const holder = globalThis as unknown as Record<string, { stop(): void } | undefined>;
  for (const key of HUB_KEYS) {
    holder[key]?.stop();
    delete holder[key];
  }
}

beforeEach(() => {
  freshHubs();
  calls.length = 0;
  consoleLines.length = 0;
  timers.length = 0;
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("BACKEND_URL", FAKE_BACKEND_URL);
  vi.stubEnv("LLM_URL", FAKE_LLM_URL);
  vi.stubEnv("LOG_REDIS_URL", "");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), requestId: new Headers(init.headers ?? {}).get("x-request-id") });
    return jsonBody({ success: false, error: { code: "unavailable" } }, 503);
  }));
  vi.stubGlobal("setTimeout", ((callback: () => void, milliseconds = 0) => {
    const timer: PendingTimer = { callback: AsyncResource.bind(callback), milliseconds, cancelled: false };
    timers.push(timer);
    return timer;
  }) as unknown as typeof setTimeout);
  vi.stubGlobal("clearTimeout", ((timer: PendingTimer | undefined) => { if (timer !== undefined && typeof timer === "object") timer.cancelled = true; }) as unknown as typeof clearTimeout);
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  freshHubs();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function mapCalls() {
  return calls.filter((call) => call.url.pathname === "/traffic/map");
}

function dependencyCalls() {
  return calls.filter((call) => call.url.pathname !== "/traffic/map");
}

function expectNewAndNotOuter(ids: (string | null)[], label: string) {
  for (const id of ids) {
    expect(id, `${label} — 새 16진 32자`).toMatch(NEW_ID);
    expect(id, `${label} — 바깥 범위의 값을 물려받지 않는다`).not.toBe(OUTER_ID);
  }
  expect(new Set(ids).size, `${label} — 호출마다 다른 값`).toBe(ids.length);
}

describe("통신 지도의 허브 — 범위를 연 요청 안에서 깨워도 그 값을 물려받지 않는다", () => {
  it("구독으로 깨운 첫 바퀴와 타이머로 도는 다음 두 바퀴 — 바퀴마다 새 값 · 실패 로그 줄의 ID = 그 바퀴 호출의 ID", async () => {
    const unsubscribe = runWithRequestId(OUTER_ID, () => defaultTrafficMapHub().subscribe("5m", () => undefined));
    await settle();
    await firePollTimers();
    await firePollTimers();
    unsubscribe();
    const rounds = mapCalls();
    expect(rounds).toHaveLength(3);
    expectNewAndNotOuter(rounds.map((call) => call.requestId), "지도 조회");
    const mapLines = consoleLines.filter((line) => line.includes("cell=map"));
    expect(mapLines).toHaveLength(3);
    expect(mapLines.map(lineId)).toEqual(rounds.map((call) => call.requestId));
    for (const line of consoleLines) expect(lineId(line), line).not.toBe(OUTER_ID);
  });

  it("snapshot 으로 깨워도 — 호출 · 로그 줄 모두 새 값(같은 값)", async () => {
    await runWithRequestId(OUTER_ID, () => defaultTrafficMapHub().snapshot("5m"));
    await settle();
    const rounds = mapCalls();
    expect(rounds).toHaveLength(1);
    expectNewAndNotOuter(rounds.map((call) => call.requestId), "지도 조회(snapshot)");
    expect(consoleLines.filter((line) => line.includes("cell=map")).map(lineId)).toEqual([rounds[0].requestId]);
  });
});

describe("의존 허브 — 범위를 연 요청 안에서 깨워도 그 값을 물려받지 않는다", () => {
  it("구독으로 깨운 첫 바퀴와 타이머로 도는 다음 바퀴 — 여섯 호출이 모두 다른 새 값 · 로그 줄도 바깥의 값이 아니다", async () => {
    const unsubscribe = runWithRequestId(OUTER_ID, () => defaultTrafficDependencyHub().subscribe(() => undefined));
    await settle();
    await firePollTimers();
    unsubscribe();
    const dependencies = dependencyCalls();
    expect(dependencies).toHaveLength(6);
    expectNewAndNotOuter(dependencies.map((call) => call.requestId), "의존 조회");
    const dependencyLines = consoleLines.filter((line) => line.includes("cell=dependencies:"));
    expect(dependencyLines.length, "의존 실패 로그 줄(빈 검사)").toBeGreaterThan(0);
    for (const line of dependencyLines) {
      expect(lineId(line), line).toMatch(NEW_ID);
      expect(lineId(line), line).not.toBe(OUTER_ID);
    }
  });
});
