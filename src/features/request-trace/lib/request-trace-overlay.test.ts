/** 요청 추적의 겹친 시간 줄(T7, 순수) — 구간 하나 = 서비스(와 서버) 하나의 막대: 시작(= 끝 − 걸린 시간) · 끝 · nginx 안의 시간 · 상태 ·
 * 로그 줄이 그 막대 안팎 어디에 놓이는가 · 한 시간 축(로그와 구간을 합친 범위) · 서비스 이름의 짝짓기(규약 2.1 — `ci-agent-<서버>` → `ci-agent`, 그 밖은 그대로) ·
 * 로그만 / 구간만 있는 서비스 · 같은 서비스의 구간 여럿 · 0ms · 아주 긴 구간 · 시계가 어긋난 경우(꾸미지 않고 깨지지 않는다) · 경로의 표시 · 수신 상태의 알림. */
import { describe, expect, it } from "vitest";
import { fakeLogLine, javaInstantText } from "@/features/log-trace/lib/log-trace-test-fakes";
import type { LogEntryView } from "@/features/logs/lib/log-query";
import {
  SPAN_PATH_DISPLAY_LENGTH, buildSpanOverlay, displaySpanPath, protocolServiceName, spanReceiptNotes, type SpanOverlay,
} from "@/features/request-trace/lib/request-trace-overlay";
import type { RequestSpans } from "@/features/request-trace/lib/request-trace-spans";
import { TRACE_REQUEST_ID, TRACE_START_MILLISECONDS, entryOf } from "@/features/request-trace/lib/request-trace-test-fakes";
import type { TrafficServerReceipt, TrafficSpan } from "@/features/request-trace/lib/traffic-span-client";
import {
  OVERLAY_LOG_SCENARIO, fakeServerReceipt, fakeSpan, overlaySpanScenario, trafficServerReceiptOf, trafficSpanOf,
} from "@/features/request-trace/lib/traffic-span-test-fakes";
import { upstreamFailure } from "@/shared/lib/upstream-result";

const T = TRACE_START_MILLISECONDS;

function logAt(offset: number, service: string, level: "debug" | "info" | "warning" | "error" = "info", sequence = 0): LogEntryView {
  return entryOf(fakeLogLine({ milliseconds: T + offset, sequence, service, level, requestId: TRACE_REQUEST_ID, message: `${service} ${offset}` }));
}

function scenarioLogs(): LogEntryView[] {
  return OVERLAY_LOG_SCENARIO.map(([offset, service, level]) => logAt(offset, service, level));
}

function scenarioSpans(): TrafficSpan[] {
  // 관측 서버의 차례(end_ms)로 준다 — 화면의 차례는 따로 정한다
  return overlaySpanScenario(TRACE_REQUEST_ID, T).map(trafficSpanOf).sort((left, right) => Date.parse(left.endAt) - Date.parse(right.endAt));
}

function spanAt(endOffset: number, durationMilliseconds: number, overrides: Partial<Parameters<typeof fakeSpan>[0]> = {}): TrafficSpan {
  return trafficSpanOf(fakeSpan({ requestId: TRACE_REQUEST_ID, endMilliseconds: T + endOffset, durationMilliseconds, upstreamMilliseconds: null, ...overrides }));
}

function overlayOf(logs: readonly LogEntryView[] | null, spans: readonly TrafficSpan[]): SpanOverlay {
  const overlay = buildSpanOverlay(logs, spans);
  expect(overlay).not.toBeNull();
  return overlay!;
}

function laneOf(overlay: SpanOverlay, service: string) {
  const lane = overlay.lanes.find((candidate) => candidate.service === service);
  expect(lane, `${service} 줄이 없다`).toBeDefined();
  return lane!;
}

describe("서비스 이름의 짝짓기 — protocolServiceName(규약 2.1 의 표)", () => {
  it.each([
    ["ci-agent-158", "ci-agent"],
    ["ci-agent-front", "ci-agent"],
    ["ci-agent-home.a_1", "ci-agent"],
    ["ci-agent", "ci-agent"],
    ["ci-master", "ci-master"],
    ["llm-wrapper", "llm-wrapper"],
    ["llm", "llm"],                 // 배포 · 감시 이름은 짐작해 잇지 않는다(로그 이름이 규약 이름)
    ["front", "front"],
    ["backend", "backend"],
    ["admin", "admin"],
    ["ci-agent-", "ci-agent-"],     // 뒤에 서버 이름이 없으면 그대로
    ["xci-agent-1", "xci-agent-1"],
  ])("%s → %s", (logService, protocolName) => {
    expect(protocolServiceName(logService)).toBe(protocolName);
  });
});

