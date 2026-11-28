/** 연관 로그 조립 — 명세 §11.2(오른쪽 상세 네 구역 · 요청 ID 가 없는 로그 · 불변식) · ② "한 곳이 죽어도 나머지는 보인다" · "각각 5초" · 읽기 전용.
 * 실제 클라이언트(createLogClient · createDeployHistoryClient · createIncidentClient)를 가짜 서버 위에서 돌린다 — 가짜 관측 서버는
 * `GET /logs` 의 거름 규칙(양끝 포함 · 최신순 · before 엄격 · limit · next_before)을 실제 소스대로 흉내 낸다(log-trace-test-fakes). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import { createIncidentClient } from "@/features/log-trace/lib/incident-client";
import type { LogTraceQuery } from "@/features/log-trace/lib/log-trace-query";
import {
  HOUR, MINUTE, SELECTED_LOG_ID, SELECTED_MILLISECONDS, SELECTED_REQUEST_ID, alertCalls, alertHandlerFor, alertIncident, createFakeObserveLogs,
  createTraceFetch, fakeLogLine, isoMilliseconds, javaInstantText, logEntryView, logIdOf, masterCalls, masterDeployment, masterHandlerFor,
  observeCalls, type FakeLogLine, type TraceFetch, type TraceHandlers,
} from "@/features/log-trace/lib/log-trace-test-fakes";
import {
  CHANGE_WINDOW_MILLISECONDS, DEPLOYMENT_LOOKUP_LIMIT, INCIDENT_LOOKUP_LIMIT, LEVEL_COUNT_LIMIT, LEVEL_COUNT_WINDOW_MILLISECONDS,
  RELATED_LOG_MAXIMUM_LINES, RELATED_LOG_WINDOW_MILLISECONDS, SERVICE_LOG_WINDOW_MILLISECONDS,
  buildLogTrace, logLevelSeverity, summarizeRequest, type LogTraceDependencies, type LogTraceOutcome, type LogTraceView,
} from "@/features/log-trace/lib/log-trace-view";
import { createLogClient } from "@/features/logs/lib/log-client";
import type { LogEntryView } from "@/features/logs/lib/log-query";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, UPSTREAM_RAW_MARKER,
  createTimerTimeoutSignal, expectFailure, expectNoForbiddenText, expectReadOnlyRequest, hangUntilAborted, headersOf, jsonBody, leakyErrorBody,
  okValue, respondAfter, textResponse, track, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const T = SELECTED_MILLISECONDS;
const SECOND = 1000;
const QUERY: LogTraceQuery = { selectedLogId: SELECTED_LOG_ID, selectedAtMilliseconds: T };
const OBSERVE_MAX_LIMIT = 500;   // observe LogController.kt:147
const MASTER_MAX_LIMIT = 200;    // ci-cd master.go:342
const ALERT_MAX_LIMIT = 200;     // alert AlertController.kt:101

const SELECTED_LINE = fakeLogLine();
/** 같은 요청의 다른 줄들(시각이 섞여 있다) */
const REQUEST_LINES: FakeLogLine[] = [
  fakeLogLine({ milliseconds: T - 2_000, sequence: 0, level: "info", service: "front", message: "GET /api/notes 요청 받음" }),
  fakeLogLine({ milliseconds: T - 1_500, sequence: 1, level: "debug", service: "backend", message: "노트 조회 시작" }),
  SELECTED_LINE,
  fakeLogLine({ milliseconds: T + 700, sequence: 0, level: "warning", service: "front", message: "응답 500 전달" }),
  fakeLogLine({ milliseconds: T + 900, sequence: 4, level: "info", service: "llm", message: "후처리 생략" }),
];
/** 다른 요청 · 요청 ID 없는 줄(연관 로그에 들지 않는다) */
const NOISE_LINES: FakeLogLine[] = [
  fakeLogLine({ milliseconds: T - 1_000, sequence: 0, requestId: "req-other", service: "backend", level: "error", message: "다른 요청" }),
  fakeLogLine({ milliseconds: T + 100, sequence: 0, requestId: "", service: "observe", level: "info", message: "수집 한 바퀴" }),
];

function dependencies(fetch: TraceFetch, timeoutSignal?: (milliseconds: number) => AbortSignal): LogTraceDependencies {
  return {
    logs: createLogClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch, timeoutSignal }),
    deployHistory: createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch, timeoutSignal }),
    incidents: createIncidentClient({ baseUrl: FAKE_ALERT_URL, secret: FAKE_ALERT_SECRET, fetch, timeoutSignal }),
  };
}

interface World {
  lines?: FakeLogLine[];
  deployments?: Record<string, unknown>[];
  incidents?: Record<string, unknown>[];
  /** 관측 서버 처리기를 감싼다(특정 호출만 실패시키기) */
  observe?: (fallback: RoutedFetchHandler) => RoutedFetchHandler;
  master?: RoutedFetchHandler;
  alert?: RoutedFetchHandler;
}

function setUp(world: World = {}) {
  const observeStore = createFakeObserveLogs(world.lines ?? [...REQUEST_LINES, ...NOISE_LINES]);
  const handlers: TraceHandlers = {
    observe: world.observe ? world.observe(observeStore.handler) : observeStore.handler,
    master: world.master ?? masterHandlerFor(world.deployments ?? [masterDeployment()]),
    alert: world.alert ?? alertHandlerFor(world.incidents ?? [alertIncident()]),
  };
  const fetch = createTraceFetch(handlers);
  return { fetch, observeStore };
}

async function run(world: World = {}, query: LogTraceQuery = QUERY) {
  const { fetch, observeStore } = setUp(world);
  const outcome = await buildLogTrace(dependencies(fetch), query);
  return { outcome, fetch, observeStore };
}

function viewOf(outcome: LogTraceOutcome): LogTraceView {
  expect(outcome.kind, JSON.stringify(outcome)).toBe("view");
  if (outcome.kind !== "view") throw new Error("expected view");
  return outcome.view;
}

/** 관측 서버에 보낸 조건 중 고른 로그 확인(from = to = T) */
function locateCalls(calls: Record<string, string>[]) {
  return calls.filter((parameters) => parameters.from === isoMilliseconds(T) && parameters.to === isoMilliseconds(T));
}

function levelCalls(calls: Record<string, string>[], level: string) {
  return calls.filter((parameters) => parameters.level === level);
}

/** 연관 로그 호출(고른 로그 확인 · 수준별 줄 수를 뺀 나머지) */
function relatedCalls(calls: Record<string, string>[]) {
  return calls.filter((parameters) => parameters.level === undefined && !(parameters.from === isoMilliseconds(T) && parameters.to === isoMilliseconds(T)));
}

function requestLines(count: number): FakeLogLine[] {
  // 고른 줄(가장 새것) + 그보다 1초씩 이른 count-1 줄 — 모두 ±1시간 안
  return [SELECTED_LINE, ...Array.from({ length: count - 1 }, (_, index) =>
    fakeLogLine({ milliseconds: T - (index + 1) * SECOND, sequence: 0, level: "info", message: `줄 ${index + 1}` }))];
}

describe("상수 — 명세 §11.2 의 창 · 상한과 다른 서버의 상한", () => {
  it("±1시간 · ±30초 · ±5분 · ±30분 · 500줄", () => {
    expect(RELATED_LOG_WINDOW_MILLISECONDS).toBe(HOUR);
    expect(SERVICE_LOG_WINDOW_MILLISECONDS).toBe(30 * SECOND);
    expect(LEVEL_COUNT_WINDOW_MILLISECONDS).toBe(5 * MINUTE);
    expect(CHANGE_WINDOW_MILLISECONDS).toBe(30 * MINUTE);
    expect(RELATED_LOG_MAXIMUM_LINES).toBe(500);
  });

  it("호출 건수는 각 서버의 상한 이하", () => {
    expect(RELATED_LOG_MAXIMUM_LINES).toBeLessThanOrEqual(OBSERVE_MAX_LIMIT);
    expect(LEVEL_COUNT_LIMIT).toBeLessThanOrEqual(OBSERVE_MAX_LIMIT);
    expect(DEPLOYMENT_LOOKUP_LIMIT).toBeLessThanOrEqual(MASTER_MAX_LIMIT);
    expect(INCIDENT_LOOKUP_LIMIT).toBeLessThanOrEqual(ALERT_MAX_LIMIT);
  });
});

