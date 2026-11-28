/** 요청 추적의 화면 모델 — (1) 시간 줄(순수): 서비스별 묶음 · 처음 나타난 차례 · 다시 나타남(구간) · 막대의 위치와 길이 · 가장 긴 틈 ·
 * 같은 밀리초의 차례(관측 서버의 정렬 열쇠 (밀리초, 순번)) · 한 줄 · 서비스 하나. (2) 관측 서버 조회: `GET /logs` 를 어떤 조건으로 몇 번 부르는가 ·
 * 상한(500줄)에 닿으면 조용히 자르지 않고 truncated · 실패는 그 이유 그대로(고정 글자) · 설정 없음은 부르지 않는다. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REQUEST_TRACE_LOOKBACK_MILLISECONDS, REQUEST_TRACE_MAXIMUM_LINES, buildRequestTimeline, buildRequestTrace, type RequestTimeline,
} from "@/features/request-trace/lib/request-trace-view";
import { TRACE_REQUEST_ID, TRACE_START_MILLISECONDS, chatScenarioLines, entryOf } from "@/features/request-trace/lib/request-trace-test-fakes";
import { createFakeObserveLogs, fakeLogLine, javaInstantText, logIdOf, type FakeLogLine } from "@/features/log-trace/lib/log-trace-test-fakes";
import { createLogClient } from "@/features/logs/lib/log-client";
import type { LogEntryView } from "@/features/logs/lib/log-query";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal, expectFailure, expectNoForbiddenText,
  hangUntilAborted, headersOf, jsonBody, leakyErrorBody, leakyNetworkError, okValue, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const DAY = 24 * 60 * 60 * 1000;
const T = TRACE_START_MILLISECONDS;

function timelineOf(lines: readonly LogEntryView[]): RequestTimeline {
  const timeline = buildRequestTimeline(lines);
  expect(timeline).not.toBeNull();
  return timeline!;
}

function chatTimeline(order: "ascending" | "observe" | "shuffled" = "ascending"): RequestTimeline {
  const entries = chatScenarioLines().map(entryOf);
  if (order === "observe") entries.reverse();   // 관측 서버는 최신순으로 준다
  if (order === "shuffled") entries.splice(0, entries.length, ...[3, 7, 0, 5, 2, 6, 1, 4].map((index) => entries[index]));
  return timelineOf(entries);
}

describe("시간 줄 — front → backend → llm → backend → front", () => {
  it("전체의 시작 · 끝 · 기간 · 줄 수", () => {
    const timeline = chatTimeline();
    expect(timeline.startAt).toBe(javaInstantText(T));
    expect(timeline.endAt).toBe(javaInstantText(T + 3600));
    expect(timeline.durationMilliseconds).toBe(3600);
    expect(timeline.lineCount).toBe(8);
  });

  it("서비스는 처음 나타난 차례(front · backend · llm) — 이름순이 아니다", () => {
    expect(chatTimeline().lanes.map((lane) => lane.service)).toEqual(["front", "backend", "llm"]);
  });

  it("거친 차례 — 다시 나타난 서비스가 뭉개지지 않는다", () => {
    expect(chatTimeline().visits).toEqual(["front", "backend", "llm", "backend", "front"]);
  });

  it("서비스마다 첫 줄 · 마지막 줄 · 줄 수 · 오류 · 경고 수", () => {
    const lanes = chatTimeline().lanes.map(({ service, firstAt, lastAt, startOffsetMilliseconds, durationMilliseconds, lineCount, errorCount, warningCount }) =>
      ({ service, firstAt, lastAt, startOffsetMilliseconds, durationMilliseconds, lineCount, errorCount, warningCount }));
    expect(lanes).toEqual([
      { service: "front", firstAt: javaInstantText(T), lastAt: javaInstantText(T + 3600), startOffsetMilliseconds: 0, durationMilliseconds: 3600,
        lineCount: 2, errorCount: 0, warningCount: 1 },
      { service: "backend", firstAt: javaInstantText(T + 120), lastAt: javaInstantText(T + 3500), startOffsetMilliseconds: 120, durationMilliseconds: 3380,
        lineCount: 4, errorCount: 1, warningCount: 2 },
      { service: "llm", firstAt: javaInstantText(T + 2700), lastAt: javaInstantText(T + 2700), startOffsetMilliseconds: 2700, durationMilliseconds: 0,
        lineCount: 2, errorCount: 0, warningCount: 0 },
    ]);
  });

  it("막대 — 전체 기간 대비 시작 위치와 길이(0~1)", () => {
    const [front, backend, llm] = chatTimeline().lanes;
    expect(front.startFraction).toBe(0);
    expect(front.lengthFraction).toBe(1);
    expect(backend.startFraction).toBeCloseTo(120 / 3600, 10);
    expect(backend.lengthFraction).toBeCloseTo(3380 / 3600, 10);
    expect(llm.startFraction).toBeCloseTo(2700 / 3600, 10);
    expect(llm.lengthFraction).toBe(0);
  });

  it("다시 나타난 서비스는 줄 안의 구간이 둘 — 사이의 빈 곳이 막대 하나로 메워지지 않는다", () => {
    const [front, backend, llm] = chatTimeline().lanes;
    expect(front.segments.map(({ firstAt, lastAt, startOffsetMilliseconds, durationMilliseconds, lineCount }) =>
      ({ firstAt, lastAt, startOffsetMilliseconds, durationMilliseconds, lineCount }))).toEqual([
      { firstAt: javaInstantText(T), lastAt: javaInstantText(T), startOffsetMilliseconds: 0, durationMilliseconds: 0, lineCount: 1 },
      { firstAt: javaInstantText(T + 3600), lastAt: javaInstantText(T + 3600), startOffsetMilliseconds: 3600, durationMilliseconds: 0, lineCount: 1 },
    ]);
    expect(backend.segments.map(({ startOffsetMilliseconds, durationMilliseconds, lineCount }) => ({ startOffsetMilliseconds, durationMilliseconds, lineCount })))
      .toEqual([
        { startOffsetMilliseconds: 120, durationMilliseconds: 180, lineCount: 3 },
        { startOffsetMilliseconds: 3500, durationMilliseconds: 0, lineCount: 1 },
      ]);
    expect(backend.segments[0].startFraction).toBeCloseTo(120 / 3600, 10);
    expect(backend.segments[0].lengthFraction).toBeCloseTo(180 / 3600, 10);
    expect(backend.segments[1].startFraction).toBeCloseTo(3500 / 3600, 10);
    expect(backend.segments[1].lengthFraction).toBe(0);
    expect(front.segments[1].startFraction).toBe(1);
    expect(llm.segments).toHaveLength(1);
    expect(llm.segments[0].lineCount).toBe(2);
  });

  it("가장 긴 틈 — 이웃한 두 줄 사이, 긴 것부터 셋(0ms 는 틈이 아니다)", () => {
    expect(chatTimeline().longestGaps).toEqual([
      { beforeService: "backend", afterService: "llm", beforeAt: javaInstantText(T + 300), afterAt: javaInstantText(T + 2700),
        startOffsetMilliseconds: 300, durationMilliseconds: 2400 },
      { beforeService: "llm", afterService: "backend", beforeAt: javaInstantText(T + 2700), afterAt: javaInstantText(T + 3500),
        startOffsetMilliseconds: 2700, durationMilliseconds: 800 },
      { beforeService: "front", afterService: "backend", beforeAt: javaInstantText(T), afterAt: javaInstantText(T + 120),
        startOffsetMilliseconds: 0, durationMilliseconds: 120 },
    ]);
  });

  it("줄은 시간순 — 전체 시작에서 몇 ms 인지와 함께, 받은 칸은 그대로", () => {
    const timeline = chatTimeline();
    expect(timeline.lines.map((line) => [line.service, line.offsetMilliseconds, line.message])).toEqual([
      ["front", 0, "POST /api/chat 받음"], ["backend", 120, "chat 시작"], ["backend", 200, "검색 느림"], ["backend", 300, "문맥 잘림"],
      ["llm", 2700, "chat queued position=1"], ["llm", 2700, "chat ok tokens~120"], ["backend", 3500, "응답 변환 실패"], ["front", 3600, "응답 500 전달"],
    ]);
    const first = chatScenarioLines().map(entryOf)[0];
    expect(timeline.lines[0]).toEqual({ ...first, offsetMilliseconds: 0 });
  });

  it.each(["observe", "shuffled"] as const)("받은 차례(%s)와 무관하게 같은 결과", (order) => {
    expect(chatTimeline(order)).toEqual(chatTimeline("ascending"));
  });
});

describe("시간 줄 — 같은 밀리초 · 한 줄 · 서비스 하나 · 틈의 동점", () => {
  it("같은 밀리초의 줄은 순번 차례(관측 서버의 정렬 열쇠) — 처음 나타난 서비스도 그 차례로 정한다", () => {
    const lines: FakeLogLine[] = [
      fakeLogLine({ milliseconds: T, sequence: 5, service: "front", level: "info", message: "다섯째" }),
      fakeLogLine({ milliseconds: T, sequence: 2, service: "backend", level: "info", message: "둘째" }),
      fakeLogLine({ milliseconds: T, sequence: 10, service: "front", level: "info", message: "열째" }),
    ];
    const timeline = timelineOf(lines.map(entryOf));
    expect(timeline.lines.map((line) => line.message)).toEqual(["둘째", "다섯째", "열째"]);
    expect(timeline.lanes.map((lane) => lane.service)).toEqual(["backend", "front"]);
    expect(timeline.visits).toEqual(["backend", "front"]);
    expect(timeline.longestGaps).toEqual([]);
  });

  it("순번은 글자가 아니라 수로 비교한다(10 은 9 뒤)", () => {
    const lines = [9, 10, 1].map((sequence) => fakeLogLine({ milliseconds: T, sequence, service: "front", message: `순번 ${sequence}` }));
    expect(timelineOf(lines.map(entryOf)).lines.map((line) => line.message)).toEqual(["순번 1", "순번 9", "순번 10"]);
  });

  it("한 줄뿐 — 첫 줄부터 마지막 줄까지의 시간은 알 수 없음(null — 0 으로 두지 않는다), 막대는 0 · 0(NaN 이 아니다), 틈 없음", () => {
    const timeline = timelineOf([entryOf(fakeLogLine({ milliseconds: T + 5, sequence: 0, service: "admin", level: "error", message: "하나" }))]);
    expect(timeline.startAt).toBe(timeline.endAt);
    expect(timeline.durationMilliseconds).toBeNull();
    expect(timeline.lineCount).toBe(1);
    expect(timeline.visits).toEqual(["admin"]);
    expect(timeline.longestGaps).toEqual([]);
    expect(timeline.lanes).toHaveLength(1);
    expect(timeline.lanes[0]).toMatchObject({ service: "admin", lineCount: 1, errorCount: 1, warningCount: 0, durationMilliseconds: 0, startFraction: 0, lengthFraction: 0 });
    expect(timeline.lanes[0].segments).toHaveLength(1);
    expect(timeline.lanes[0].segments[0]).toMatchObject({ startFraction: 0, lengthFraction: 0, lineCount: 1 });
    expect(timeline.lines[0].offsetMilliseconds).toBe(0);
  });

  it("두 줄이 같은 밀리초 — 첫 줄부터 마지막 줄까지 0ms(줄이 둘이면 잴 수 있다 — 알 수 없음이 아니다)", () => {
    const lines = [0, 1].map((sequence) => fakeLogLine({ milliseconds: T, sequence, service: "front", level: "info", message: `순번 ${sequence}` }));
    const timeline = timelineOf(lines.map(entryOf));
    expect(timeline.lineCount).toBe(2);
    expect(timeline.durationMilliseconds).toBe(0);
  });

  it("서비스 하나뿐 — 줄 하나 · 구간 하나 · 막대 전체", () => {
    const lines = [0, 400, 1000].map((offset, index) => fakeLogLine({ milliseconds: T + offset, sequence: index, service: "backend", level: "info", message: `줄 ${index}` }));
    const timeline = timelineOf(lines.map(entryOf));
    expect(timeline.visits).toEqual(["backend"]);
    expect(timeline.lanes).toHaveLength(1);
    expect(timeline.lanes[0]).toMatchObject({ lineCount: 3, startFraction: 0, lengthFraction: 1, durationMilliseconds: 1000 });
    expect(timeline.lanes[0].segments).toHaveLength(1);
    expect(timeline.longestGaps.map((gap) => [gap.beforeService, gap.afterService, gap.durationMilliseconds])).toEqual([["backend", "backend", 600], ["backend", "backend", 400]]);
  });

  it("틈의 길이가 같으면 이른 것부터, 셋까지만", () => {
    const services = ["front", "backend", "front", "backend", "front"];
    const lines = services.map((service, index) => fakeLogLine({ milliseconds: T + index * 500, sequence: 0, service, level: "info", message: `줄 ${index}` }));
    const gaps = timelineOf(lines.map(entryOf)).longestGaps;
    expect(gaps.map((gap) => [gap.beforeService, gap.afterService, gap.startOffsetMilliseconds, gap.durationMilliseconds])).toEqual([
      ["front", "backend", 0, 500], ["backend", "front", 500, 500], ["front", "backend", 1000, 500],
    ]);
  });

  it("줄이 없으면 null", () => {
    expect(buildRequestTimeline([])).toBeNull();
  });
});

/** 관측 서버 조회 — 가짜 관측 서버(실제 규칙 흉내) 위의 실제 로그 클라이언트. */
const NOW = Date.UTC(2026, 10, 25, 4, 0, 0, 0);   // 밀리초 0 — 보낸 시각 글자(.000Z)와 응답의 글자(Java Instant, 소수 없음)가 다르다

