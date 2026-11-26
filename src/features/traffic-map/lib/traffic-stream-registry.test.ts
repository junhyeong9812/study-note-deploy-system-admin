/** 열린 흐름의 목록(T8 리뷰 1, 순수) — 넣고 빼기 · 모두 닫기(하나가 던져도 나머지) · 닫은 뒤에 넣으면 곧바로 닫기 · 두 번 닫아도 같다. */
import { describe, expect, it, vi } from "vitest";
import { createTrafficStreamRegistry } from "@/features/traffic-map/lib/traffic-stream-registry";

describe("열린 흐름의 목록", () => {
  it("넣고 빼면 size 가 따른다 · 빼기를 두 번 불러도 한 번", () => {
    const registry = createTrafficStreamRegistry();
    const removeFirst = registry.add(vi.fn());
    registry.add(vi.fn());
    expect(registry.size()).toBe(2);
    removeFirst();
    removeFirst();
    expect(registry.size()).toBe(1);
    expect(registry.closed).toBe(false);
  });

  it("closeAll — 넣어 둔 것을 한 번씩 닫고 비운다 · 뺀 것은 닫지 않는다 · closed 가 참", () => {
    const registry = createTrafficStreamRegistry();
    const kept = vi.fn();
    const removed = vi.fn();
    registry.add(kept);
    registry.add(removed)();
    registry.closeAll();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    expect(registry.size()).toBe(0);
    expect(registry.closed).toBe(true);
    registry.closeAll();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it("닫는 함수 하나가 던져도 나머지를 닫는다", () => {
    const registry = createTrafficStreamRegistry();
    const after = vi.fn();
    registry.add(() => { throw new Error("boom"); });
    registry.add(after);
    expect(() => registry.closeAll()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("닫는 중에 스스로를 빼도(닫는 함수 안에서 빼기) 빠짐없이 닫는다", () => {
    const registry = createTrafficStreamRegistry();
    const closes: number[] = [];
    const removers: (() => void)[] = [];
    for (let index = 0; index < 3; index += 1) removers.push(registry.add(() => { closes.push(index); removers[index](); }));
    registry.closeAll();
    expect(closes).toEqual([0, 1, 2]);
  });

  it("닫은 뒤에 넣으면 곧바로 닫고 넣지 않는다", () => {
    const registry = createTrafficStreamRegistry();
    registry.closeAll();
    const late = vi.fn();
    const remove = registry.add(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
    expect(() => remove()).not.toThrow();
  });
});