describe("logLevelSeverity — error > warning > info > debug, 그 밖은 가장 낮다", () => {
  it("순서", () => {
    expect(logLevelSeverity("error")).toBeGreaterThan(logLevelSeverity("warning"));
    expect(logLevelSeverity("warning")).toBeGreaterThan(logLevelSeverity("info"));
    expect(logLevelSeverity("info")).toBeGreaterThan(logLevelSeverity("debug"));
  });

  it.each(["fatal", "WARNING", "Error", "", "warn"])("%j 는 debug 보다 낮다", (level) => {
    expect(logLevelSeverity(level)).toBeLessThan(logLevelSeverity("debug"));
  });
});

describe("summarizeRequest — 시간순 줄의 요약", () => {
  const lines: LogEntryView[] = REQUEST_LINES.map(logEntryView) as LogEntryView[];

  it("서비스 처음 등장 순(중복 없음) · 처음/마지막 시각 · 걸린 시간 · 줄 수 · 가장 높은 수준 · 첫 줄 메시지", () => {
    expect(summarizeRequest(lines, false)).toEqual({
      services: ["front", "backend", "llm"],
      firstAt: javaInstantText(T - 2_000), lastAt: javaInstantText(T + 900), durationMilliseconds: 2_900,
      lineCount: 5, hasMore: false, highestLevel: "error", firstMessage: "GET /api/notes 요청 받음",
    });
  });

  it("한 줄뿐이면 걸린 시간 0 · 그 줄의 서비스 · 수준 · 메시지", () => {
    expect(summarizeRequest([lines[0]], true)).toEqual({
      services: ["front"], firstAt: javaInstantText(T - 2_000), lastAt: javaInstantText(T - 2_000), durationMilliseconds: 0,
      lineCount: 1, hasMore: true, highestLevel: "info", firstMessage: "GET /api/notes 요청 받음",
    });
  });

  it.each([
    [["debug", "info"], "info"], [["info", "warning", "debug"], "warning"], [["warning", "error", "info"], "error"], [["debug"], "debug"],
  ] as const)("수준 %j → %s", (levels, highest) => {
    const mixed = levels.map((level, index) => ({ ...lines[0], id: `${T + index}-0`, at: javaInstantText(T + index), level })) as LogEntryView[];
    expect(summarizeRequest(mixed, false)?.highestLevel).toBe(highest);
  });

  it("줄이 없으면 null", () => {
    expect(summarizeRequest([], false)).toBeNull();
  });
});

describe("고른 로그 확인 — 관측 서버에서 그 줄을 다시 찾는다(주소의 값을 믿지 않는다)", () => {
  it("from = to = T(밀리초 3자리) · before = 바로 다음 커서 · limit 1 — 그 밖의 조건 없음, 한 번만", async () => {
    const { observeStore } = await run();
    expect(locateCalls(observeStore.calls)).toEqual([
      { from: isoMilliseconds(T), to: isoMilliseconds(T), before: `${T}-3`, limit: "1" },
    ]);
  });

  it("찾은 줄의 칸 그대로(계약 밖 칸 없음)", async () => {
    const view = viewOf((await run()).outcome);
    expect(view.query).toEqual(QUERY);
    expect(okValue(view.selected)).toStrictEqual(logEntryView(SELECTED_LINE));
  });

  it("그 id 의 줄이 없으면 not_found — 연관 로그를 부르지 않는다", async () => {
    const { outcome, observeStore } = await run({ lines: NOISE_LINES });
    expect(outcome).toEqual({ kind: "not_found" });
    expect(relatedCalls(observeStore.calls)).toHaveLength(0);
  });

  it("같은 밀리초의 앞 순번 줄만 있으면(관측 서버가 그 줄을 준다) id 가 달라 not_found", async () => {
    const neighbor = fakeLogLine({ sequence: 1, message: "앞 순번" });
    const { outcome } = await run({ lines: [neighbor] });
    expect(outcome).toEqual({ kind: "not_found" });
  });

  it("관측 서버가 이상한 id 의 줄을 줘도(필터를 어긴 응답) 글자가 다르면 not_found", async () => {
    const { outcome } = await run({
      observe: (fallback) => (url, init) => (url.searchParams.get("limit") === "1"
        ? jsonBody({ success: true, data: { logs: [{ ...logEntryRow(fakeLogLine({ sequence: 9 })) }], next_before: "", from: javaInstantText(T), to: javaInstantText(T) } })
        : fallback(url, init)),
    });
    expect(outcome).toEqual({ kind: "not_found" });
  });

  it("관측 서버가 실패하면 1~3 구역은 그 이유 · 4 구역의 배포 · 알림은 T 로 조회한 값", async () => {
    const { outcome, fetch } = await run({ observe: () => () => textResponse(leakyErrorBody(), 503) });
    const view = viewOf(outcome);
    expectFailure(view.selected, "unavailable", 503);
    expectFailure(view.relatedLogs, "unavailable", 503);
    expect(view.requestSummary).not.toBeNull();
    expectFailure(view.requestSummary!, "unavailable", 503);
    expectFailure(view.serverState.levelCounts, "unavailable", 503);
    expect(okValue(view.serverState.deployments).deployments).toHaveLength(1);
    expect(okValue(view.serverState.incidents).incidents).toHaveLength(1);
    expect(okValue(view.serverState.deployments).from).toBe(isoMilliseconds(T - 30 * MINUTE));
    expect(masterCalls(fetch)).toHaveLength(1);
    expect(alertCalls(fetch)).toHaveLength(1);
    expectNoForbiddenText(view);
  });
});

function logEntryRow(line: FakeLogLine) {
  return { id: logIdOf(line), at: javaInstantText(line.milliseconds), level: line.level, service: line.service, request_id: line.requestId, message: line.message };
}

