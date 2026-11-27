/** 의존의 선 — 브라우저 쪽 상태(명세 T9d · T8 의 관례: 깨진 사건은 버리고 센다 · 옛 사건은 버린다 · 다시 붙으면 처음부터 ·
 * 낡음 = 끊김 · 다시 붙음(새 값 전) · 세션 끝 · 마지막 확인이 90초보다 오래됨). 잇는 함수가 `dependencies` 사건을 넘긴다. */
import { describe, expect, it, vi } from "vitest";
import { createFakeScheduler } from "@/features/auth/lib/test-fakes";
import { DEPENDENCY_STALE_MILLISECONDS, type DependencyLine } from "@/features/traffic-map/lib/dependency-lines";
import { DEPENDENCY_DETAIL_MARKER } from "@/features/traffic-map/lib/dependency-test-fakes";
import type { TrafficDependencyEvent } from "@/features/traffic-map/lib/traffic-dependency-hub";
import {
  initialTrafficDependencyStreamState, isDependencyStale, parseTrafficDependencyEvent, reduceTrafficDependencyStream, type TrafficDependencyStreamState,
} from "@/features/traffic-map/lib/traffic-dependency-stream";
import { connectTrafficMapStream, type EventSourceLike } from "@/features/traffic-map/lib/traffic-map-stream-state";

const T = Date.UTC(2026, 10, 30, 4, 10, 0, 0);
const LINES: DependencyLine[] = [
  { service: "backend", dependency: "redis", state: "up", tookMs: 1, reason: null },
  { service: "observe", dependency: "postgres", state: "unknown", tookMs: null, reason: "timeout" },
];

function eventOf(sequence: number, overrides: Partial<TrafficDependencyEvent> = {}): TrafficDependencyEvent {
  return { sequence, checkedAt: new Date(T).toISOString(), lines: LINES, ...overrides };
}

const dependenciesAction = (event: unknown) => ({ type: "dependencies" as const, data: JSON.stringify(event) });

function after(...actions: Parameters<typeof reduceTrafficDependencyStream>[1][]): TrafficDependencyStreamState {
  return actions.reduce(reduceTrafficDependencyStream, initialTrafficDependencyStreamState(null));
}

describe("4 사건을 받는다", () => {
  it("첫 그림이 없으면 비어 있다 · 있으면 그것", () => {
    expect(initialTrafficDependencyStreamState(null)).toEqual({ shown: null, lastSequence: null, brokenEvents: 0 });
    expect(initialTrafficDependencyStreamState(eventOf(3))).toEqual({ shown: eventOf(3), lastSequence: 3, brokenEvents: 0 });
  });

  it("받아들이면 shown 을 간다 · 같은 · 옛 sequence 는 버린다", () => {
    const state = after(dependenciesAction(eventOf(1)), dependenciesAction(eventOf(2, { lines: [LINES[0]] })), dependenciesAction(eventOf(2)), dependenciesAction(eventOf(1)));
    expect(state.shown).toEqual(eventOf(2, { lines: [LINES[0]] }));
    expect(state.lastSequence).toBe(2);
  });

  it("open 뒤에는 처음부터(서버가 다시 떠 sequence 가 작아져도 받는다)", () => {
    const state = after(dependenciesAction(eventOf(5)), { type: "open" }, dependenciesAction(eventOf(1)));
    expect(state.shown?.sequence).toBe(1);
  });

  it("모르는 칸(detail · extra)은 버린다 — 상태에 남지 않는다", () => {
    const leaky = { ...eventOf(1), extra: DEPENDENCY_DETAIL_MARKER, lines: [{ ...LINES[0], detail: DEPENDENCY_DETAIL_MARKER }] };
    const state = after(dependenciesAction(leaky));
    expect(state.shown).toEqual(eventOf(1, { lines: [LINES[0]] }));
    expect(JSON.stringify(state)).not.toContain(DEPENDENCY_DETAIL_MARKER);
  });

  it.each([
    ["JSON 이 아님", "{"],
    ["sequence 가 글", JSON.stringify({ ...eventOf(1), sequence: "1" })],
    ["checkedAt 이 시각이 아님", JSON.stringify({ ...eventOf(1), checkedAt: "어제" })],
    ["lines 가 배열이 아님", JSON.stringify({ ...eventOf(1), lines: {} })],
    ["표 밖의 의존", JSON.stringify(eventOf(1, { lines: [{ ...LINES[0], dependency: "kafka" as never }] }))],
    ["짝이 아닌 서비스 · 의존(llm-wrapper → redis)", JSON.stringify(eventOf(1, { lines: [{ ...LINES[0], service: "llm-wrapper" }] }))],
    ["모르는 상태", JSON.stringify(eventOf(1, { lines: [{ ...LINES[0], state: "maybe" as never }] }))],
    ["모르는 까닭", JSON.stringify(eventOf(1, { lines: [{ ...LINES[1], reason: "boom" as never }] }))],
    ["걸린 시간이 음수", JSON.stringify(eventOf(1, { lines: [{ ...LINES[0], tookMs: -1 }] }))],
  ])("깨진 사건(%s)은 버리고 센다 — 앞의 값 그대로", (_label, data) => {
    expect(parseTrafficDependencyEvent(data)).toBeNull();
    const state = after(dependenciesAction(eventOf(1)), { type: "dependencies", data });
    expect(state.shown).toEqual(eventOf(1));
    expect(state.brokenEvents).toBe(1);
  });
});

