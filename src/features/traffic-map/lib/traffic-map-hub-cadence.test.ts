/** 통신 지도의 공유 조회 — 주기당 한 번(T8 리뷰 3)과 멈춤(T8 리뷰 1). 시간을 아는 가짜 타이머 · 가짜 조회(걸리는 시간을 정한다)로 돌린다.
 * 불변식: 기간마다 "걸린 타이머 또는 도는 조회"는 늘 하나 — 관측 서버 조회의 시작 시각은 기간마다 30초보다 가깝지 않다
 * (30초 타이머가 걸린 채 낡은 값을 보는 새 구독 · snapshot · 타이머와 같은 틱의 구독 · 조회 도중 떠났다 붙기 · 무작위의 붙기 · 떠나기 — 씨앗 고정).
 * 멈추면: 걸린 타이머가 모두 거둬지고 그 뒤로는 부르지 않는다(도는 조회가 끝나도 보내지 · 다시 걸지 않는다). */
import { describe, expect, it } from "vitest";
import type { Scheduler } from "@/features/auth/lib/replay-scheduler";
import { TRAFFIC_MAP_POLL_MILLISECONDS, createTrafficMapHub, type TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";
import type { TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import { buildTrafficMapView, type TrafficMapView } from "@/features/traffic-map/lib/traffic-map-view";
import { fakeEdge, trafficMapSnapshotOf } from "@/features/traffic-map/lib/traffic-map-test-fakes";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

const T = Date.UTC(2026, 10, 27, 1, 0, 0, 0);

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

/** 시각을 아는 가짜 — 타이머와 조회의 끝이 시각 차례로 일어난다. durationOf 가 조회마다 걸리는 시간을, latenessOf 가 타이머가 늦게 터지는 정도를
 * 정한다(실제 setTimeout 은 바쁜 이벤트 루프에서 늦게 돈다 — 그 사이에 낡은 값을 본 구독 · snapshot 의 조회가 끝날 수 있다). */
function createTimeline(durationOf: () => number = () => 0, latenessOf: () => number = () => 0) {
  const clock = { now: T };
  const tasks: { due: number; callback: () => void; cancelled: boolean; order: number }[] = [];
  const loads: { range: TrafficMapRange; due: number; resolve: (result: UpstreamResult<TrafficMapView>) => void; done: boolean; order: number }[] = [];
  const starts: { range: TrafficMapRange; at: number }[] = [];
  let order = 0;
  const scheduler: Scheduler = (callback, milliseconds) => {
    const task = { due: clock.now + milliseconds + latenessOf(), callback, cancelled: false, order: order++ };
    tasks.push(task);
    return { cancel: () => { task.cancelled = true; }, keepsProcessAlive: () => false };
  };
  const load = (range: TrafficMapRange) => new Promise<UpstreamResult<TrafficMapView>>((resolve) => {
    starts.push({ range, at: clock.now });
    loads.push({ range, due: clock.now + durationOf(), resolve, done: false, order: order++ });
  });
  const hub = createTrafficMapHub({ load, scheduler, now: () => clock.now });
  /** milliseconds 만큼 시간을 보낸다 — 그 사이의 타이머 · 조회의 끝을 시각 차례로(같은 시각이면 먼저 생긴 차례로). */
  async function advance(milliseconds: number) {
    const end = clock.now + milliseconds;
    for (;;) {
      await flush();
      const dueTask = tasks.filter((task) => !task.cancelled && task.due <= end).sort((left, right) => left.due - right.due || left.order - right.order)[0];
      const dueLoad = loads.filter((item) => !item.done && item.due <= end).sort((left, right) => left.due - right.due || left.order - right.order)[0];
      if (dueTask === undefined && dueLoad === undefined) break;
      const takeLoad = dueLoad !== undefined && (dueTask === undefined || dueLoad.due < dueTask.due || (dueLoad.due === dueTask.due && dueLoad.order < dueTask.order));
      if (takeLoad) {
        clock.now = Math.max(clock.now, dueLoad!.due);
        dueLoad!.done = true;
        dueLoad!.resolve({ ok: true, value: buildTrafficMapView(trafficMapSnapshotOf([fakeEdge()])) });
      } else {
        clock.now = Math.max(clock.now, dueTask!.due);
        dueTask!.cancelled = true;
        dueTask!.callback();
      }
    }
    clock.now = end;
    await flush();
  }
  const pendingTasks = () => tasks.filter((task) => !task.cancelled).length;
  return { clock, hub, starts, advance, pendingTasks };
}

function expectCadence(starts: { range: TrafficMapRange; at: number }[]) {
  for (const range of new Set(starts.map((start) => start.range))) {
    const times = starts.filter((start) => start.range === range).map((start) => start.at);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index] - times[index - 1], `${range}: ${times.join(", ")}`).toBeGreaterThanOrEqual(TRAFFIC_MAP_POLL_MILLISECONDS);
    }
  }
}