describe("겹친 시간 줄 — 채팅 한 건(로그 일곱 줄 + 구간 셋)", () => {
  it("축은 로그와 구간을 합친 범위 — 시작은 front 구간의 시작(T + 0), 끝은 front 구간의 끝(T + 3700) — 로그만의 범위(10 ~ 3680)가 아니다", () => {
    const overlay = overlayOf(scenarioLogs(), scenarioSpans());
    expect(overlay.startAt).toBe(javaInstantText(T));
    expect(overlay.endAt).toBe(javaInstantText(T + 3700));
    expect(overlay.durationMilliseconds).toBe(3700);
  });

  it("줄의 차례는 그 서비스가 축에 처음 나타난 시각(구간의 시작 · 로그 중 이른 것) — front · backend · llm-wrapper · ci-agent", () => {
    expect(overlayOf(scenarioLogs(), scenarioSpans()).lanes.map((lane) => lane.service)).toEqual(["front", "backend", "llm-wrapper", "ci-agent"]);
  });

  it("구간마다 시작(= 끝 − 걸린 시간) · 끝 · 걸린 시간 · upstream · nginx 안(걸린 시간 − upstream) · 5xx · 축 위의 위치와 길이 · 그 안의 로그 줄", () => {
    const overlay = overlayOf(scenarioLogs(), scenarioSpans());
    const pick = (service: string) => {
      const [span] = laneOf(overlay, service).spans;
      return {
        server: span.server, caller: span.caller, startAt: span.startAt, endAt: span.endAt, startOffsetMilliseconds: span.startOffsetMilliseconds,
        endOffsetMilliseconds: span.endOffsetMilliseconds, durationMilliseconds: span.durationMilliseconds, upstreamMilliseconds: span.upstreamMilliseconds,
        nginxMilliseconds: span.nginxMilliseconds, status: span.status, serverError: span.serverError, logLinesInside: span.logLinesInside,
      };
    };
    expect(pick("front")).toEqual({
      server: "ci-agent-158", caller: "outside", startAt: javaInstantText(T), endAt: javaInstantText(T + 3700), startOffsetMilliseconds: 0,
      endOffsetMilliseconds: 3700, durationMilliseconds: 3700, upstreamMilliseconds: 3600, nginxMilliseconds: 100, status: 500, serverError: true, logLinesInside: 2,
    });
    expect(pick("backend")).toEqual({
      server: "ci-agent-164", caller: "front", startAt: javaInstantText(T + 110), endAt: javaInstantText(T + 3550), startOffsetMilliseconds: 110,
      endOffsetMilliseconds: 3550, durationMilliseconds: 3440, upstreamMilliseconds: 3430, nginxMilliseconds: 10, status: 502, serverError: true, logLinesInside: 2,
    });
    expect(pick("llm-wrapper")).toEqual({
      server: "ci-agent-164", caller: "backend", startAt: javaInstantText(T + 2300), endAt: javaInstantText(T + 3300), startOffsetMilliseconds: 2300,
      endOffsetMilliseconds: 3300, durationMilliseconds: 1000, upstreamMilliseconds: 990, nginxMilliseconds: 10, status: 200, serverError: false, logLinesInside: 1,
    });
    const backend = laneOf(overlay, "backend").spans[0];
    expect(backend.startFraction).toBeCloseTo(110 / 3700, 10);
    expect(backend.lengthFraction).toBeCloseTo(3440 / 3700, 10);
    const front = laneOf(overlay, "front").spans[0];
    expect(front.startFraction).toBe(0);
    expect(front.lengthFraction).toBe(1);
  });

  it("줄마다 로그의 수 · 구간 밖의 로그(backend 의 3650 은 구간 끝 3550 뒤) · 로그만 있는 서비스(ci-agent — 구간 없음)", () => {
    const overlay = overlayOf(scenarioLogs(), scenarioSpans());
    const summary = overlay.lanes.map(({ service, logServices, spans, logLineCount, logLinesOutsideSpans }) =>
      ({ service, logServices, spanCount: spans.length, logLineCount, logLinesOutsideSpans }));
    expect(summary).toEqual([
      { service: "front", logServices: ["front"], spanCount: 1, logLineCount: 2, logLinesOutsideSpans: 0 },
      { service: "backend", logServices: ["backend"], spanCount: 1, logLineCount: 3, logLinesOutsideSpans: 1 },
      { service: "llm-wrapper", logServices: ["llm-wrapper"], spanCount: 1, logLineCount: 1, logLinesOutsideSpans: 0 },
      { service: "ci-agent", logServices: ["ci-agent-158"], spanCount: 0, logLineCount: 1, logLinesOutsideSpans: 1 },
    ]);
  });

  it("로그 표시는 같은 축 위에(시작에서 ms · 비율 · 수준) — 로그의 시작이 아니라 축의 시작에서 잰다", () => {
    const front = laneOf(overlayOf(scenarioLogs(), scenarioSpans()), "front");
    expect(front.logMarks.map(({ offsetMilliseconds, level }) => ({ offsetMilliseconds, level }))).toEqual([
      { offsetMilliseconds: 10, level: "info" }, { offsetMilliseconds: 3590, level: "warning" },
    ]);
    expect(front.logMarks[0].fraction).toBeCloseTo(10 / 3700, 10);
  });

  it("표의 차례(overlay.spans) — 시작 · 끝 · 서비스 · 서버순(관측 서버가 준 end_ms 차례가 아니다)", () => {
    expect(overlayOf(scenarioLogs(), scenarioSpans()).spans.map((span) => span.service)).toEqual(["front", "backend", "llm-wrapper"]);
  });
});

