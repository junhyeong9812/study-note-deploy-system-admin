/** 의존의 선의 허브(명세 T9d "부르는 곳") — 구독자가 있을 때만 · 주기당 한 번(조회가 끝난 뒤 30초) · 통신 지도의 허브와 따로 돈다
 * (의존 조회가 붙잡혀도 통신 갱신이 제때 · 그 반대도) · load 의 예외는 흐름을 끊지 않는다(모름 · unreachable) · 구독자가 떠나면 · stop 이면 멈춘다. */
import { describe, expect, it, vi } from "vitest";
import { createFakeScheduler } from "@/features/auth/lib/test-fakes";
import { DEPENDENCY_SOURCES, unknownDependencyLines, type DependencyLine } from "@/features/traffic-map/lib/dependency-lines";
import { createTrafficDependencyHub, type TrafficDependencyEvent } from "@/features/traffic-map/lib/traffic-dependency-hub";
import { TRAFFIC_MAP_POLL_MILLISECONDS, createTrafficMapHub, type TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";
import { buildTrafficMapView, type TrafficMapView } from "@/features/traffic-map/lib/traffic-map-view";
import { fakeEdge, trafficMapSnapshotOf } from "@/features/traffic-map/lib/traffic-map-test-fakes";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

const T = Date.UTC(2026, 10, 30, 4, 10, 0, 0);

const ALL_UP: DependencyLine[] = DEPENDENCY_SOURCES.flatMap((source) => source.dependencies.map((dependency) => (
  { service: source.service, dependency, state: "up", tookMs: 3, reason: null } as DependencyLine)));

async function flush() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function setUp() {
  const clock = { now: T };
  const scheduler = createFakeScheduler();
  const pending: { resolve: (lines: DependencyLine[]) => void; reject: (error: unknown) => void }[] = [];
  const load = vi.fn(() => new Promise<DependencyLine[]>((resolve, reject) => { pending.push({ resolve, reject }); }));
  const hub = createTrafficDependencyHub({ load, scheduler: scheduler.scheduler, now: () => clock.now });
  async function answer(lines: DependencyLine[] = ALL_UP) {
    const next = pending.shift();
    expect(next, "기다리는 의존 조회가 없다").toBeDefined();
    next!.resolve(lines);
    await flush();
  }
  return { clock, scheduler, pending, load, hub, answer };
}

function recorder() {
  const events: TrafficDependencyEvent[] = [];
  return { events, listener: (event: TrafficDependencyEvent) => { events.push(event); } };
}

describe("3 구독자가 있을 때만 · 주기당 한 번", () => {
  it("구독이 없으면 부르지 않는다 · snapshot 은 부르지 않고 null", () => {
    const { hub, load } = setUp();
    expect(hub.snapshot()).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("구독 셋 → 조회 한 번 · 셋 모두 같은 사건(sequence 1 · checkedAt = 끝난 시각) · 다음은 끝난 뒤 30초에 하나", async () => {
    const { hub, load, answer, scheduler, clock } = setUp();
    const recorders = [recorder(), recorder(), recorder()];
    for (const { listener } of recorders) hub.subscribe(listener);
    expect(load).toHaveBeenCalledTimes(1);
    clock.now = T + 1_500;
    await answer();
    for (const { events } of recorders) expect(events.map((event) => [event.sequence, event.checkedAt, event.lines.length])).toEqual([[1, new Date(T + 1_500).toISOString(), 7]]);
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.scheduledDelays).toEqual([TRAFFIC_MAP_POLL_MILLISECONDS]);
    scheduler.runPending();
    expect(load).toHaveBeenCalledTimes(2);
    await answer();
    expect(recorders[0].events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("느린 조회에 겹치지 않는다 — 조회가 도는 동안 새 구독이 와도 다시 부르지 않는다", async () => {
    const { hub, load, answer } = setUp();
    hub.subscribe(recorder().listener);
    hub.subscribe(recorder().listener);
    expect(load).toHaveBeenCalledTimes(1);
    await answer();
  });

  it("새 구독은 30초 안의 마지막 사건을 곧바로 받고, 새로 부르지 않는다 · snapshot 은 그 사건", async () => {
    const { hub, load, answer, clock } = setUp();
    hub.subscribe(recorder().listener);
    await answer();
    clock.now = T + 10_000;
    const late = recorder();
    hub.subscribe(late.listener);
    expect(late.events.map((event) => event.sequence)).toEqual([1]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hub.snapshot()?.sequence).toBe(1);
  });

  it("마지막 구독이 떠나면 타이머를 거둔다 — 그 뒤로 부르지 않는다", async () => {
    const { hub, load, answer, scheduler } = setUp();
    const leave = hub.subscribe(recorder().listener);
    await answer();
    expect(scheduler.pendingCount()).toBe(1);
    leave();
    leave();
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.runPending();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("3 예외 · 멈춤", () => {
  it("load 가 던지면 그 주기의 선은 모두 모름(unreachable) — 흐름은 이어지고 30초 뒤 다시", async () => {
    const { hub, pending, load, scheduler } = setUp();
    const { events, listener } = recorder();
    hub.subscribe(listener);
    pending.shift()!.reject(new Error("boom"));
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0].lines).toEqual(DEPENDENCY_SOURCES.flatMap((source) => unknownDependencyLines(source.service, "unreachable")));
    scheduler.runPending();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("stop — 타이머를 거두고, 도는 조회가 끝나도 보내지 · 걸지 않는다 · 새 구독도 부르지 않는다", async () => {
    const { hub, load, answer, scheduler } = setUp();
    const { events, listener } = recorder();
    hub.subscribe(listener);
    hub.stop();
    await answer();
    expect(events).toHaveLength(0);
    expect(scheduler.pendingCount()).toBe(0);
    hub.subscribe(recorder().listener);
    hub.stop();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("3 통신 지도의 허브와 따로 — 한쪽이 붙잡혀도 다른 쪽은 제때", () => {
  function both() {
    const scheduler = createFakeScheduler();
    const clock = { now: T };
    const mapPending: ((result: UpstreamResult<TrafficMapView>) => void)[] = [];
    const dependencyPending: ((lines: DependencyLine[]) => void)[] = [];
    const mapLoad = vi.fn(() => new Promise<UpstreamResult<TrafficMapView>>((resolve) => { mapPending.push(resolve); }));
    const dependencyLoad = vi.fn(() => new Promise<DependencyLine[]>((resolve) => { dependencyPending.push(resolve); }));
    const mapHub = createTrafficMapHub({ load: mapLoad, scheduler: scheduler.scheduler, now: () => clock.now });
    const dependencyHub = createTrafficDependencyHub({ load: dependencyLoad, scheduler: scheduler.scheduler, now: () => clock.now });
    const mapEvents: TrafficMapEvent[] = [];
    const dependencyEvents: TrafficDependencyEvent[] = [];
    mapHub.subscribe("5m", (event) => mapEvents.push(event));
    dependencyHub.subscribe((event) => dependencyEvents.push(event));
    const map = { ok: true as const, value: buildTrafficMapView(trafficMapSnapshotOf([fakeEdge()])) };
    return { scheduler, mapPending, dependencyPending, mapLoad, dependencyLoad, mapEvents, dependencyEvents, map };
  }

  it("의존 조회가 붙잡혀도 통신 지도는 두 주기 모두 제때 나간다", async () => {
    const { scheduler, mapPending, mapLoad, dependencyLoad, mapEvents, dependencyEvents, map } = both();
    mapPending.shift()!(map);
    await flush();
    expect(mapEvents).toHaveLength(1);
    scheduler.runPending();
    expect(mapLoad).toHaveBeenCalledTimes(2);
    mapPending.shift()!(map);
    await flush();
    expect(mapEvents).toHaveLength(2);
    expect(dependencyEvents).toHaveLength(0);
    expect(dependencyLoad).toHaveBeenCalledTimes(1);   // 붙잡힌 의존 조회에 겹쳐 부르지 않는다
  });

  it("통신 조회가 붙잡혀도 의존의 선은 나간다", async () => {
    const { scheduler, dependencyPending, dependencyLoad, mapEvents, dependencyEvents } = both();
    dependencyPending.shift()!(ALL_UP);
    await flush();
    expect(dependencyEvents).toHaveLength(1);
    scheduler.runPending();
    expect(dependencyLoad).toHaveBeenCalledTimes(2);
    dependencyPending.shift()!(ALL_UP);
    await flush();
    expect(dependencyEvents).toHaveLength(2);
    expect(mapEvents).toHaveLength(0);
  });
});