describe("주기당 한 번 — 겹치는 길", () => {
  it("30초 타이머가 걸린 채 마지막 값이 낡았다고 보는 새 구독 — 그 주기에 관측 서버는 한 번", async () => {
    const { clock, hub, starts, advance } = createTimeline();
    hub.subscribe("5m", () => undefined);
    await advance(0);
    expect(starts).toHaveLength(1);
    clock.now = T + TRAFFIC_MAP_POLL_MILLISECONDS;            // 타이머가 터질 때이지만 아직 돌지 않았다 — 마지막 값은 정확히 30초(낡음)
    hub.subscribe("5m", () => undefined);
    await advance(0);                                          // 같은 틱에 타이머가 돈다
    await advance(1000);
    expect(starts.map((start) => start.at)).toEqual([T, T + TRAFFIC_MAP_POLL_MILLISECONDS]);
    expectCadence(starts);
  });

  it("같은 때의 snapshot(첫 그림)도 — 한 번", async () => {
    const { clock, hub, starts, advance } = createTimeline();
    hub.subscribe("5m", () => undefined);
    await advance(0);
    clock.now = T + TRAFFIC_MAP_POLL_MILLISECONDS + 100;     // 타이머가 조금 늦었다
    const shot = hub.snapshot("5m");
    await advance(0);
    await shot;
    await advance(5000);
    expect(starts.map((start) => start.at)).toEqual([T, T + TRAFFIC_MAP_POLL_MILLISECONDS + 100]);
  });

  it("타이머가 늦게 터지는 사이 낡은 값을 본 snapshot 의 조회가 먼저 끝나면 — 늦은 타이머가 곧바로 또 부르지 않는다(다음은 그 조회가 끝난 뒤 30초)", async () => {
    let late = 2000;
    const { clock, hub, starts, advance } = createTimeline(() => 100, () => late);
    hub.subscribe("5m", () => undefined);
    await advance(100);                                         // 첫 조회 T ~ T+100, 다음 타이머는 T+30100 이어야 하지만 2초 늦게(T+32100)
    late = 0;
    clock.now = T + 100 + TRAFFIC_MAP_POLL_MILLISECONDS + 500;  // 타이머가 아직 돌지 않았다 — 마지막 값은 낡음
    const shot = hub.snapshot("5m");
    await advance(200);                                         // snapshot 의 조회가 끝난다(T+30700)
    await shot;
    await advance(5000);                                        // 늦은 타이머가 터진다
    expect(starts.map((start) => start.at - T)).toEqual([0, 30_600]);
    await advance(TRAFFIC_MAP_POLL_MILLISECONDS);
    expectCadence(starts);
    expect(starts).toHaveLength(2 + 1);
  });

  it("타이머가 터진 틱에 붙은 구독 — 도는 조회를 나눠 쓴다(두 번째 조회 없음)", async () => {
    const { hub, starts, advance } = createTimeline(() => 2000);
    hub.subscribe("5m", () => undefined);
    await advance(2000);
    await advance(TRAFFIC_MAP_POLL_MILLISECONDS);             // 타이머가 터져 두 번째 조회가 돈다
    const events: TrafficMapEvent[] = [];
    hub.subscribe("5m", (event) => events.push(event));
    await advance(2000);
    expect(starts).toHaveLength(2);
    expect(events.map((event) => event.sequence)).toEqual([2]);
  });

  it("조회 도중 구독이 떠났다 다시 붙기 — 새 조회 없음 · 붙은 구독이 결과를 받는다 · 다음 타이머는 하나", async () => {
    const { hub, starts, advance, pendingTasks } = createTimeline(() => 5000);
    const leave = hub.subscribe("1h", () => undefined);
    await advance(1000);
    leave();
    await advance(1000);
    const events: TrafficMapEvent[] = [];
    hub.subscribe("1h", (event) => events.push(event));
    await advance(3000);
    expect(starts).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(pendingTasks()).toBe(1);
    await advance(TRAFFIC_MAP_POLL_MILLISECONDS);
    expect(starts).toHaveLength(2);
    expectCadence(starts);
  });

  it.each(Array.from({ length: 20 }, (_, index) => index + 1))("무작위의 붙기 · 떠나기 · snapshot · 느린 조회(씨앗 %i) — 기간마다 조회의 시작이 30초보다 가깝지 않다", async (seed) => {
    let state = seed * 2654435761 % 4294967296;
    const random = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
    const { hub, starts, advance } = createTimeline(() => (random() < 0.5 ? Math.floor(random() * 500) : Math.floor(random() * 40_000)), () => Math.floor(random() * 3000));
    const ranges: TrafficMapRange[] = ["5m", "1h"];
    const leaves: (() => void)[] = [];
    for (let step = 0; step < 150; step += 1) {
      const pick = random();
      const range = ranges[Math.floor(random() * ranges.length)];
      if (pick < 0.3) leaves.push(hub.subscribe(range, () => undefined));
      else if (pick < 0.5 && leaves.length > 0) leaves.splice(Math.floor(random() * leaves.length), 1)[0]();
      else if (pick < 0.65) void hub.snapshot(range);
      await advance(Math.floor(random() * 20_000));
    }
    expect(starts.length).toBeGreaterThan(5);
    expectCadence(starts);
  });
});