function clientOver(handler: RoutedFetchHandler, timeoutSignal?: (milliseconds: number) => AbortSignal) {
  const fetch = createRoutedFetch(handler);
  return { fetch, client: createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch, timeoutSignal }) };
}

/** 그 요청 ID 의 줄 count 개(1초 간격 — 가장 이른 줄의 글은 "줄 0") + 다른 요청 · 요청 ID 없는 줄. */
function manyLines(count: number): FakeLogLine[] {
  const lines: FakeLogLine[] = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(fakeLogLine({ milliseconds: T + index * 1000, sequence: 0, service: index % 2 === 0 ? "front" : "backend", level: "info", requestId: TRACE_REQUEST_ID, message: `줄 ${index}` }));
  }
  lines.push(fakeLogLine({ milliseconds: T + 10, sequence: 0, requestId: "req-other", service: "backend", message: "다른 요청" }));
  lines.push(fakeLogLine({ milliseconds: T + 20, sequence: 0, requestId: "", service: "observe", message: "요청 ID 없음" }));
  return lines;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("서비스 이름의 짝짓기(T7 — 규약 2.1 · 7.1: 로그 이름 ci-agent-<서버> 를 ci-agent 로 읽는다)", () => {
  const line = (offset: number, sequence: number, service: string, level = "info") =>
    entryOf(fakeLogLine({ milliseconds: T + offset, sequence, service, level, message: `${service} ${offset}` }));

  it("두 서버의 에이전트 로그는 한 줄(ci-agent) — 처음 나타난 차례 · 줄 수 · 오류 수 · 첫 줄과 마지막 줄이 합쳐지고, 원래 이름은 logServices(이름순)", () => {
    const timeline = timelineOf([
      line(0, 0, "ci-master"), line(100, 0, "ci-agent-9", "error"), line(300, 0, "ci-agent-158"), line(500, 0, "ci-master"), line(700, 0, "ci-agent-158", "warning"),
    ]);
    expect(timeline.lanes.map((lane) => [lane.service, lane.logServices, lane.lineCount, lane.errorCount, lane.warningCount])).toEqual([
      ["ci-master", ["ci-master"], 2, 0, 0], ["ci-agent", ["ci-agent-158", "ci-agent-9"], 3, 1, 1],
    ]);
    const agent = timeline.lanes[1];
    expect(agent).toMatchObject({ firstAt: javaInstantText(T + 100), lastAt: javaInstantText(T + 700), startOffsetMilliseconds: 100, durationMilliseconds: 600 });
  });

  it("이웃한 두 에이전트의 줄은 한 구간 · 거친 차례도 하나 — 다른 서비스가 끼면 끊긴다", () => {
    const timeline = timelineOf([line(0, 0, "ci-master"), line(100, 0, "ci-agent-9"), line(300, 0, "ci-agent-158"), line(500, 0, "ci-master"), line(700, 0, "ci-agent-158")]);
    expect(timeline.visits).toEqual(["ci-master", "ci-agent", "ci-master", "ci-agent"]);
    expect(timeline.lanes[1].segments.map((segment) => [segment.startOffsetMilliseconds, segment.durationMilliseconds, segment.lineCount])).toEqual([[100, 200, 2], [700, 0, 1]]);
    expect(timeline.longestGaps.map((gap) => [gap.beforeService, gap.afterService, gap.durationMilliseconds])).toEqual([
      ["ci-agent", "ci-agent", 200], ["ci-agent", "ci-master", 200], ["ci-master", "ci-agent", 200],
    ]);
  });

  it("줄 하나하나는 원래 로그 이름 그대로(로그 표 · 로그 화면 링크가 그 이름을 쓴다)", () => {
    const timeline = timelineOf([line(0, 0, "ci-agent-9"), line(10, 0, "ci-agent-158")]);
    expect(timeline.lines.map((entry) => entry.service)).toEqual(["ci-agent-9", "ci-agent-158"]);
  });

  it("llm 과 llm-wrapper 는 합치지 않는다 · 짝짓지 않는 이름은 logServices 가 자기 이름 하나", () => {
    const timeline = timelineOf([line(0, 0, "llm"), line(10, 0, "llm-wrapper"), line(20, 0, "front")]);
    expect(timeline.lanes.map((lane) => [lane.service, lane.logServices])).toEqual([["llm", ["llm"]], ["llm-wrapper", ["llm-wrapper"]], ["front", ["front"]]]);
  });
});