describe("연관 로그 — 같은 요청 ID, ±1시간, 시간순, 고른 줄 표시, 앞줄과의 시간 차", () => {
  it("조건: request_id · from = T−1시간 · to = T+1시간 · limit 500 (그 밖 없음)", async () => {
    const { observeStore } = await run();
    expect(relatedCalls(observeStore.calls)).toEqual([
      { request_id: SELECTED_REQUEST_ID, from: isoMilliseconds(T - HOUR), to: isoMilliseconds(T + HOUR), limit: "500" },
    ]);
  });

  it("옛것부터 · 다른 요청의 줄 없음 · 고른 줄만 selected · 첫 줄의 시간 차 null", async () => {
    const view = viewOf((await run()).outcome);
    expect(okValue(view.relatedLogs)).toStrictEqual({
      scope: "request", from: isoMilliseconds(T - HOUR), to: isoMilliseconds(T + HOUR), hasMore: false, hasOlder: false, hasNewer: false,
      lines: [
        { ...logEntryView(REQUEST_LINES[0]), selected: false, gapMilliseconds: null },
        { ...logEntryView(REQUEST_LINES[1]), selected: false, gapMilliseconds: 500 },
        { ...logEntryView(SELECTED_LINE), selected: true, gapMilliseconds: 1_500 },
        { ...logEntryView(REQUEST_LINES[3]), selected: false, gapMilliseconds: 700 },
        { ...logEntryView(REQUEST_LINES[4]), selected: false, gapMilliseconds: 200 },
      ],
    });
  });

  it("같은 밀리초의 줄은 순번 순 · 시간 차 0", async () => {
    const sameMillisecond = fakeLogLine({ sequence: 5, level: "info", message: "같은 밀리초 뒤 순번" });
    const view = viewOf((await run({ lines: [sameMillisecond, SELECTED_LINE] })).outcome);
    const lines = okValue(view.relatedLogs).lines;
    expect(lines.map((line) => line.id)).toEqual([SELECTED_LOG_ID, logIdOf(sameMillisecond)]);
    expect(lines[1].gapMilliseconds).toBe(0);
  });

  it("요청 요약은 연관 로그로", async () => {
    const view = viewOf((await run()).outcome);
    expect(okValue(view.requestSummary!)).toEqual({
      services: ["front", "backend", "llm"], firstAt: javaInstantText(T - 2_000), lastAt: javaInstantText(T + 900), durationMilliseconds: 2_900,
      lineCount: 5, hasMore: false, highestLevel: "error", firstMessage: "GET /api/notes 요청 받음",
    });
  });

  it("연관 로그가 고른 줄 하나뿐", async () => {
    const view = viewOf((await run({ lines: [SELECTED_LINE, ...NOISE_LINES] })).outcome);
    expect(okValue(view.relatedLogs).lines).toStrictEqual([{ ...logEntryView(SELECTED_LINE), selected: true, gapMilliseconds: null }]);
    expect(okValue(view.requestSummary!)).toMatchObject({ services: ["backend"], durationMilliseconds: 0, lineCount: 1, highestLevel: "error", firstMessage: "boom" });
  });

  it("시간 창 경계: T−1시간 · T+1시간 정각은 들고 1ms 밖은 빠진다", async () => {
    const atStart = fakeLogLine({ milliseconds: T - HOUR, sequence: 0, level: "info", message: "창 시작" });
    const beforeStart = fakeLogLine({ milliseconds: T - HOUR - 1, sequence: 0, level: "info", message: "창 밖 앞" });
    const atEnd = fakeLogLine({ milliseconds: T + HOUR, sequence: 0, level: "info", message: "창 끝" });
    const afterEnd = fakeLogLine({ milliseconds: T + HOUR + 1, sequence: 0, level: "info", message: "창 밖 뒤" });
    const view = viewOf((await run({ lines: [beforeStart, atStart, SELECTED_LINE, atEnd, afterEnd] })).outcome);
    expect(okValue(view.relatedLogs).lines.map((line) => line.message)).toEqual(["창 시작", "boom", "창 끝"]);
  });

  it("499줄 — 연관 로그 호출 1회 · hasMore false", async () => {
    const { outcome, observeStore } = await run({ lines: requestLines(499) });
    const related = okValue(viewOf(outcome).relatedLogs);
    expect(related.lines).toHaveLength(499);
    expect(related.hasMore).toBe(false);
    expect(relatedCalls(observeStore.calls)).toHaveLength(1);
  });

  it("정확히 500줄 — 확인 1회(0줄) · hasMore false · 500줄 전부", async () => {
    const { outcome, observeStore } = await run({ lines: requestLines(500) });
    const view = viewOf(outcome);
    const related = okValue(view.relatedLogs);
    expect(related.lines).toHaveLength(500);
    expect(related.hasMore).toBe(false);
    expect(related.lines[0].message).toBe("줄 499");
    expect(related.lines[499].selected).toBe(true);
    const calls = relatedCalls(observeStore.calls);
    expect(calls).toHaveLength(2);
    const probe = calls[1];
    expect(probe).toEqual({
      request_id: SELECTED_REQUEST_ID, before: `${T - 499 * SECOND}-0`,
      from: javaInstantText(T - HOUR), to: javaInstantText(T + HOUR), limit: "1",
    });
    expect(okValue(view.requestSummary!)).toMatchObject({ lineCount: 500, hasMore: false });
  });

  it("501줄 — 확인 1회(1줄) · hasMore true · 최신 500줄을 시간순으로(가장 오래된 1줄이 빠진다)", async () => {
    const { outcome, observeStore } = await run({ lines: requestLines(501) });
    const view = viewOf(outcome);
    const related = okValue(view.relatedLogs);
    expect(related.lines).toHaveLength(500);
    expect(related.hasMore).toBe(true);
    expect(related.lines[0].message).toBe("줄 499");
    expect(related.lines.some((line) => line.message === "줄 500")).toBe(false);
    expect(related.lines[0].gapMilliseconds).toBeNull();
    expect(relatedCalls(observeStore.calls)).toHaveLength(2);
    expect(okValue(view.requestSummary!)).toMatchObject({ lineCount: 500, hasMore: true, firstMessage: "줄 499" });
  });

  it("확인 호출이 실패하면 연관 로그 · 요약은 그 실패(조용히 hasMore false 로 두지 않는다) · 고른 로그는 그대로", async () => {
    const { outcome } = await run({
      lines: requestLines(500),
      observe: (fallback) => (url, init) => (url.searchParams.get("request_id") !== null && url.searchParams.get("before") !== null
        ? textResponse(leakyErrorBody(), 504)
        : fallback(url, init)),
    });
    const view = viewOf(outcome);
    expect(view.selected.ok).toBe(true);
    expectFailure(view.relatedLogs, "server_timeout", 504);
    expectFailure(view.requestSummary!, "server_timeout", 504);
    expect(view.serverState.levelCounts.ok).toBe(true);
  });

  it("연관 로그 호출이 실패하면 그 구역 둘만 실패 · 나머지는 값", async () => {
    const { outcome } = await run({
      observe: (fallback) => (url, init) => (url.searchParams.get("request_id") !== null ? textResponse(leakyErrorBody(), 500) : fallback(url, init)),
    });
    const view = viewOf(outcome);
    expect(okValue(view.selected)).toStrictEqual(logEntryView(SELECTED_LINE));
    expectFailure(view.relatedLogs, "bad_status", 500);
    expectFailure(view.requestSummary!, "bad_status", 500);
    expect(view.serverState.levelCounts.ok).toBe(true);
    expect(view.serverState.deployments.ok).toBe(true);
    expect(view.serverState.incidents.ok).toBe(true);
  });

  it("연관 로그가 0줄(그 사이 지워짐)이면 연관 로그 · 요약은 not_found", async () => {
    const { outcome } = await run({
      observe: (fallback) => (url, init) => (url.searchParams.get("request_id") !== null
        ? jsonBody({ success: true, data: { logs: [], next_before: "", from: javaInstantText(T - HOUR), to: javaInstantText(T + HOUR) } })
        : fallback(url, init)),
    });
    const view = viewOf(outcome);
    expectFailure(view.relatedLogs, "not_found");
    expectFailure(view.requestSummary!, "not_found");
  });

  it("연관 로그 줄의 at 이 시각으로 읽히지 않으면 연관 로그 · 요약은 unparseable", async () => {
    const { outcome } = await run({
      observe: (fallback) => (url, init) => (url.searchParams.get("request_id") !== null
        ? jsonBody({ success: true, data: { logs: [{ ...logEntryRow(SELECTED_LINE), at: `not-a-time ${UPSTREAM_RAW_MARKER}` }], next_before: "", from: "x", to: "y" } })
        : fallback(url, init)),
    });
    const view = viewOf(outcome);
    expectFailure(view.relatedLogs, "unparseable");
    expectFailure(view.requestSummary!, "unparseable");
  });
});