describe("멈춤 — stop(T8 리뷰 1)", () => {
  it("걸린 타이머를 모두 거두고 그 뒤로 관측 서버를 부르지 않는다", async () => {
    const { hub, starts, advance, pendingTasks } = createTimeline();
    hub.subscribe("5m", () => undefined);
    hub.subscribe("24h", () => undefined);
    await advance(0);
    expect(pendingTasks()).toBe(2);
    hub.stop();
    expect(pendingTasks()).toBe(0);
    await advance(10 * 60_000);
    expect(starts).toHaveLength(2);
  });

  it("도는 조회가 멈춘 뒤 끝나도 — 보내지 않고 타이머를 걸지 않는다", async () => {
    const { hub, starts, advance, pendingTasks } = createTimeline(() => 5000);
    const events: TrafficMapEvent[] = [];
    hub.subscribe("5m", (event) => events.push(event));
    await advance(1000);
    hub.stop();
    await advance(10 * 60_000);
    expect(events).toEqual([]);
    expect(pendingTasks()).toBe(0);
    expect(starts).toHaveLength(1);
  });

  it("멈춘 뒤의 구독은 부르지 않는다(떠나기는 그대로 불러도 된다) · snapshot 은 부르지 않고 unavailable · 두 번 멈춰도 같다", async () => {
    const { hub, starts, advance, pendingTasks } = createTimeline();
    hub.stop();
    hub.stop();
    const events: TrafficMapEvent[] = [];
    const leave = hub.subscribe("5m", (event) => events.push(event));
    const shot = await hub.snapshot("1h");
    expect(shot.range).toBe("1h");
    expect(shot.map).toMatchObject({ ok: false, reason: "unavailable" });
    expect(() => { leave(); leave(); }).not.toThrow();
    await advance(5 * 60_000);
    expect(starts).toHaveLength(0);
    expect(events).toEqual([]);
    expect(pendingTasks()).toBe(0);
  });
});