describe("짝짓기의 경우", () => {
  it("llm-wrapper 의 로그와 llm-wrapper 의 구간은 한 줄", () => {
    const overlay = overlayOf([logAt(50, "llm-wrapper")], [spanAt(100, 100, { service: "llm-wrapper", caller: "backend" })]);
    expect(overlay.lanes).toHaveLength(1);
    expect(overlay.lanes[0]).toMatchObject({ service: "llm-wrapper", logServices: ["llm-wrapper"], logLineCount: 1, logLinesOutsideSpans: 0 });
    expect(overlay.lanes[0].spans[0].logLinesInside).toBe(1);
  });

  it("로그 이름 llm 은 llm-wrapper 의 구간과 잇지 않는다(따로의 줄 — 짐작하지 않는다)", () => {
    const overlay = overlayOf([logAt(50, "llm")], [spanAt(100, 100, { service: "llm-wrapper" })]);
    expect(overlay.lanes.map((lane) => lane.service).sort()).toEqual(["llm", "llm-wrapper"]);
  });

  it("에이전트 둘의 로그(ci-agent-158 · ci-agent-164)와 ci-agent 구간 — 한 줄, 로그 이름은 둘 다 남는다", () => {
    const overlay = overlayOf(
      [logAt(30, "ci-agent-164"), logAt(10, "ci-agent-158"), logAt(20, "ci-agent-158", "info", 1)],
      [spanAt(40, 40, { service: "ci-agent", caller: "ci-master", server: "ci-agent-158" })],
    );
    expect(overlay.lanes).toHaveLength(1);
    expect(overlay.lanes[0]).toMatchObject({ service: "ci-agent", logServices: ["ci-agent-158", "ci-agent-164"], logLineCount: 3, logLinesOutsideSpans: 0 });
    expect(overlay.lanes[0].spans[0].logLinesInside).toBe(3);
  });

  it("구간만 있고 로그가 없는 서비스 — 로그 0줄(읽지 못함이 아니다)", () => {
    const overlay = overlayOf([logAt(10, "front")], [spanAt(100, 50, { service: "admin", caller: "outside" })]);
    expect(laneOf(overlay, "admin")).toMatchObject({ logServices: [], logLineCount: 0, logLinesOutsideSpans: 0 });
    expect(laneOf(overlay, "admin").spans[0].logLinesInside).toBe(0);
  });

  it("로그를 읽지 못했으면(null) — 줄은 구간만으로, 로그의 수는 모두 null(0 으로 두지 않는다)", () => {
    const overlay = overlayOf(null, [spanAt(100, 50, { service: "backend" })]);
    expect(overlay.lanes).toHaveLength(1);
    expect(overlay.lanes[0]).toMatchObject({ service: "backend", logServices: [], logLineCount: null, logLinesOutsideSpans: null, logMarks: [] });
    expect(overlay.lanes[0].spans[0].logLinesInside).toBeNull();
    expect(overlay.startAt).toBe(javaInstantText(T + 50));
  });

  it("구간이 없으면 null(겹칠 것이 없다 — 로그의 시간 줄은 T3 의 표가 보인다)", () => {
    expect(buildSpanOverlay(scenarioLogs(), [])).toBeNull();
    expect(buildSpanOverlay(null, [])).toBeNull();
  });
});