describe("관측 서버 조회 — 부르는 조건", () => {
  it("한 번 — GET /logs?request_id&from=지금−30일&to=지금&limit=500, 그 밖의 조건 없음 · 비밀값 머리글", async () => {
    const fake = createFakeObserveLogs([...chatScenarioLines(), ...manyLines(0)]);
    const { fetch, client } = clientOver(fake.handler);
    const trace = okValue(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW));
    expect(fake.calls).toEqual([{
      request_id: TRACE_REQUEST_ID, from: new Date(NOW - REQUEST_TRACE_LOOKBACK_MILLISECONDS).toISOString(), to: new Date(NOW).toISOString(),
      limit: String(REQUEST_TRACE_MAXIMUM_LINES),
    }]);
    expect(REQUEST_TRACE_LOOKBACK_MILLISECONDS).toBe(30 * DAY);
    expect(REQUEST_TRACE_MAXIMUM_LINES).toBe(500);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe("/logs");
    expect(headersOf(init).get("X-Observe-Secret")).toBe(FAKE_OBSERVE_SECRET);
    expect(init?.method).toBe("GET");
    expect(init?.cache).toBe("no-store");
    expect(trace.truncated).toBe(false);
    expect(trace.from).toBe(javaInstantText(NOW - 30 * DAY));
    expect(trace.to).toBe(javaInstantText(NOW));
    expect(trace.timeline?.visits).toEqual(["front", "backend", "llm", "backend", "front"]);
    expect(trace.timeline?.lineCount).toBe(8);
    expect(trace.timeline?.lines.every((line) => line.requestId === TRACE_REQUEST_ID)).toBe(true);
    expectNoForbiddenText(trace);   // 관측 서버의 계약 밖 칸(extra)은 들어오지 않는다
    expect(JSON.stringify(trace)).not.toContain(UPSTREAM_RAW_MARKER);
  });

  it("그 요청 ID 의 줄이 없음 → 성공 · timeline null · 한 번만 부른다", async () => {
    const fake = createFakeObserveLogs(manyLines(0));
    const { client } = clientOver(fake.handler);
    const trace = okValue(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW));
    expect(trace).toEqual({ from: javaInstantText(NOW - 30 * DAY), to: javaInstantText(NOW), truncated: false, timeline: null });
    expect(fake.calls).toHaveLength(1);
  });

  it("정확히 500줄 → 확인 1회(before = next_before, from · to = 응답의 글자, limit 1) → 잘리지 않음", async () => {
    const lines = manyLines(500);
    const fake = createFakeObserveLogs(lines);
    const { client } = clientOver(fake.handler);
    const trace = okValue(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW));
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]).toEqual({
      request_id: TRACE_REQUEST_ID, before: logIdOf(lines[0]), from: javaInstantText(NOW - 30 * DAY), to: javaInstantText(NOW), limit: "1",
    });
    expect(trace.truncated).toBe(false);
    expect(trace.timeline?.lineCount).toBe(500);
    expect(trace.timeline?.lines[0].message).toBe("줄 0");
  });

  it("501줄 → truncated · 보이는 것은 최근 500줄(가장 이른 줄이 빠진다 — 조용히 자르지 않는다)", async () => {
    const fake = createFakeObserveLogs(manyLines(501));
    const { client } = clientOver(fake.handler);
    const trace = okValue(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW));
    expect(trace.truncated).toBe(true);
    expect(trace.timeline?.lineCount).toBe(500);
    expect(trace.timeline?.lines[0].message).toBe("줄 1");
    expect(trace.timeline?.lines[499].message).toBe("줄 500");
    expect(fake.calls).toHaveLength(2);
  });

  it("확인 호출이 실패하면 전체가 그 실패(잘리지 않았다고 두지 않는다)", async () => {
    const fake = createFakeObserveLogs(manyLines(500));
    let count = 0;
    const { client } = clientOver((url, init) => (++count === 2 ? textResponse(leakyErrorBody(), 503) : fake.handler(url, init)));
    expectFailure(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW), "unavailable", 503);
  });

  it("관측 서버 설정 없음(null) → not_configured, 부르지 않는다", async () => {
    expectFailure(await buildRequestTrace(null, { requestId: TRACE_REQUEST_ID }, NOW), "not_configured");
  });
});

