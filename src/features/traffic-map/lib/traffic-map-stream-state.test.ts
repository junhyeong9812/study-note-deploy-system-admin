/** 통신 지도의 브라우저 쪽 상태(T8, 순수) — 새 사건이 오면 그 값으로 · 같은 사건 두 번 · 늦게 온 옛 사건은 버린다 · 깨진 사건(JSON 아님 · 칸 빠짐)에 죽지 않고
 * 앞 값을 지키며 센다 · **진도가 뒤로 간 사건**(채워짐 → 채우는 중)은 그대로 받아들인다 · 실패 사건은 앞 지도를 낡은 값으로 남긴다 · 끊김 → 다시 붙는 중 ·
 * 다시 붙으면 처음부터(sequence 를 비운다) · 세션 끝 → 다시 붙지 않는다. EventSource 를 잇는 함수는 가짜 EventSource · 가짜 타이머로. */
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeScheduler } from "@/features/auth/lib/test-fakes";
import {
  TRAFFIC_STREAM_PATH, TRAFFIC_STREAM_RECONNECT_MILLISECONDS, connectTrafficMapStream, initialTrafficMapStreamState, parseTrafficMapEvent,
  reduceTrafficMapStream, type TrafficMapStreamAction, type TrafficMapStreamState,
} from "@/features/traffic-map/lib/traffic-map-stream-state";
import { FakeEventSource, LEAKED_ADDRESS, chatMapEdges, fakeEdge, trafficMapEventOf } from "@/features/traffic-map/lib/traffic-map-test-fakes";
import { UPSTREAM_FAILURE_MESSAGES, upstreamFailure } from "@/shared/lib/upstream-result";
import type { TrafficMapEvent } from "@/features/traffic-map/lib/traffic-map-hub";

const wire = (event: unknown) => JSON.stringify(event);
const mapAction = (event: unknown): TrafficMapStreamAction => ({ type: "map", data: typeof event === "string" ? event : wire(event) });

function run(state: TrafficMapStreamState, ...actions: TrafficMapStreamAction[]): TrafficMapStreamState {
  return actions.reduce(reduceTrafficMapStream, state);
}

const countOf = (state: TrafficMapStreamState, service = "backend") => {
  const map = state.shown?.map;
  if (map === undefined || !map.ok) throw new Error("지도가 없다");
  return map.value.edges.find((edge) => edge.service === service)!;
};

describe("상수 · 첫 상태", () => {
  it("경로 /api/traffic/stream · 닫힌 뒤 다시 여는 간격 5초", () => {
    expect(TRAFFIC_STREAM_PATH).toBe("/api/traffic/stream");
    expect(TRAFFIC_STREAM_RECONNECT_MILLISECONDS).toBe(5_000);
  });

  it("서버가 준 첫 사건으로 — connecting · 그 지도 · 그 sequence · 그 시각", () => {
    const initial = trafficMapEventOf(3, chatMapEdges());
    expect(initialTrafficMapStreamState(initial)).toEqual({
      connection: "connecting", shown: initial, failure: null, lastSequence: 3, lastReceivedAt: initial.fetchedAt, brokenEvents: 0,
    });
  });

  it("첫 사건이 실패면 shown 은 없고 failure", () => {
    const initial: TrafficMapEvent = { ...trafficMapEventOf(1, []), map: upstreamFailure("unreachable") };
    expect(initialTrafficMapStreamState(initial)).toMatchObject({ shown: null, failure: { reason: "unreachable" }, lastSequence: 1 });
  });

  it("첫 사건이 없으면(null) 아무것도 모름", () => {
    expect(initialTrafficMapStreamState(null)).toEqual({ connection: "connecting", shown: null, failure: null, lastSequence: null, lastReceivedAt: null, brokenEvents: 0 });
  });
});