describe("같은 서비스의 구간 여럿 · 경계 · 긴 구간 · 시계", () => {
  it("재시도(같은 서버 둘) · 두 서버 — 한 줄에 구간 셋, 시작순 · 로그는 구간마다 안을 센다(겹치면 둘 다) · 밖은 어느 구간에도 들지 않는 줄", () => {
    const overlay = overlayOf(
      [logAt(5, "backend"), logAt(60, "backend"), logAt(150, "backend"), logAt(400, "backend")],
      [
        spanAt(300, 100, { service: "backend", server: "ci-agent-164", status: 200 }),
        spanAt(100, 100, { service: "backend", server: "ci-agent-158", status: 502 }),
        spanAt(80, 30, { service: "backend", server: "ci-agent-158", status: 200 }),
      ],
    );
    const lane = laneOf(overlay, "backend");
    expect(lane.spans.map((span) => [span.server, span.startOffsetMilliseconds, span.status])).toEqual([
      ["ci-agent-158", 0, 502], ["ci-agent-158", 50, 200], ["ci-agent-164", 200, 200],
    ]);
    expect(overlay.startAt).toBe(javaInstantText(T));
    expect(lane.spans.map((span) => span.logLinesInside)).toEqual([2, 1, 0]);   // [0,100]: 5 · 60 / [50,80]: 60 / [200,300]: 없음
    expect(lane.logLineCount).toBe(4);
    expect(lane.logLinesOutsideSpans).toBe(2);   // 150 · 400
  });

  it("구간의 경계는 양끝 포함 — 끝과 같은 밀리초의 로그는 안", () => {
    const overlay = overlayOf([logAt(100, "front"), logAt(200, "front")], [spanAt(200, 100, { service: "front" })]);
    expect(laneOf(overlay, "front").spans[0].logLinesInside).toBe(2);
    expect(laneOf(overlay, "front").logLinesOutsideSpans).toBe(0);
  });

  it("0ms 구간 — 시작 = 끝 · 길이 0 · 그 밀리초의 로그는 안 · NaN 없음", () => {
    const overlay = overlayOf([logAt(0, "front"), logAt(500, "front")], [spanAt(500, 0, { service: "front" })]);
    const span = laneOf(overlay, "front").spans[0];
    expect(span.startAt).toBe(span.endAt);
    expect(span.durationMilliseconds).toBe(0);
    expect(span.lengthFraction).toBe(0);
    expect(span.startFraction).toBe(1);
    expect(span.logLinesInside).toBe(1);
    expect(JSON.stringify(overlay)).not.toContain("NaN");
  });

  it("구간 하나뿐이고 0ms · 로그 없음 — 축의 길이 0, 비율은 0(나누기 0 으로 깨지지 않는다)", () => {
    const overlay = overlayOf([], [spanAt(500, 0, { service: "front" })]);
    expect(overlay.durationMilliseconds).toBe(0);
    expect(overlay.lanes[0].spans[0]).toMatchObject({ startFraction: 0, lengthFraction: 0, startOffsetMilliseconds: 0, endOffsetMilliseconds: 0 });
    expect(JSON.stringify(overlay)).not.toContain("NaN");
  });

  it("아주 긴 구간(채팅 스트림 180초) — 축이 그만큼 늘고 짧은 구간은 그 안의 작은 비율", () => {
    const overlay = overlayOf([logAt(1000, "backend")], [
      spanAt(180_000, 180_000, { service: "front", caller: "outside" }),
      spanAt(1200, 200, { service: "backend", caller: "front" }),
    ]);
    expect(overlay.durationMilliseconds).toBe(180_000);
    expect(laneOf(overlay, "front").spans[0].lengthFraction).toBe(1);
    expect(laneOf(overlay, "backend").spans[0].lengthFraction).toBeCloseTo(200 / 180_000, 10);
  });

  it("시계가 어긋나 구간이 로그보다 앞에서 끝나도 — 꾸미지 않고 그대로(음수 · NaN 없음, 로그는 구간 밖)", () => {
    const overlay = overlayOf([logAt(10, "backend"), logAt(20, "backend")], [spanAt(-500, 200, { service: "backend" })]);
    expect(overlay.startAt).toBe(javaInstantText(T - 700));
    expect(overlay.endAt).toBe(javaInstantText(T + 20));
    const lane = laneOf(overlay, "backend");
    expect(lane.spans[0]).toMatchObject({ startOffsetMilliseconds: 0, endOffsetMilliseconds: 200, durationMilliseconds: 200, logLinesInside: 0 });
    expect(lane.logMarks.map((mark) => mark.offsetMilliseconds)).toEqual([710, 720]);
    expect(lane.logLinesOutsideSpans).toBe(2);
    for (const mark of lane.logMarks) expect(mark.fraction).toBeLessThanOrEqual(1);
    expect(JSON.stringify(overlay)).not.toContain("NaN");
  });

  it("upstream 이 없으면 nginx 안도 null(0 으로 두지 않는다)", () => {
    const overlay = overlayOf([], [spanAt(100, 100, { service: "front", upstreamMilliseconds: null })]);
    expect(overlay.lanes[0].spans[0]).toMatchObject({ upstreamMilliseconds: null, nginxMilliseconds: null });
  });

  it("5xx 만 serverError(4xx · 499 · 3xx 는 아니다)", () => {
    const overlay = overlayOf([], [500, 503, 599, 499, 404, 302, 200].map((status, index) => spanAt(100 + index, 10, { service: "front", status })));
    expect(Object.fromEntries(overlay.spans.map((span) => [span.status, span.serverError]))).toEqual({
      500: true, 503: true, 599: true, 499: false, 404: false, 302: false, 200: false,
    });
  });

  it("줄의 차례가 같은 시각이면 이름순", () => {
    const overlay = overlayOf([], [spanAt(100, 100, { service: "front" }), spanAt(100, 100, { service: "backend" })]);
    expect(overlay.lanes.map((lane) => lane.service)).toEqual(["backend", "front"]);
  });
});