describe("관측 서버 조회 — 실패는 그 이유(고정 글자 · 원문 없음)", () => {
  it.each([
    ["503", () => textResponse(leakyErrorBody(), 503), "unavailable", 503],
    ["504", () => textResponse(leakyErrorBody(), 504), "server_timeout", 504],
    ["500", () => textResponse(leakyErrorBody(), 500), "bad_status", 500],
    ["401", () => jsonBody({ success: false, error: { code: "unauthorized" } }, 401), "unauthorized", 401],
    ["깨진 본문", () => textResponse(`{${leakyErrorBody()}`), "unparseable", undefined],
    ["칸이 빠진 줄", () => jsonBody({ success: true, data: { logs: [{ id: "1-0", at: "2026-11-22T10:00:00Z" }], next_before: "", from: "2026-10-26T04:00:00Z", to: "2026-11-25T04:00:00Z" } }), "unparseable", undefined],
  ] as const)("%s", async (_label, respond, reason, status) => {
    const { client } = clientOver(() => respond());
    expectFailure(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW), reason, status);
  });

  it("닿지 않음 → unreachable", async () => {
    const { client } = clientOver(() => Promise.reject(leakyNetworkError()));
    expectFailure(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW), "unreachable");
  });

  it("시간 초과(5초) → timeout", async () => {
    vi.useFakeTimers();
    const timer = createTimerTimeoutSignal();
    const { client } = clientOver((_url, init) => hangUntilAborted(init), timer.factory);
    const pending = buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW);
    pending.catch(() => undefined);   // 시계를 돌리는 동안 거부가 처리되지 않은 채 남지 않게(아래 await 가 그대로 받는다)
    await vi.advanceTimersByTimeAsync(5_000);
    expectFailure(await pending, "timeout");
    expect(timer.requestedMilliseconds).toEqual([5_000]);
  });

  it.each([
    ["글자", "x"],
    ["순번 없음", "12-"],
    ["빈 글자", ""],
  ])("로그 id 가 `밀리초-순번` 꼴이 아닌 줄(%s %j)이 하나라도 있으면 읽을 수 없는 줄 — unparseable(차례를 정할 수 없다 · 나머지 줄로 시간 줄을 만들지 않는다)", async (_label, badId) => {
    const goodLine = fakeLogLine({ milliseconds: T, sequence: 0, service: "front", level: "info", requestId: TRACE_REQUEST_ID, message: "읽히는 줄" });
    const { client } = clientOver(() => jsonBody({ success: true, data: {
      logs: [
        { id: badId, at: javaInstantText(T + 100), level: "info", service: "backend", request_id: TRACE_REQUEST_ID, message: "id 가 틀린 줄" },
        { id: logIdOf(goodLine), at: javaInstantText(T), level: "info", service: "front", request_id: TRACE_REQUEST_ID, message: "읽히는 줄" },
      ],
      next_before: "", from: "2026-10-26T04:00:00Z", to: "2026-11-25T04:00:00Z",
    } }));
    expectFailure(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW), "unparseable");
  });

  it("줄의 시각이 읽히지 않으면 unparseable(시간 차를 잴 수 없다 — 0 으로 숨기지 않는다)", async () => {
    const { client } = clientOver(() => jsonBody({ success: true, data: {
      logs: [{ id: "1-0", at: "2026-13-40T00:00:00Z", level: "info", service: "front", request_id: TRACE_REQUEST_ID, message: "x" }],
      next_before: "", from: "2026-10-26T04:00:00Z", to: "2026-11-25T04:00:00Z",
    } }));
    expectFailure(await buildRequestTrace(client, { requestId: TRACE_REQUEST_ID }, NOW), "unparseable");
  });
});