describe("요청 ID 가 없는 로그 — 요약 없음, 같은 서비스의 ±30초", () => {
  const selectedWithoutRequest = fakeLogLine({ requestId: "", service: "observe", level: "warning", message: "수집 지연" });
  const sameService: FakeLogLine[] = [
    fakeLogLine({ milliseconds: T - 30 * SECOND, sequence: 0, requestId: "", service: "observe", level: "info", message: "창 시작" }),
    fakeLogLine({ milliseconds: T - 30 * SECOND - 1, sequence: 0, requestId: "", service: "observe", level: "info", message: "창 밖 앞" }),
    fakeLogLine({ milliseconds: T + 10 * SECOND, sequence: 0, requestId: "req-x", service: "observe", level: "info", message: "요청 ID 있는 같은 서비스 줄" }),
    fakeLogLine({ milliseconds: T + 30 * SECOND, sequence: 0, requestId: "", service: "observe", level: "info", message: "창 끝" }),
    fakeLogLine({ milliseconds: T + 30 * SECOND + 1, sequence: 0, requestId: "", service: "observe", level: "info", message: "창 밖 뒤" }),
    fakeLogLine({ milliseconds: T + 1 * SECOND, sequence: 0, requestId: "", service: "backend", level: "info", message: "다른 서비스" }),
  ];

  it("조건: service · from = T−30초 · to = T+30초 · limit 500 (request_id 없음)", async () => {
    const { observeStore } = await run({ lines: [selectedWithoutRequest, ...sameService] });
    expect(relatedCalls(observeStore.calls)).toEqual([
      { service: "observe", from: isoMilliseconds(T - 30 * SECOND), to: isoMilliseconds(T + 30 * SECOND), limit: "500" },
    ]);
  });

  it("requestSummary null · scope service · 경계 정각은 들고 1ms 밖 · 다른 서비스는 빠진다 · 고른 줄 표시", async () => {
    const view = viewOf((await run({ lines: [selectedWithoutRequest, ...sameService] })).outcome);
    expect(view.requestSummary).toBeNull();
    const related = okValue(view.relatedLogs);
    expect(related.scope).toBe("service");
    expect(related.from).toBe(isoMilliseconds(T - 30 * SECOND));
    expect(related.to).toBe(isoMilliseconds(T + 30 * SECOND));
    expect(related.lines.map((line) => line.message)).toEqual(["창 시작", "수집 지연", "요청 ID 있는 같은 서비스 줄", "창 끝"]);
    expect(related.lines.map((line) => line.selected)).toEqual([false, true, false, false]);
    expect(related.lines.map((line) => line.gapMilliseconds)).toEqual([null, 30 * SECOND, 10 * SECOND, 20 * SECOND]);
    expect(related.hasMore).toBe(false);
  });

  it("4 구역은 그대로", async () => {
    const view = viewOf((await run({ lines: [selectedWithoutRequest, ...sameService] })).outcome);
    expect(view.serverState.levelCounts.ok).toBe(true);
    expect(view.serverState.deployments.ok).toBe(true);
    expect(view.serverState.incidents.ok).toBe(true);
  });
});

describe("그때 서버 상태 ① — ±5분 서비스별 warning · error 줄 수", () => {
  const countLines: FakeLogLine[] = [
    SELECTED_LINE,
    fakeLogLine({ milliseconds: T - 5 * MINUTE, sequence: 0, service: "front", level: "warning", requestId: "" }),
    fakeLogLine({ milliseconds: T - 5 * MINUTE - 1, sequence: 0, service: "front", level: "error", requestId: "" }),
    fakeLogLine({ milliseconds: T + 5 * MINUTE, sequence: 0, service: "llm", level: "error", requestId: "" }),
    fakeLogLine({ milliseconds: T + 5 * MINUTE + 1, sequence: 0, service: "llm", level: "warning", requestId: "" }),
    fakeLogLine({ milliseconds: T + 1, sequence: 0, service: "backend", level: "warning", requestId: "r2" }),
    fakeLogLine({ milliseconds: T + 2, sequence: 0, service: "backend", level: "info", requestId: "r2" }),
    fakeLogLine({ milliseconds: T + 3, sequence: 0, service: "alert", level: "debug", requestId: "" }),
  ];

  it("수준마다 한 번: level · from = T−5분 · to = T+5분 · limit 500", async () => {
    const { observeStore } = await run({ lines: countLines });
    for (const level of ["warning", "error"]) {
      expect(levelCalls(observeStore.calls, level)).toEqual([
        { level, from: isoMilliseconds(T - 5 * MINUTE), to: isoMilliseconds(T + 5 * MINUTE), limit: "500" },
      ]);
    }
    expect(levelCalls(observeStore.calls, "info")).toHaveLength(0);
  });

  it("서비스 이름 오름차순 · 경계 정각은 들고 1ms 밖은 빠진다 · info · debug 는 세지 않는다 · 상한에 닿지 않음", async () => {
    const view = viewOf((await run({ lines: countLines })).outcome);
    expect(okValue(view.serverState.levelCounts)).toStrictEqual({
      from: isoMilliseconds(T - 5 * MINUTE), to: isoMilliseconds(T + 5 * MINUTE),
      services: [
        { service: "backend", warning: 1, error: 1 },
        { service: "front", warning: 1, error: 0 },
        { service: "llm", warning: 0, error: 1 },
      ],
      warningAtLimit: false, errorAtLimit: false,
    });
  });

  it("warning 이 500줄을 채우면 warningAtLimit(500건 이상) · error 는 그대로", async () => {
    const warnings = Array.from({ length: 600 }, (_, index) =>
      fakeLogLine({ milliseconds: T - index * 100, sequence: 7, service: "front", level: "warning", requestId: "" }));
    const view = viewOf((await run({ lines: [SELECTED_LINE, ...warnings] })).outcome);
    const counts = okValue(view.serverState.levelCounts);
    expect(counts.warningAtLimit).toBe(true);
    expect(counts.errorAtLimit).toBe(false);
    expect(counts.services).toEqual([{ service: "backend", warning: 0, error: 1 }, { service: "front", warning: 500, error: 0 }]);
  });

  it("줄이 하나도 없으면 services []", async () => {
    const quiet = fakeLogLine({ level: "info" });
    const view = viewOf((await run({ lines: [quiet] })).outcome);
    expect(okValue(view.serverState.levelCounts).services).toEqual([]);
  });

  it.each(["warning", "error"])("%s 호출만 실패해도 이 칸은 그 실패 · 나머지 구역은 값", async (failingLevel) => {
    const { outcome } = await run({
      observe: (fallback) => (url, init) => (url.searchParams.get("level") === failingLevel ? textResponse(leakyErrorBody(), 503) : fallback(url, init)),
    });
    const view = viewOf(outcome);
    expectFailure(view.serverState.levelCounts, "unavailable", 503);
    expect(view.selected.ok).toBe(true);
    expect(view.relatedLogs.ok).toBe(true);
    expect(view.serverState.deployments.ok).toBe(true);
    expect(view.serverState.incidents.ok).toBe(true);
  });
});