describe("사건 받기", () => {
  const start = () => initialTrafficMapStreamState(trafficMapEventOf(1, [fakeEdge({ count: 10 })]));

  it("새 사건 → 그 값으로(connection open · lastSequence · lastReceivedAt)", () => {
    const next = trafficMapEventOf(2, [fakeEdge({ count: 20 })]);
    const state = run(start(), { type: "open" }, mapAction(next));
    expect(state).toMatchObject({ connection: "open", lastSequence: 2, lastReceivedAt: next.fetchedAt, failure: null, brokenEvents: 0 });
    expect(countOf(state).count).toBe(20);
  });

  it("같은 사건 두 번 · 늦게 온 옛 사건은 버린다(값이 되돌아가지 않는다)", () => {
    const state = run(start(), mapAction(trafficMapEventOf(3, [fakeEdge({ count: 30 })])), mapAction(trafficMapEventOf(3, [fakeEdge({ count: 99 })])),
      mapAction(trafficMapEventOf(2, [fakeEdge({ count: 20 })])));
    expect(countOf(state).count).toBe(30);
    expect(state.lastSequence).toBe(3);
    expect(state.brokenEvents).toBe(0);
  });

  it("진도가 뒤로 간 사건 — '채워짐'이던 선이 '채우는 중'으로 돌아가면 그렇게(0 으로 보이지 않는다)", () => {
    const settled = trafficMapEventOf(2, [fakeEdge({ count: 20, fillingCount: 0 })]);
    const backward = trafficMapEventOf(3, [fakeEdge({ count: 12, fillingCount: 8 })]);
    const unknown = trafficMapEventOf(4, [fakeEdge({ count: 0, fillingCount: 20, status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 }, p50: null, p95: null, maxMilliseconds: null })]);
    let state = run(start(), mapAction(settled));
    expect(countOf(state).completeness).toBe("settled");
    state = run(state, mapAction(backward));
    expect(countOf(state)).toMatchObject({ completeness: "filling", count: 12, fillingCount: 8 });
    state = run(state, mapAction(unknown));
    expect(countOf(state)).toMatchObject({ completeness: "unknown", count: 0, fillingCount: 20 });
  });

  it("실패 사건 — 앞의 지도는 그대로(shown) · failure 에 실패 · lastReceivedAt 은 그 실패의 시각", () => {
    const failed: TrafficMapEvent = { sequence: 2, fetchedAt: "2026-11-25T04:10:30.000Z", range: "5m", map: upstreamFailure("unavailable", { status: 503 }) };
    const state = run(start(), mapAction(failed));
    expect(countOf(state).count).toBe(10);
    expect(state.failure).toEqual(upstreamFailure("unavailable", { status: 503 }));
    expect(state.lastReceivedAt).toBe("2026-11-25T04:10:30.000Z");
    const recovered = run(state, mapAction(trafficMapEventOf(3, [fakeEdge({ count: 40 })])));
    expect(recovered.failure).toBeNull();
    expect(countOf(recovered).count).toBe(40);
  });

  it("실패 사건의 글은 받은 글자가 아니라 고정 표의 글자(관측 서버의 오류 글이 끼어들지 않는다)", () => {
    const state = run(start(), mapAction({ sequence: 2, fetchedAt: "2026-11-25T04:10:30.000Z", range: "5m",
      map: { ok: false, reason: "unavailable", status: 503, message: `<script>x</script> ${LEAKED_ADDRESS}` } }));
    expect(state.failure).toEqual({ ok: false, reason: "unavailable", status: 503, message: UPSTREAM_FAILURE_MESSAGES.unavailable });
  });

  it.each([
    ["JSON 아님", (): unknown => ("{not json")],
    ["빈 글", (): unknown => ("")],
    ["sequence 가 글자", (): unknown => ({ ...trafficMapEventOf(5, []), sequence: "5" })],
    ["sequence 음수", (): unknown => ({ ...trafficMapEventOf(5, []), sequence: -1 })],
    ["fetchedAt 이 시각 아님", (): unknown => ({ ...trafficMapEventOf(5, []), fetchedAt: "곧" })],
    ["모르는 기간", (): unknown => ({ ...trafficMapEventOf(5, []), range: "7d" })],
    ["map 빠짐", (): unknown => ({ sequence: 5, fetchedAt: "2026-11-25T04:10:30.000Z", range: "5m" })],
    ["모르는 실패 이유", (): unknown => ({ sequence: 5, fetchedAt: "2026-11-25T04:10:30.000Z", range: "5m", map: { ok: false, reason: "boom", message: "x" } })],
    ["선의 칸 빠짐(count)", (): unknown => { const event = trafficMapEventOf(5, [fakeEdge()]); const map = event.map as unknown as { ok: true; value: { edges: Record<string, unknown>[] } };
      delete map.value.edges[0].count; return event; }],
    ["선의 completeness 가 모르는 값", (): unknown => ((() => { const event = trafficMapEventOf(5, [fakeEdge()]); (event.map as unknown as { ok: true; value: { edges: Record<string, unknown>[] } }).value.edges[0].completeness = "maybe"; return event; })())],
    ["nodes 가 배열 아님", (): unknown => ((() => { const event = trafficMapEventOf(5, [fakeEdge()]); (event.map as unknown as { ok: true; value: Record<string, unknown> }).value.nodes = "front"; return event; })())],
    ["서버의 behind 빠짐", (): unknown => ((() => { const event = trafficMapEventOf(5, [fakeEdge()]); delete (event.map as unknown as { ok: true; value: { servers: Record<string, unknown>[] } }).value.servers[0].behind; return event; })())],
    ["이름에 태그", (): unknown => ((() => { const event = trafficMapEventOf(5, [fakeEdge()]); (event.map as unknown as { ok: true; value: { edges: Record<string, unknown>[] } }).value.edges[0].caller = "<b>x</b>"; return event; })())],
  ] as const)("깨진 사건(%s) — 죽지 않고 앞 값을 지키며 brokenEvents 를 센다(sequence 도 그대로)", (_label, makeEvent) => {
    const event = (makeEvent as () => unknown)();
    const before = start();
    const after = run(before, mapAction(event as unknown));
    expect(after.brokenEvents).toBe(1);
    expect(after.shown).toEqual(before.shown);
    expect(after.lastSequence).toBe(1);
    expect(parseTrafficMapEvent(typeof event === "string" ? event : wire(event))).toBeNull();
  });

  it("깨진 사건 둘 → 2 · 다음 정상 사건은 받는다", () => {
    const state = run(start(), mapAction("x"), mapAction("{}"), mapAction(trafficMapEventOf(2, [fakeEdge({ count: 2 })])));
    expect(state.brokenEvents).toBe(2);
    expect(countOf(state).count).toBe(2);
  });

  it("모르는 칸(주소)은 받은 사건에서 버린다 — 상태 어디에도 없다", () => {
    const event = trafficMapEventOf(2, chatMapEdges()) as unknown as Record<string, unknown>;
    const map = event.map as { value: { edges: Record<string, unknown>[]; servers: Record<string, unknown>[] } };
    map.value.edges[0].upstream_addr = LEAKED_ADDRESS;
    map.value.servers[0].remote_addr = LEAKED_ADDRESS;
    event.remote_addr = LEAKED_ADDRESS;
    const state = run(start(), mapAction(event));
    expect(state.lastSequence).toBe(2);
    expect(JSON.stringify(state)).not.toContain(LEAKED_ADDRESS);
  });
});

