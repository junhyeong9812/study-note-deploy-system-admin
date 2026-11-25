/** 요청 추적이 이미 있는 규칙을 다시 적지 않고 함께 쓴다 — (1) 요청 ID 의 꼴 = 로그 조회의 LOG_REQUEST_ID_PATTERN(같은 객체),
 * (2) 잘림 확인 = 로그 추적의 hasLinesBefore(요청 추적의 truncated 와 확인 실패가 그 함수의 결과에서 나온다).
 * 둘 다 동작으로 본다 — 공용 규칙을 바꿔 끼우면 요청 추적의 결과가 따라 바뀌어야 한다(자기 사본이면 바뀌지 않는다). */
import { afterEach, describe, expect, it, vi } from "vitest";

const sharedTruncation = vi.hoisted(() => ({ override: null as null | ((...args: unknown[]) => unknown), calls: 0 }));

vi.mock("@/features/log-trace/lib/log-trace-view", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/features/log-trace/lib/log-trace-view")>();
  return {
    ...original,
    hasLinesBefore: (...args: Parameters<typeof original.hasLinesBefore>) => {
      sharedTruncation.calls += 1;
      return sharedTruncation.override === null ? original.hasLinesBefore(...args) : sharedTruncation.override(...args);
    },
  };
});

import { hasLinesBefore } from "@/features/log-trace/lib/log-trace-view";
import { createFakeObserveLogs, fakeLogLine } from "@/features/log-trace/lib/log-trace-test-fakes";
import { createLogClient } from "@/features/logs/lib/log-client";
import { LOG_REQUEST_ID_PATTERN } from "@/features/logs/lib/log-query";
import { parseRequestTraceQuery } from "@/features/request-trace/lib/request-trace-query";
import { TRACE_REQUEST_ID, TRACE_START_MILLISECONDS } from "@/features/request-trace/lib/request-trace-test-fakes";
import { buildRequestTrace } from "@/features/request-trace/lib/request-trace-view";
import { FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, createRoutedFetch, expectFailure, okValue } from "@/shared/lib/upstream-test-fakes";
import { upstreamFailure } from "@/shared/lib/upstream-result";

const NOW = Date.UTC(2026, 10, 25, 4, 0, 0, 0);

afterEach(() => {
  sharedTruncation.override = null;
  sharedTruncation.calls = 0;
  vi.restoreAllMocks();
});

function clientOverLines(count: number) {
  const lines = Array.from({ length: count }, (_, index) => fakeLogLine({
    milliseconds: TRACE_START_MILLISECONDS + index * 1000, sequence: 0, service: "front", level: "info", requestId: TRACE_REQUEST_ID, message: `줄 ${index}`,
  }));
  const fake = createFakeObserveLogs(lines);
  return { fake, client: createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch: createRoutedFetch(fake.handler) }) };
}

describe("요청 ID 의 꼴 — 로그 조회의 LOG_REQUEST_ID_PATTERN 을 가져와 쓴다", () => {
  it("로그 조회가 꼴을 내보낸다(관측 서버의 넓은 꼴 그대로)", () => {
    expect(LOG_REQUEST_ID_PATTERN).toBeInstanceOf(RegExp);
    expect(LOG_REQUEST_ID_PATTERN.source).toBe("^[A-Za-z0-9_.-]{1,80}$");
    expect(LOG_REQUEST_ID_PATTERN.flags).toBe("");
  });

  it("요청 추적의 입력 검증은 그 객체로 판정한다 — 그 객체의 판정을 바꾸면 요청 추적의 결과가 따라 바뀐다", () => {
    const sharedTest = vi.spyOn(LOG_REQUEST_ID_PATTERN, "test").mockReturnValue(false);
    expect(parseRequestTraceQuery({ request_id: TRACE_REQUEST_ID })).toMatchObject({ ok: false, reason: "invalid_input", field: "request_id" });
    expect(sharedTest).toHaveBeenCalledWith(TRACE_REQUEST_ID);
    sharedTest.mockReturnValue(true);
    expect(parseRequestTraceQuery({ request_id: "req:1" })).toEqual({ ok: true, query: { requestId: "req:1" } });
  });
});

describe("잘림 확인 — 로그 추적의 hasLinesBefore 를 가져와 쓴다", () => {
  it("로그 추적이 hasLinesBefore 를 내보낸다(가로채기 전의 실제 모듈에서)", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@/features/log-trace/lib/log-trace-view");
    expect(typeof actual.hasLinesBefore).toBe("function");
    expect(hasLinesBefore).not.toBe(actual.hasLinesBefore);   // 이 파일의 가로채기가 걸려 있다(아래 사례의 전제)
  });

  it("꽉 찬 응답(500줄)의 truncated 는 그 함수의 결과다 — 그 함수가 '더 있음'이라 하면 truncated", async () => {
    sharedTruncation.override = async () => ({ ok: true, value: true });
    const { client } = clientOverLines(500);
    const trace = okValue(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW));
    expect(sharedTruncation.calls).toBeGreaterThanOrEqual(1);
    expect(trace.truncated).toBe(true);
    expect(trace.timeline?.lineCount).toBe(500);
  });

  it("그 함수가 '더 없음'이라 하면 truncated 가 아니다(실제 관측 서버에 줄이 더 있어도)", async () => {
    sharedTruncation.override = async () => ({ ok: true, value: false });
    const { client } = clientOverLines(501);
    const trace = okValue(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW));
    expect(sharedTruncation.calls).toBeGreaterThanOrEqual(1);
    expect(trace.truncated).toBe(false);
  });

  it("그 함수가 실패를 돌려주면 전체가 그 실패(잘리지 않았다고 두지 않는다)", async () => {
    sharedTruncation.override = async () => upstreamFailure("server_timeout", { status: 504 });
    const { client } = clientOverLines(500);
    expectFailure(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW), "server_timeout", 504);
    expect(sharedTruncation.calls).toBeGreaterThanOrEqual(1);
  });
});