describe("경로의 표시 — displaySpanPath", () => {
  it(`${SPAN_PATH_DISPLAY_LENGTH}자(코드 포인트)까지 그대로`, () => {
    const path = `/${"가".repeat(SPAN_PATH_DISPLAY_LENGTH - 1)}`;
    expect(displaySpanPath(path, false)).toEqual({ text: path, shortened: false });
  });

  it("넘으면 앞 120자 + …(서로게이트 쌍을 가르지 않는다)", () => {
    const path = `/${"😀".repeat(300)}`;
    const shown = displaySpanPath(path, false);
    expect(shown.shortened).toBe(true);
    expect(Array.from(shown.text)).toHaveLength(SPAN_PATH_DISPLAY_LENGTH + 1);
    expect(shown.text.endsWith("…")).toBe(true);
    expect(shown.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("관측 서버가 이미 잘랐으면(path_truncated) 짧아도 …와 함께 잘림으로", () => {
    expect(displaySpanPath("/a", true)).toEqual({ text: "/a…", shortened: true });
  });

  it("빈 경로는 '(경로 없음)'", () => {
    expect(displaySpanPath("", false)).toEqual({ text: "(경로 없음)", shortened: false });
  });
});

describe("수신 상태의 알림 — spanReceiptNotes(조용히 빠진 것을 드러낸다)", () => {
  const REFERENCE = T + 3700;
  function requestSpans(receipt: RequestSpans["receipt"], truncated = false): RequestSpans {
    return { spans: scenarioSpans(), truncated, referenceAt: new Date(REFERENCE).toISOString(), receipt };
  }
  const receipts = (...items: Parameters<typeof fakeServerReceipt>[0][]): TrafficServerReceipt[] =>
    items.map((item) => trafficServerReceiptOf(fakeServerReceipt(item)));

  it("모두 따라잡았고 버린 것 · 틈 · 지연이 없으면 알림 없음", () => {
    const notes = spanReceiptNotes(requestSpans({ ok: true, value: receipts({ server: "a", readProgressMilliseconds: REFERENCE + 30_000 }) }));
    expect(notes).toEqual({
      truncated: false, receiptFailure: null, behindServers: [], delayedServers: [], gapServers: [], requestsDropped: 0, requestsRejected: 0, mayBeIncomplete: false,
    });
  });

  it("읽기 진도가 기준 + 30초에 못 미치거나(정확히 30초는 따라잡음) 없으면 '못 미친 서버' — 받은 차례 그대로", () => {
    const notes = spanReceiptNotes(requestSpans({ ok: true, value: receipts(
      { server: "a", readProgressMilliseconds: REFERENCE + 30_000 },
      { server: "b", readProgressMilliseconds: REFERENCE + 29_999 },
      { server: "c", readProgressMilliseconds: null },
      { server: "d", readProgressMilliseconds: REFERENCE - 60_000 },
    ) }));
    expect(notes.behindServers).toEqual(["b", "c", "d"]);
    expect(notes.mayBeIncomplete).toBe(true);
  });

  it("수신 지연 · 틈(sequence_gaps) · 읽지 못한 범위(missing) · 버린 줄의 합(requests_dropped · requests_rejected)", () => {
    const caughtUp = REFERENCE + 60_000;
    const notes = spanReceiptNotes(requestSpans({ ok: true, value: receipts(
      { server: "a", readProgressMilliseconds: caughtUp, receiveDelayed: true },
      { server: "b", readProgressMilliseconds: caughtUp, sequenceGaps: 2, requestsDropped: 7 },
      { server: "c", readProgressMilliseconds: caughtUp, missing: ["backend-nginx:rotated"], requestsRejected: 3 },
      { server: "d", readProgressMilliseconds: caughtUp, requestsDropped: 1, requestsRejected: 1 },
    ) }));
    expect(notes).toMatchObject({
      behindServers: [], delayedServers: ["a"], gapServers: ["b", "c"], requestsDropped: 8, requestsRejected: 4, mayBeIncomplete: true,
    });
  });

  it.each([
    ["버린 줄만", { requestsDropped: 1 }],
    ["경로로 버린 줄만", { requestsRejected: 1 }],
    ["지연만", { receiveDelayed: true }],
    ["틈만", { sequenceGaps: 1 }],
    ["읽지 못한 범위만", { missing: ["x:unreadable"] }],
  ])("하나만 있어도 mayBeIncomplete — %s", (_label, change) => {
    const notes = spanReceiptNotes(requestSpans({ ok: true, value: receipts({ server: "a", readProgressMilliseconds: REFERENCE + 60_000, ...change }) }));
    expect(notes.mayBeIncomplete).toBe(true);
  });

  it("수신 상태를 읽지 못했으면 그 실패 — '다 들어왔다'로 두지 않는다", () => {
    const failure = upstreamFailure("unavailable", { status: 503 });
    const notes = spanReceiptNotes(requestSpans(failure));
    expect(notes).toMatchObject({ receiptFailure: failure, behindServers: [], mayBeIncomplete: true });
  });

  it("관측 서버가 500 개에서 잘랐으면 truncated(수신과는 따로 — 그것만으로 mayBeIncomplete 가 아니다)", () => {
    const notes = spanReceiptNotes(requestSpans({ ok: true, value: [] }, true));
    expect(notes).toMatchObject({ truncated: true, mayBeIncomplete: false });
  });

  it("서버가 하나도 없으면(진도를 아는 서버가 없다) 알림 없음 — 빈 목록은 실패가 아니다", () => {
    expect(spanReceiptNotes(requestSpans({ ok: true, value: [] })).mayBeIncomplete).toBe(false);
  });
});