describe("그때 서버 상태 ② — ±30분 안에 접수됐거나 끝난 배포", () => {
  const at = (milliseconds: number) => javaInstantText(milliseconds);
  const rows = [
    masterDeployment({ request_id: "after-window", accepted_at: at(T + 30 * MINUTE + 1), finished_at: at(T + 35 * MINUTE) }),
    masterDeployment({ request_id: "accepted-at-end", accepted_at: at(T + 30 * MINUTE), finished_at: "" , state: "ci_running" }),
    masterDeployment({ request_id: "inside", accepted_at: at(T - 10 * MINUTE), finished_at: at(T - 8 * MINUTE), service: "front" }),
    masterDeployment({ request_id: "finished-at-start", accepted_at: at(T - 40 * MINUTE), finished_at: at(T - 30 * MINUTE), state: "failed", failed_stage: "ci_test" }),
    masterDeployment({ request_id: "finished-just-before", accepted_at: at(T - 40 * MINUTE), finished_at: at(T - 30 * MINUTE - 1) }),
    masterDeployment({ request_id: "running-from-before", accepted_at: at(T - 50 * MINUTE) }),
  ];
  delete rows[5].finished_at;

  it("master: GET /deploys?limit=200 (service 없음) · X-Deploy-Secret · 한 번", async () => {
    const { fetch } = await run({ deployments: rows });
    const calls = masterCalls(fetch);
    expect(calls).toHaveLength(1);
    const [input, init] = calls[0];
    expect(new URL(input).pathname).toBe("/deploys");
    expect(Object.fromEntries(new URL(input).searchParams)).toEqual({ limit: "200" });
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("X-Deploy-Secret")).toBe(FAKE_DEPLOY_SECRET);
    expect(headersOf(init).has("X-Observe-Secret")).toBe(false);
    expect(init?.redirect).toBe("manual");
  });

  it("접수 또는 종료가 창(양끝 포함) 안인 것만 · master 순서 그대로 · DeploymentSummary 칸만", async () => {
    const view = viewOf((await run({ deployments: rows })).outcome);
    const around = okValue(view.serverState.deployments);
    expect(around.from).toBe(isoMilliseconds(T - 30 * MINUTE));
    expect(around.to).toBe(isoMilliseconds(T + 30 * MINUTE));
    expect(around.deployments.map((deployment) => deployment.requestId)).toEqual(["accepted-at-end", "inside", "finished-at-start"]);
    expect(around.deployments[1]).toStrictEqual({
      requestId: "inside", state: "succeeded", service: "front", commitSha: "a".repeat(40), failedStage: null,
      acceptedAt: at(T - 10 * MINUTE), finishedAt: at(T - 8 * MINUTE), integrationMilliseconds: 60000, deliveryMilliseconds: 30000, requestedBy: null,   // 누가(⑫ 12-6 — master 의 requested_by, 없으면 null)
    });
    expect(around.coversWindow).toBe(true);
    expectNoForbiddenText(around);
  });

  it("200건을 채웠고 가장 오래된 접수가 창 시작 이후면 coversWindow false(이력이 창 앞쪽에 닿지 못함)", async () => {
    const full = Array.from({ length: 200 }, (_, index) => masterDeployment({
      request_id: `deploy-${index}`, accepted_at: at(T + 29 * MINUTE - index * SECOND), finished_at: at(T + 29 * MINUTE - index * SECOND + 500),
    }));
    const around = okValue(viewOf((await run({ deployments: full })).outcome).serverState.deployments);
    expect(around.deployments).toHaveLength(200);
    expect(around.coversWindow).toBe(false);
  });

  it("200건을 채웠어도 가장 오래된 접수가 창 시작보다 이르면 coversWindow true", async () => {
    const full = Array.from({ length: 200 }, (_, index) => masterDeployment({
      request_id: `deploy-${index}`, accepted_at: at(T - index * MINUTE), finished_at: at(T - index * MINUTE + 500),
    }));
    expect(okValue(viewOf((await run({ deployments: full })).outcome).serverState.deployments).coversWindow).toBe(true);
  });

  it("빈 이력 → deployments [] · coversWindow true", async () => {
    expect(okValue(viewOf((await run({ deployments: [] })).outcome).serverState.deployments)).toEqual({
      from: isoMilliseconds(T - 30 * MINUTE), to: isoMilliseconds(T + 30 * MINUTE), deployments: [], coversWindow: true,
    });
  });

  it.each([["accepted_at", { accepted_at: "어제" }], ["finished_at", { finished_at: "2026-11-22 10:00" }]])(
    "%s 가 시각으로 읽히지 않으면 unparseable(조용히 빼지 않는다)", async (_label, overrides) => {
      const view = viewOf((await run({ deployments: [masterDeployment(), masterDeployment(overrides)] })).outcome);
      expectFailure(view.serverState.deployments, "unparseable");
    });

  it("master 가 실패해도 배포 칸만 실패 · 나머지는 값", async () => {
    const { outcome } = await run({ master: () => textResponse(leakyErrorBody(), 401) });
    const view = viewOf(outcome);
    expectFailure(view.serverState.deployments, "unauthorized", 401);
    expect(view.selected.ok).toBe(true);
    expect(view.relatedLogs.ok).toBe(true);
    expect(view.requestSummary!.ok).toBe(true);
    expect(view.serverState.levelCounts.ok).toBe(true);
    expect(view.serverState.incidents.ok).toBe(true);
    expectNoForbiddenText(view);
  });
});

describe("그때 서버 상태 ③ — ±30분 안의 알림 기록", () => {
  const at = (milliseconds: number) => `${new Date(milliseconds).toISOString().slice(0, -1)}456Z`;   // 마이크로초 6자리(Java Instant)
  const rows = [
    alertIncident({ key: "after", at: javaInstantText(T + 30 * MINUTE + 1) }),
    alertIncident({ key: "at-end", at: javaInstantText(T + 30 * MINUTE) }),
    alertIncident({ key: "inside", at: at(T - 1 * MINUTE), kind: "event", title: "로그인 잠금", delivered_by: "", suppressed: true }),
    alertIncident({ key: "at-start", at: javaInstantText(T - 30 * MINUTE) }),
    alertIncident({ key: "before", at: javaInstantText(T - 30 * MINUTE - 1) }),
  ];

  it("알림 서버: GET /incidents?limit=200 · X-Alert-Secret · 한 번", async () => {
    const { fetch } = await run({ incidents: rows });
    const calls = alertCalls(fetch);
    expect(calls).toHaveLength(1);
    const [input, init] = calls[0];
    expect(new URL(input).pathname).toBe("/incidents");
    expect(Object.fromEntries(new URL(input).searchParams)).toEqual({ limit: "200" });
    expect(headersOf(init).get("X-Alert-Secret")).toBe(FAKE_ALERT_SECRET);
    expectReadOnlyRequest(init);
  });

  it("at 이 창(양끝 포함) 안인 것만 · 알림 서버 순서 그대로 · 필요한 칸만", async () => {
    const around = okValue(viewOf((await run({ incidents: rows })).outcome).serverState.incidents);
    expect(around.from).toBe(isoMilliseconds(T - 30 * MINUTE));
    expect(around.to).toBe(isoMilliseconds(T + 30 * MINUTE));
    expect(around.incidents.map((incident) => incident.key)).toEqual(["at-end", "inside", "at-start"]);
    expect(around.incidents[1]).toStrictEqual({ at: at(T - 1 * MINUTE), kind: "event", key: "inside", title: "로그인 잠금", deliveredBy: null, suppressed: true });
    expect(around.coversWindow).toBe(true);
    expectNoForbiddenText(around);
    expect(JSON.stringify(around)).not.toContain("connection refused");
  });

  it("200건을 채웠고 가장 이른 at 이 창 시작 이후면 coversWindow false", async () => {
    const full = Array.from({ length: 200 }, (_, index) => alertIncident({ key: `k${index}`, at: javaInstantText(T + 20 * MINUTE - index * SECOND) }));
    const around = okValue(viewOf((await run({ incidents: full })).outcome).serverState.incidents);
    expect(around.incidents).toHaveLength(200);
    expect(around.coversWindow).toBe(false);
  });

  it("200건을 채웠어도 가장 이른 at 이 창 시작보다 이르면 coversWindow true", async () => {
    const full = Array.from({ length: 200 }, (_, index) => alertIncident({ key: `k${index}`, at: javaInstantText(T - index * MINUTE) }));
    expect(okValue(viewOf((await run({ incidents: full })).outcome).serverState.incidents).coversWindow).toBe(true);
  });

  it("알림 서버가 실패해도 알림 칸만 실패 · 나머지는 값", async () => {
    const { outcome } = await run({ alert: () => jsonBody({ success: false, error: { code: "history_unavailable" } }, 503) });
    const view = viewOf(outcome);
    expectFailure(view.serverState.incidents, "unavailable", 503);
    expect(view.selected.ok).toBe(true);
    expect(view.relatedLogs.ok).toBe(true);
    expect(view.serverState.levelCounts.ok).toBe(true);
    expect(view.serverState.deployments.ok).toBe(true);
  });
});

