/** 통신 지도의 공유 조회(T8, 순수) — 여러 탭 · 여러 사람이 열어도 관측 서버의 조회는 기간마다 주기(30초)당 한 번 · 느린 조회에 겹쳐 부르지 않는다 ·
 * 마지막 연결이 떠나면 타이머를 거둔다(새는 타이머 없음) · 새로 붙은 연결은 마지막 지도를 곧바로 받는다 · 화면의 첫 그림(snapshot)도 같은 조회를 나눠 쓴다 ·
 * 실패 · 예외도 사건으로 · sequence 는 허브 전체에서 는다. 시계 · 타이머 · 조회는 가짜(실제 대기 없음). */
import { describe, expect, it, vi } from "vitest";
import { createFakeScheduler } from "@/features/auth/lib/test-fakes";
import { TRAFFIC_MAP_POLL_MILLISECONDS, createTrafficMapHub, type TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import { buildTrafficMapView, type TrafficMapView } from "@/features/traffic-map/lib/traffic-map-view";
import { fakeEdge, trafficMapSnapshotOf } from "@/features/traffic-map/lib/traffic-map-test-fakes";
import { expectFailure, okValue } from "@/shared/lib/upstream-test-fakes";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

const T = Date.UTC(2026, 10, 25, 4, 10, 0, 0);

function setUp() {
  const clock = { now: T };
  const scheduler = createFakeScheduler();
  const pending: { range: TrafficMapRange; resolve: (result: UpstreamResult<TrafficMapView>) => void; reject: (error: unknown) => void }[] = [];
  const load = vi.fn((range: TrafficMapRange) => new Promise<UpstreamResult<TrafficMapView>>((resolve, reject) => { pending.push({ range, resolve, reject }); }));
  const hub = createTrafficMapHub({ load, scheduler: scheduler.scheduler, now: () => clock.now });
  /** 가장 오래 기다린 조회에 답한다(그 기간의 지도 — count 로 어느 답인지 가른다). */
  async function answer(count = 1, result?: UpstreamResult<TrafficMapView>) {
    const next = pending.shift();
    expect(next, "기다리는 조회가 없다").toBeDefined();
    next!.resolve(result ?? { ok: true, value: buildTrafficMapView(trafficMapSnapshotOf([fakeEdge({ count })])) });
    await flush();
  }
  return { clock, scheduler, pending, load, hub, answer };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function recorder() {
  const events: TrafficMapEvent[] = [];
  return { events, listener: (event: TrafficMapEvent) => { events.push(event); } };
}

const countOf = (event: TrafficMapEvent) => okValue(event.map).edges[0].count;

describe("주기당 한 번 — 연결이 여럿이어도", () => {
  it("같은 기간의 연결 셋 → 관측 서버 조회 한 번 · 셋 모두 같은 사건 · 다음 조회는 30초 뒤 하나", async () => {
    const { hub, load, answer, scheduler } = setUp();
    const recorders = [recorder(), recorder(), recorder()];
    for (const { listener } of recorders) hub.subscribe("5m", listener);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("5m");
    await answer(7);
    for (const { events } of recorders) expect(events.map((event) => [event.sequence, event.range, countOf(event)])).toEqual([[1, "5m", 7]]);
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.scheduledDelays).toEqual([TRAFFIC_MAP_POLL_MILLISECONDS]);
    expect(TRAFFIC_MAP_POLL_MILLISECONDS).toBe(30_000);
  });

  it("30초가 되면 다시 한 번 — 셋 모두 새 사건(sequence 2)", async () => {
    const { hub, load, answer, scheduler } = setUp();
    const recorders = [recorder(), recorder()];
    for (const { listener } of recorders) hub.subscribe("5m", listener);
    await answer(1);
    scheduler.runPending();
    expect(load).toHaveBeenCalledTimes(2);
    await answer(2);
    for (const { events } of recorders) expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(countOf(recorders[0].events[1])).toBe(2);
  });

  it("기간이 다르면 기간마다 따로 한 번", async () => {
    const { hub, load } = setUp();
    hub.subscribe("5m", recorder().listener);
    hub.subscribe("24h", recorder().listener);
    hub.subscribe("24h", recorder().listener);
    expect(load.mock.calls.map(([range]) => range)).toEqual(["5m", "24h"]);
  });

  it("나중에 붙은 연결은 마지막 지도를 곧바로 받는다(새로 부르지 않는다)", async () => {
    const { hub, load, answer } = setUp();
    hub.subscribe("5m", recorder().listener);
    await answer(5);
    const late = recorder();
    hub.subscribe("5m", late.listener);
    expect(late.events.map((event) => [event.sequence, countOf(event)])).toEqual([[1, 5]]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("조회가 도는 중에 붙은 연결은 그 결과를 받는다(두 번째 조회 없음)", async () => {
    const { hub, load, answer } = setUp();
    const first = recorder();
    const second = recorder();
    hub.subscribe("5m", first.listener);
    hub.subscribe("5m", second.listener);
    expect(load).toHaveBeenCalledTimes(1);
    expect(second.events).toEqual([]);
    await answer(3);
    expect(second.events.map((event) => event.sequence)).toEqual([1]);
  });
});

describe("겹쳐 부르지 않는다 — 관측 서버가 느릴 때", () => {
  it("조회가 끝나기 전에는 다음 타이머를 걸지 않는다 · 끝난 뒤 30초", async () => {
    const { hub, load, answer, scheduler, clock } = setUp();
    hub.subscribe("24h", recorder().listener);
    clock.now += 45_000;                      // 조회가 주기보다 오래 걸린다
    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.runPending()).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
    await answer();
    expect(scheduler.scheduledDelays).toEqual([30_000]);
    scheduler.runPending();
    expect(load).toHaveBeenCalledTimes(2);
    expect(scheduler.pendingCount()).toBe(0);  // 두 번째 조회가 끝나기 전에는 세 번째가 없다
  });
});

describe("떠나면 거둔다 — 새는 타이머 없음", () => {
  it("마지막 연결이 떠나면 걸린 타이머를 거두고 다시 부르지 않는다", async () => {
    const { hub, load, answer, scheduler } = setUp();
    const leaveFirst = hub.subscribe("5m", recorder().listener);
    const leaveSecond = hub.subscribe("5m", recorder().listener);
    await answer();
    leaveFirst();
    expect(scheduler.pendingCount()).toBe(1);   // 아직 하나 남았다
    leaveSecond();
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.runPending();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("조회가 도는 중에 모두 떠나면 — 끝난 뒤 타이머를 걸지 않고 떠난 연결에 보내지 않는다", async () => {
    const { hub, answer, scheduler } = setUp();
    const gone = recorder();
    const leave = hub.subscribe("5m", gone.listener);
    leave();
    await answer();
    expect(scheduler.pendingCount()).toBe(0);
    expect(gone.events).toEqual([]);
  });

  it("떠나기를 두 번 불러도 다른 연결을 떼지 않는다", async () => {
    const { hub, answer, scheduler } = setUp();
    const stay = recorder();
    const leave = hub.subscribe("5m", recorder().listener);
    hub.subscribe("5m", stay.listener);
    await answer(1);
    leave();
    leave();
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.runPending();
    await answer(2);
    expect(stay.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("떠났다 30초 안에 다시 붙으면 마지막 지도를 곧바로 · 다음 조회는 남은 시간 뒤", async () => {
    const { hub, load, answer, scheduler, clock } = setUp();
    const leave = hub.subscribe("5m", recorder().listener);
    await answer(4);
    leave();
    clock.now += 10_000;
    const again = recorder();
    hub.subscribe("5m", again.listener);
    expect(again.events.map((event) => event.sequence)).toEqual([1]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(scheduler.scheduledDelays.at(-1)).toBe(20_000);
  });

  it("마지막 지도가 30초보다 오래됐으면 다시 붙을 때 곧바로 부른다", async () => {
    const { hub, load, answer, clock } = setUp();
    const leave = hub.subscribe("5m", recorder().listener);
    await answer();
    leave();
    clock.now += 30_000;
    hub.subscribe("5m", recorder().listener);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("화면의 첫 그림 — snapshot", () => {
  it("연결이 없을 때 한 번 부르고 · 타이머는 걸지 않는다 · 30초 안의 두 번째는 부르지 않는다", async () => {
    const { hub, load, answer, scheduler, clock } = setUp();
    const first = hub.snapshot("1h");
    await answer(9);
    const event = await first;
    expect([event.sequence, event.range, countOf(event)]).toEqual([1, "1h", 9]);
    expect(event.fetchedAt).toBe(new Date(T).toISOString());
    expect(scheduler.pendingCount()).toBe(0);
    clock.now += 29_999;
    expect((await hub.snapshot("1h")).sequence).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("연결의 조회가 도는 중이면 그 결과를 나눠 쓴다(조회 한 번)", async () => {
    const { hub, load, answer } = setUp();
    hub.subscribe("5m", recorder().listener);
    const shot = hub.snapshot("5m");
    await answer(2);
    expect(countOf(await shot)).toBe(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("snapshot 뒤 30초 안에 붙은 연결은 그 지도를 곧바로 받는다", async () => {
    const { hub, load, answer } = setUp();
    const shot = hub.snapshot("5m");
    await answer(6);
    await shot;
    const live = recorder();
    hub.subscribe("5m", live.listener);
    expect(live.events.map((event) => countOf(event))).toEqual([6]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("clear 뒤에는 다시 부른다 — sequence 는 되돌리지 않는다", async () => {
    const { hub, load, answer } = setUp();
    const first = hub.snapshot("5m");
    await answer();
    expect((await first).sequence).toBe(1);
    hub.clear();
    const second = hub.snapshot("5m");
    await answer();
    expect((await second).sequence).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("실패 · 예외도 사건으로", () => {
  it("조회의 실패는 그대로 사건의 map 으로(다음 조회도 건다)", async () => {
    const { hub, answer, scheduler } = setUp();
    const live = recorder();
    hub.subscribe("5m", live.listener);
    await answer(0, upstreamFailure("unavailable", { status: 503 }));
    expectFailure(live.events[0].map, "unavailable", 503);
    expect(scheduler.pendingCount()).toBe(1);
  });

  it("조회가 던지면 unreachable(허브가 멈추지 않는다)", async () => {
    const { hub, pending, scheduler } = setUp();
    const live = recorder();
    hub.subscribe("5m", live.listener);
    pending.shift()!.reject(new Error("boom 198.51.100.23"));
    await flush();
    expectFailure(live.events[0].map, "unreachable");
    expect(JSON.stringify(live.events)).not.toContain("198.51.100.23");
    expect(scheduler.pendingCount()).toBe(1);
  });

  it("sequence 는 기간과 무관하게 허브 전체에서 는다 · fetchedAt 은 조회가 끝난 때", async () => {
    const { hub, answer, clock } = setUp();
    const short = recorder();
    const long = recorder();
    hub.subscribe("5m", short.listener);
    hub.subscribe("24h", long.listener);
    await answer();
    clock.now += 1234;
    await answer();
    expect(short.events.map((event) => [event.sequence, event.fetchedAt])).toEqual([[1, new Date(T).toISOString()]]);
    expect(long.events.map((event) => [event.sequence, event.fetchedAt])).toEqual([[2, new Date(T + 1234).toISOString()]]);
  });
});