describe("4 낡음 — 통신 쪽의 낡음과 같은 꼴", () => {
  /** 뼈대에서 모듈을 읽을 때 던지지 않게 — 사례 안에서 만든다. */
  const shown = () => after(dependenciesAction(eventOf(1)));

  it("90초까지는 낡지 않고, 넘으면 낡다", () => {
    expect(DEPENDENCY_STALE_MILLISECONDS).toBe(90_000);
    expect(isDependencyStale(shown(), "open", T + 90_000)).toBe(false);
    expect(isDependencyStale(shown(), "open", T + 90_001)).toBe(true);
  });

  it.each(["reconnecting", "reopened", "session_ended"] as const)("연결이 %s 이면 시각과 상관없이 낡다", (connection) => {
    expect(isDependencyStale(shown(), connection, T + 1_000)).toBe(true);
  });

  it("값이 없으면 낡음도 없다", () => {
    expect(isDependencyStale(initialTrafficDependencyStreamState(null), "reconnecting", T + 999_999)).toBe(false);
  });
});

describe("4 잇는 함수가 dependencies 사건을 넘긴다", () => {
  function fakeSource() {
    const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
    const source: EventSourceLike & { emit: (type: string, data?: string) => void } = {
      readyState: 1,
      addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
      close: vi.fn(),
      emit: (type, data) => { for (const listener of listeners.get(type) ?? []) listener({ data }); },
    };
    return source;
  }

  it("open → {type:open} · dependencies → {type:dependencies, data} · 지도 사건은 지도 쪽으로만 · 닫은 뒤로는 넘기지 않는다", () => {
    const source = fakeSource();
    const dispatch = vi.fn();
    const dispatchDependencies = vi.fn();
    const stop = connectTrafficMapStream({ url: "/api/traffic/stream?range=5m", createEventSource: () => source, dispatch, dispatchDependencies, scheduler: createFakeScheduler().scheduler });
    source.emit("open");
    source.emit("dependencies", "{\"sequence\":1}");
    source.emit("map", "{}");
    expect(dispatchDependencies.mock.calls).toEqual([[{ type: "open" }], [{ type: "dependencies", data: "{\"sequence\":1}" }]]);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["open", "map"]);
    stop();
    source.emit("dependencies", "{}");
    expect(dispatchDependencies).toHaveBeenCalledTimes(2);
  });
});