describe("설정 없음 — 클라이언트가 null 이면 그 출처의 칸은 not_configured, 호출 없음", () => {
  it("관측 서버 없음 → 1~3 구역 · 줄 수 칸 not_configured(404 가 아니다) · 배포 · 알림은 값", async () => {
    const { fetch } = setUp();
    const outcome = await buildLogTrace({ ...dependencies(fetch), logs: null }, QUERY);
    const view = viewOf(outcome);
    expectFailure(view.selected, "not_configured");
    expectFailure(view.relatedLogs, "not_configured");
    expectFailure(view.requestSummary!, "not_configured");
    expectFailure(view.serverState.levelCounts, "not_configured");
    expect(view.serverState.deployments.ok).toBe(true);
    expect(view.serverState.incidents.ok).toBe(true);
    expect(observeCalls(fetch)).toHaveLength(0);
  });

  it("master 없음 → 배포 칸만 not_configured", async () => {
    const { fetch } = setUp();
    const view = viewOf(await buildLogTrace({ ...dependencies(fetch), deployHistory: null }, QUERY));
    expectFailure(view.serverState.deployments, "not_configured");
    expect(view.serverState.incidents.ok).toBe(true);
    expect(masterCalls(fetch)).toHaveLength(0);
  });

  it("알림 서버 없음 → 알림 칸만 not_configured", async () => {
    const { fetch } = setUp();
    const view = viewOf(await buildLogTrace({ ...dependencies(fetch), incidents: null }, QUERY));
    expectFailure(view.serverState.incidents, "not_configured");
    expect(view.serverState.deployments.ok).toBe(true);
    expect(alertCalls(fetch)).toHaveLength(0);
  });
});

describe("메시지는 글자 그대로 · 응답은 필요한 칸만 · 읽기 전용", () => {
  const scriptMessage = `<script>alert("x")</script>\n두 번째 줄 & <b>굵게</b> \u0000 끝`;

  it("<script> 가 든 메시지가 고른 로그 · 연관 로그 · 요약에서 변형 없이", async () => {
    const line = fakeLogLine({ milliseconds: T - 1_000, sequence: 0, level: "info", message: scriptMessage });
    const selected = fakeLogLine({ message: scriptMessage });
    const view = viewOf((await run({ lines: [line, selected] })).outcome);
    expect(okValue(view.selected).message).toBe(scriptMessage);
    expect(okValue(view.relatedLogs).lines.map((entry) => entry.message)).toEqual([scriptMessage, scriptMessage]);
    expect(okValue(view.requestSummary!).firstMessage).toBe(scriptMessage);
  });

  it("다른 서버 응답의 계약 밖 칸 · 원문 · 비밀값 · 주소가 결과에 없다", async () => {
    const { outcome } = await run();
    expectNoForbiddenText(outcome);
  });

  it("모든 호출이 GET · 본문 없음 · redirect manual · 출처마다 제 비밀 헤더만", async () => {
    const { fetch } = await run();
    for (const [input, init] of fetch.mock.calls) {
      expectReadOnlyRequest(init);
      expect(init?.redirect).toBe("manual");
      const headers = headersOf(init);
      const origin = new URL(input).origin;
      expect(headers.has("X-Observe-Secret")).toBe(origin === new URL(FAKE_OBSERVE_URL).origin);
      expect(headers.has("X-Deploy-Secret")).toBe(origin === new URL(FAKE_DEPLOY_MASTER_URL).origin);
      expect(headers.has("X-Alert-Secret")).toBe(origin === new URL(FAKE_ALERT_URL).origin);
    }
  });

  it("정상 사례의 호출 수: 관측 4(확인 · warning · error · 연관) · master 1 · 알림 1", async () => {
    const { fetch } = await run();
    expect(observeCalls(fetch)).toHaveLength(4);
    expect(masterCalls(fetch)).toHaveLength(1);
    expect(alertCalls(fetch)).toHaveLength(1);
  });
});