describe("연결", () => {
  const start = () => run(initialTrafficMapStreamState(trafficMapEventOf(5, [fakeEdge({ count: 10 })])), { type: "open" }, mapAction(trafficMapEventOf(6, [fakeEdge({ count: 11 })])));

  it("끊김 → reconnecting(지도와 마지막으로 받은 시각은 그대로 — 화면이 낡은 값임을 보인다)", () => {
    const before = start();
    const state = run(before, { type: "error" });
    expect(state).toMatchObject({ connection: "reconnecting", lastSequence: 6, lastReceivedAt: before.lastReceivedAt });
    expect(countOf(state).count).toBe(11);
  });

  it("다시 붙으면(open) 처음부터 — 서버가 다시 떠 sequence 가 작아져도 받는다", () => {
    const state = run(start(), { type: "error" }, { type: "open" }, mapAction(trafficMapEventOf(1, [fakeEdge({ count: 77 })])));
    expect(state).toMatchObject({ connection: "open", lastSequence: 1 });
    expect(countOf(state).count).toBe(77);
  });

  it("세션 끝 → session_ended · 그 뒤의 끊김 · 열림에도 그대로", () => {
    const state = run(start(), { type: "session" }, { type: "error" }, { type: "open" });
    expect(state.connection).toBe("session_ended");
  });
});

describe("connectTrafficMapStream — 가짜 EventSource", () => {
  beforeEach(() => { FakeEventSource.instances = []; });

  function connect() {
    const scheduler = createFakeScheduler();
    const actions: TrafficMapStreamAction[] = [];
    const close = connectTrafficMapStream({
      url: `${TRAFFIC_STREAM_PATH}?range=1h`, createEventSource: (url) => new FakeEventSource(url), dispatch: (action) => { actions.push(action); }, scheduler: scheduler.scheduler,
    });
    return { scheduler, actions, close, source: () => FakeEventSource.instances.at(-1)! };
  }

  it("주소 그대로 하나를 열고 open · map · error · session 을 듣는다", () => {
    const { source } = connect();
    expect(FakeEventSource.instances.map((instance) => instance.url)).toEqual(["/api/traffic/stream?range=1h"]);
    expect(source().listenerTypes()).toEqual(["error", "map", "open", "session"]);
  });

  it("사건을 상태의 행동으로 — map 의 data 는 글 그대로(글이 아니면 빈 글 → 깨진 사건)", () => {
    const { source, actions } = connect();
    source().emit("open");
    source().emit("map", "{\"sequence\":1}");
    source().emit("map", 42);
    expect(actions).toEqual([{ type: "open" }, { type: "map", data: "{\"sequence\":1}" }, { type: "map", data: "" }]);
  });

  it("끊김(CONNECTING — 브라우저가 스스로 다시 붙는다) → error 만, 새로 열지 않는다", () => {
    const { source, actions, scheduler } = connect();
    source().readyState = 0;
    source().emit("error");
    expect(actions).toEqual([{ type: "error" }]);
    expect(scheduler.pendingCount()).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("닫힘(CLOSED — 401 · 502 등으로 브라우저가 포기) → error · 5초 뒤 새로 연다", () => {
    const { source, actions, scheduler } = connect();
    const first = source();
    first.readyState = 2;
    first.emit("error");
    expect(actions).toEqual([{ type: "error" }]);
    expect(scheduler.scheduledDelays).toEqual([5_000]);
    scheduler.runPending();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.closed).toBe(true);
    source().emit("open");
    expect(actions.at(-1)).toEqual({ type: "open" });
  });

  it("세션 끝 → session · 닫고 다시 열지 않는다(뒤따른 error 에도)", () => {
    const { source, actions, scheduler } = connect();
    source().emit("session", "{\"reason\":\"expired\"}");
    expect(source().closed).toBe(true);
    source().emit("error");
    expect(actions.map((action) => action.type)).toEqual(["session"]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("거두면(화면을 떠남) 닫고 · 걸린 다시 열기를 거두고 · 그 뒤의 사건은 보내지 않는다", () => {
    const { source, actions, scheduler, close } = connect();
    const first = source();
    first.readyState = 2;
    first.emit("error");
    close();
    expect(first.closed).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.runPending();
    expect(FakeEventSource.instances).toHaveLength(1);
    first.emit("map", "{}");
    expect(actions).toEqual([{ type: "error" }]);
  });
});