describe("병렬 · 호출마다 5초 · 재시도 없음(가짜 타이머)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** 모든 호출이 delay 뒤에 정상 응답 */
  function delayed(delay: number, override?: (url: URL, init: RequestInit) => Promise<Response> | null) {
    const observeStore = createFakeObserveLogs([...REQUEST_LINES, ...NOISE_LINES]);
    const master = masterHandlerFor([masterDeployment()]);
    const alert = alertHandlerFor([alertIncident()]);
    const later = (handler: RoutedFetchHandler): RoutedFetchHandler => (url, init) =>
      override?.(url, init) ?? respondAfter(delay, () => handler(url, init) as Response, init);
    return createTraceFetch({ observe: later(observeStore.handler), master: later(master), alert: later(alert) });
  }

  it("1단계 다섯 호출(관측 3 · master 1 · 알림 1)을 기다리지 않고 한꺼번에 시작한다", async () => {
    const fetch = delayed(4_000);
    const timeout = createTimerTimeoutSignal();
    const pending = track(buildLogTrace(dependencies(fetch, timeout.factory), QUERY));
    await vi.advanceTimersByTimeAsync(0);
    expect(observeCalls(fetch)).toHaveLength(3);
    expect(masterCalls(fetch)).toHaveLength(1);
    expect(alertCalls(fetch)).toHaveLength(1);
    expect(pending.settled).toBe(false);
  });

  it("각 4초 — 1단계 4초 + 연관 로그 4초 = 8초에 끝난다(직렬이면 24초)", async () => {
    const fetch = delayed(4_000);
    const timeout = createTimerTimeoutSignal();
    const pending = track(buildLogTrace(dependencies(fetch, timeout.factory), QUERY));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expect(pending.error).toBeUndefined();
    const view = viewOf(pending.value!);
    expect(view.relatedLogs.ok).toBe(true);
    expect(view.serverState.deployments.ok).toBe(true);
  });

  it("호출마다 5000ms 신호를 따로 만든다", async () => {
    const fetch = delayed(0);
    const timeout = createTimerTimeoutSignal();
    const pending = track(buildLogTrace(dependencies(fetch, timeout.factory), QUERY));
    await vi.advanceTimersByTimeAsync(100);
    expect(pending.settled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(timeout.requestedMilliseconds).toEqual(Array(6).fill(5_000));
    expect(new Set(fetch.mock.calls.map(([, init]) => init?.signal)).size).toBe(6);
  });

  it("모두 멈추면 5초에 끝나고 모든 칸 timeout · 연관 로그는 부르지 않는다 · 재시도 없음(호출 5회)", async () => {
    const fetch = delayed(0, (_url, init) => hangUntilAborted(init));
    const timeout = createTimerTimeoutSignal();
    const pending = track(buildLogTrace(dependencies(fetch, timeout.factory), QUERY));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expect(pending.error).toBeUndefined();
    const view = viewOf(pending.value!);
    expectFailure(view.selected, "timeout");
    expectFailure(view.relatedLogs, "timeout");
    expectFailure(view.requestSummary!, "timeout");
    expectFailure(view.serverState.levelCounts, "timeout");
    expectFailure(view.serverState.deployments, "timeout");
    expectFailure(view.serverState.incidents, "timeout");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("연관 로그 호출만 멈추면 그 뒤 5초에 연관 · 요약만 timeout, 나머지는 값 · 재시도 없음(관측 4회)", async () => {
    const fetch = delayed(0, (url, init) => (url.searchParams.get("request_id") !== null ? hangUntilAborted(init) : null));
    const timeout = createTimerTimeoutSignal();
    const pending = track(buildLogTrace(dependencies(fetch, timeout.factory), QUERY));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    const view = viewOf(pending.value!);
    expectFailure(view.relatedLogs, "timeout");
    expectFailure(view.requestSummary!, "timeout");
    expect(view.selected.ok).toBe(true);
    expect(view.serverState.levelCounts.ok).toBe(true);
    expect(view.serverState.deployments.ok).toBe(true);
    expect(view.serverState.incidents.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(observeCalls(fetch)).toHaveLength(4);
  });

  it.each(["master", "alert"] as const)("%s 만 멈추면 5초에 그 칸만 timeout, 나머지는 값 · 호출 1회", async (stuck) => {
    const stuckOrigin = new URL(stuck === "master" ? FAKE_DEPLOY_MASTER_URL : FAKE_ALERT_URL).origin;
    const fetch = delayed(100, (url, init) => (url.origin === stuckOrigin ? hangUntilAborted(init) : null));
    const timeout = createTimerTimeoutSignal();
    const pending = track(buildLogTrace(dependencies(fetch, timeout.factory), QUERY));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    const view = viewOf(pending.value!);
    expectFailure(stuck === "master" ? view.serverState.deployments : view.serverState.incidents, "timeout");
    expect((stuck === "master" ? view.serverState.incidents : view.serverState.deployments).ok).toBe(true);
    expect(view.relatedLogs.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callsOf(fetch, stuckOrigin)).toHaveLength(1);
  });
});

function callsOf(fetch: TraceFetch, origin: string) {
  return fetch.mock.calls.filter(([input]) => new URL(input).origin === origin);
}

/** 고른 줄(T) + 그보다 늦은 newerCount 줄 + 이른 olderCount 줄 — 간격 step, 모두 창 안이어야 한다. */
function linesAroundSelected(selected: FakeLogLine, newerCount: number, olderCount: number, step: number, overrides: Partial<FakeLogLine> = {}): FakeLogLine[] {
  const newer = Array.from({ length: newerCount }, (_, index) =>
    fakeLogLine({ milliseconds: T + (index + 1) * step, sequence: 0, level: "info", message: `뒤 줄 ${index + 1}`, ...overrides }));
  const older = Array.from({ length: olderCount }, (_, index) =>
    fakeLogLine({ milliseconds: T - (index + 1) * step, sequence: 0, level: "info", message: `앞 줄 ${index + 1}`, ...overrides }));
  return [...newer, selected, ...older];
}

describe("고른 줄은 반드시 목록에 있다 — 최신 500줄 밖이면 고른 줄에서 끝나는 500줄(명세 §11.2 세부 11-23 · R4-1b)", () => {
  it("가짜 관측 서버의 before 는 계약대로 '그 id 보다 앞선 줄'만(엄격) · 최신순 · 뒤쪽 조건은 없다", async () => {
    const store = createFakeObserveLogs(linesAroundSelected(SELECTED_LINE, 3, 3, SECOND));
    const response = store.handler(new URL(`${FAKE_OBSERVE_URL}/logs?request_id=${SELECTED_REQUEST_ID}&from=${isoMilliseconds(T - HOUR)}&to=${isoMilliseconds(T + HOUR)}&before=${SELECTED_LOG_ID}&limit=500`),
      { headers: { "X-Observe-Secret": FAKE_OBSERVE_SECRET } }) as Response;
    const body = await response.json() as { data: { logs: { id: string }[] } };
    expect(body.data.logs.map((row) => row.id)).toEqual([`${T - SECOND}-0`, `${T - 2 * SECOND}-0`, `${T - 3 * SECOND}-0`]);
    const inclusive = store.handler(new URL(`${FAKE_OBSERVE_URL}/logs?request_id=${SELECTED_REQUEST_ID}&from=${isoMilliseconds(T - HOUR)}&to=${isoMilliseconds(T + HOUR)}&before=${T}-3&limit=500`),
      { headers: { "X-Observe-Secret": FAKE_OBSERVE_SECRET } }) as Response;
    const inclusiveBody = await inclusive.json() as { data: { logs: { id: string }[] } };
    expect(inclusiveBody.data.logs[0].id).toBe(SELECTED_LOG_ID);
  });

  it("정상(잘리지 않음) — hasOlder false · hasNewer false · hasMore false", async () => {
    const related = okValue(viewOf((await run()).outcome).relatedLogs);
    expect(related.hasMore).toBe(false);
    expect(related.hasOlder).toBe(false);
    expect(related.hasNewer).toBe(false);
  });

  it("501줄(고른 줄이 가장 새것) — hasOlder true · hasNewer false · 추가 호출 없음(연관 2회)", async () => {
    const { outcome, observeStore } = await run({ lines: requestLines(501) });
    const related = okValue(viewOf(outcome).relatedLogs);
    expect(related.hasMore).toBe(true);
    expect(related.hasOlder).toBe(true);
    expect(related.hasNewer).toBe(false);
    expect(relatedCalls(observeStore.calls)).toHaveLength(2);
  });

  it("뒤 100줄 · 앞 500줄(고른 줄이 최신 500줄 안) — 지금 규칙 그대로: 첫 응답 + 확인 1회, hasOlder true · hasNewer false", async () => {
    const { outcome, observeStore } = await run({ lines: linesAroundSelected(SELECTED_LINE, 100, 500, SECOND) });
    const related = okValue(viewOf(outcome).relatedLogs);
    expect(related.lines).toHaveLength(500);
    expect(related.lines.filter((line) => line.selected).map((line) => line.id)).toEqual([SELECTED_LOG_ID]);
    expect(related.lines[related.lines.length - 1].message).toBe("뒤 줄 100");
    expect(related.hasOlder).toBe(true);
    expect(related.hasNewer).toBe(false);
    expect(related.hasMore).toBe(true);
    const calls = relatedCalls(observeStore.calls);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ before: `${T - 399 * SECOND}-0`, limit: "1" });
  });

  it("뒤 600줄 · 앞 600줄 — 첫 응답 → 고른 줄에서 끝나는 500줄(before = 바로 다음 커서, 첫 응답의 from · to) → 확인 1회(그 응답의 nextBefore)", async () => {
    const { observeStore } = await run({ lines: linesAroundSelected(SELECTED_LINE, 600, 600, SECOND) });
    expect(relatedCalls(observeStore.calls)).toEqual([
      { request_id: SELECTED_REQUEST_ID, from: isoMilliseconds(T - HOUR), to: isoMilliseconds(T + HOUR), limit: "500" },
      { request_id: SELECTED_REQUEST_ID, before: `${T}-3`, from: javaInstantText(T - HOUR), to: javaInstantText(T + HOUR), limit: "500" },
      { request_id: SELECTED_REQUEST_ID, before: `${T - 499 * SECOND}-0`, from: javaInstantText(T - HOUR), to: javaInstantText(T + HOUR), limit: "1" },
    ]);
  });

  it("뒤 600줄 · 앞 600줄 — 고른 줄 + 앞선 499줄을 시간순으로 · 고른 줄이 마지막 · hasNewer true · hasOlder true", async () => {
    const view = viewOf((await run({ lines: linesAroundSelected(SELECTED_LINE, 600, 600, SECOND) })).outcome);
    const related = okValue(view.relatedLogs);
    expect(related.scope).toBe("request");
    expect(related.from).toBe(isoMilliseconds(T - HOUR));
    expect(related.to).toBe(isoMilliseconds(T + HOUR));
    expect(related.lines).toHaveLength(500);
    expect(related.lines[0]).toStrictEqual({ ...logEntryView(fakeLogLine({ milliseconds: T - 499 * SECOND, sequence: 0, level: "info", message: "앞 줄 499" })), selected: false, gapMilliseconds: null });
    expect(related.lines[499]).toStrictEqual({ ...logEntryView(SELECTED_LINE), selected: true, gapMilliseconds: SECOND });
    expect(related.lines.filter((line) => line.selected)).toHaveLength(1);
    expect(related.lines.some((line) => line.message.startsWith("뒤 줄"))).toBe(false);
    expect(related.hasNewer).toBe(true);
    expect(related.hasOlder).toBe(true);
    expect(related.hasMore).toBe(true);
    expect(okValue(view.requestSummary!)).toEqual({
      services: ["backend"], firstAt: javaInstantText(T - 499 * SECOND), lastAt: javaInstantText(T), durationMilliseconds: 499 * SECOND,
      lineCount: 500, hasMore: true, highestLevel: "error", firstMessage: "앞 줄 499",
    });
  });

  it("뒤 500줄 · 앞 499줄 — 다시 받은 500줄이 꽉 찼으니 확인 1회(0줄) → hasOlder false · hasNewer true", async () => {
    const { outcome, observeStore } = await run({ lines: linesAroundSelected(SELECTED_LINE, 500, 499, SECOND) });
    const related = okValue(viewOf(outcome).relatedLogs);
    expect(related.lines).toHaveLength(500);
    expect(related.lines[0].message).toBe("앞 줄 499");
    expect(related.lines[499].selected).toBe(true);
    expect(related.hasOlder).toBe(false);
    expect(related.hasNewer).toBe(true);
    expect(related.hasMore).toBe(true);
    expect(relatedCalls(observeStore.calls)).toHaveLength(3);
  });

  it("뒤 500줄 · 앞 0줄(고른 줄이 가장 오래됨) — 다시 받은 응답은 고른 줄 하나, 꽉 차지 않았으니 확인 없음(연관 2회) · hasOlder false · hasNewer true", async () => {
    const { outcome, observeStore } = await run({ lines: linesAroundSelected(SELECTED_LINE, 500, 0, SECOND) });
    const view = viewOf(outcome);
    const related = okValue(view.relatedLogs);
    expect(related.lines).toStrictEqual([{ ...logEntryView(SELECTED_LINE), selected: true, gapMilliseconds: null }]);
    expect(related.hasOlder).toBe(false);
    expect(related.hasNewer).toBe(true);
    expect(related.hasMore).toBe(true);
    expect(relatedCalls(observeStore.calls)).toHaveLength(2);
    expect(okValue(view.requestSummary!)).toMatchObject({ lineCount: 1, hasMore: true, firstMessage: "boom", durationMilliseconds: 0 });
  });

  it("다시 받는 호출이 실패하면 연관 로그 · 요약은 그 실패(고른 줄 없는 최신 500줄을 내지 않는다) · 고른 로그 · 4 구역은 값", async () => {
    const { outcome } = await run({
      lines: linesAroundSelected(SELECTED_LINE, 600, 600, SECOND),
      observe: (fallback) => (url, init) => (url.searchParams.get("request_id") !== null && url.searchParams.get("before") === `${T}-3`
        ? textResponse(leakyErrorBody(), 503)
        : fallback(url, init)),
    });
    const view = viewOf(outcome);
    expect(okValue(view.selected)).toStrictEqual(logEntryView(SELECTED_LINE));
    expectFailure(view.relatedLogs, "unavailable", 503);
    expectFailure(view.requestSummary!, "unavailable", 503);
    expect(view.serverState.levelCounts.ok).toBe(true);
    expect(view.serverState.deployments.ok).toBe(true);
    expect(view.serverState.incidents.ok).toBe(true);
    expectNoForbiddenText(view);
  });

  it("다시 받은 뒤의 확인 호출이 실패해도 연관 로그 · 요약은 그 실패(조용히 hasOlder false 로 두지 않는다)", async () => {
    const { outcome } = await run({
      lines: linesAroundSelected(SELECTED_LINE, 600, 600, SECOND),
      observe: (fallback) => (url, init) => (url.searchParams.get("request_id") !== null && url.searchParams.get("before") === `${T - 499 * SECOND}-0`
        ? textResponse(leakyErrorBody(), 504)
        : fallback(url, init)),
    });
    const view = viewOf(outcome);
    expect(view.selected.ok).toBe(true);
    expectFailure(view.relatedLogs, "server_timeout", 504);
    expectFailure(view.requestSummary!, "server_timeout", 504);
  });

  it("다시 받은 응답에도 고른 줄이 없으면(그 사이 지워짐) 연관 로그 · 요약은 not_found — 고른 줄 없는 목록을 내지 않는다 · 확인 호출 없음", async () => {
    const { outcome, observeStore } = await run({
      lines: linesAroundSelected(SELECTED_LINE, 600, 600, SECOND),
      // 다시 받는 호출만 고른 줄을 뺀 응답으로(before 를 고른 id 로 — 엄격이라 고른 줄은 빠진다)
      observe: (fallback) => (url, init) => {
        if (url.searchParams.get("request_id") === null || url.searchParams.get("before") !== `${T}-3`) return fallback(url, init);
        const withoutSelected = new URL(url);
        withoutSelected.searchParams.set("before", SELECTED_LOG_ID);
        return fallback(withoutSelected, init);
      },
    });
    const view = viewOf(outcome);
    expect(okValue(view.selected)).toStrictEqual(logEntryView(SELECTED_LINE));
    expectFailure(view.relatedLogs, "not_found");
    expectFailure(view.requestSummary!, "not_found");
    expect(relatedCalls(observeStore.calls)).toHaveLength(2);
    expect(view.serverState.levelCounts.ok).toBe(true);
  });

  it("첫 연관 응답이 500줄 미만인데 고른 줄이 빠졌으면(확인 직후 지워짐) 연관 로그 · 요약은 not_found — 다시 받지 않는다", async () => {
    const { outcome, observeStore } = await run({
      // 첫 연관 호출만 고른 줄을 뺀 응답으로(before 를 고른 id 로 — 엄격이라 고른 줄은 빠지고 500줄 미만)
      observe: (fallback) => (url, init) => {
        if (url.searchParams.get("request_id") === null || url.searchParams.get("before") !== null) return fallback(url, init);
        const withoutSelected = new URL(url);
        withoutSelected.searchParams.set("before", SELECTED_LOG_ID);
        return fallback(withoutSelected, init);
      },
    });
    const view = viewOf(outcome);
    expect(okValue(view.selected)).toStrictEqual(logEntryView(SELECTED_LINE));
    expectFailure(view.relatedLogs, "not_found");
    expectFailure(view.requestSummary!, "not_found");
    expect(relatedCalls(observeStore.calls)).toHaveLength(1);
    expect(view.serverState.levelCounts.ok).toBe(true);
  });

  describe("요청 ID 가 없는 로그(같은 서비스 ±30초)도 같은 규칙", () => {
    const selectedWithoutRequest = fakeLogLine({ requestId: "", service: "observe", level: "warning", message: "수집 지연" });
    const serviceLines = linesAroundSelected(selectedWithoutRequest, 500, 10, 50, { requestId: "", service: "observe" });

    it("뒤 500줄 · 앞 10줄 — service 조건으로 다시 받는다 · 고른 줄이 마지막 · hasNewer true · hasOlder false · 요약 없음", async () => {
      const { outcome, observeStore } = await run({ lines: serviceLines });
      const view = viewOf(outcome);
      expect(view.requestSummary).toBeNull();
      const related = okValue(view.relatedLogs);
      expect(related.scope).toBe("service");
      expect(related.lines).toHaveLength(11);
      expect(related.lines[0].message).toBe("앞 줄 10");
      expect(related.lines[10]).toMatchObject({ id: SELECTED_LOG_ID, selected: true, message: "수집 지연" });
      expect(related.hasNewer).toBe(true);
      expect(related.hasOlder).toBe(false);
      expect(related.hasMore).toBe(true);
      expect(relatedCalls(observeStore.calls)).toEqual([
        { service: "observe", from: isoMilliseconds(T - 30 * SECOND), to: isoMilliseconds(T + 30 * SECOND), limit: "500" },
        { service: "observe", before: `${T}-3`, from: javaInstantText(T - 30 * SECOND), to: javaInstantText(T + 30 * SECOND), limit: "500" },
      ]);
    });

    it("다시 받는 호출이 실패하면 연관 로그는 그 실패", async () => {
      const { outcome } = await run({
        lines: serviceLines,
        observe: (fallback) => (url, init) => (url.searchParams.get("service") !== null && url.searchParams.get("before") === `${T}-3`
          ? textResponse(leakyErrorBody(), 500)
          : fallback(url, init)),
      });
      const view = viewOf(outcome);
      expect(view.selected.ok).toBe(true);
      expectFailure(view.relatedLogs, "bad_status", 500);
    });
  });
});
