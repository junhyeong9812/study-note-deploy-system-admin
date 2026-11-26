/** 요청 추적의 구간 칸(T7, 순수) — 구간 조회 → 수신 상태 조회의 차례 · 창 · 실패가 칸마다 따로 · 서버 이름의 주소 가리기 · 경로 다듬기.
 * 관측 서버는 가짜(관측 서버의 실제 규칙 흉내 — traffic-span-test-fakes). */
import { describe, expect, it } from "vitest";
import { fakeLogLine } from "@/features/log-trace/lib/log-trace-test-fakes";
import type { LogEntryView } from "@/features/logs/lib/log-query";
import {
  RECEIPT_FILLING_MARGIN_MILLISECONDS, RECEIPT_WINDOW_AFTER_MILLISECONDS, RECEIPT_WINDOW_DEFAULT_MILLISECONDS, RECEIPT_WINDOW_MAXIMUM_MILLISECONDS,
  buildRequestSpans, receiptWindow, sanitizeSpanPath,
} from "@/features/request-trace/lib/request-trace-spans";
import { TRACE_REQUEST_ID, TRACE_START_MILLISECONDS, entryOf } from "@/features/request-trace/lib/request-trace-test-fakes";
import { createTrafficSpanClient } from "@/features/request-trace/lib/traffic-span-client";
import {
  OVERLAY_LOG_SCENARIO, callsToPath, createFakeObserveTraffic, fakeServerReceipt, fakeSpan, overlaySpanScenario, type FakeServerReceipt, type FakeSpan,
} from "@/features/request-trace/lib/traffic-span-test-fakes";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, createRoutedFetch, expectFailure, expectNoForbiddenText, jsonBody, leakyErrorBody, okValue, textResponse,
  type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const T = TRACE_START_MILLISECONDS;
const MINUTE = 60_000;
const NOW = T + 10 * MINUTE;

function logLines(): LogEntryView[] {
  return OVERLAY_LOG_SCENARIO.map(([offset, service, level, message]) =>
    entryOf(fakeLogLine({ milliseconds: T + offset, sequence: 0, service, level, requestId: TRACE_REQUEST_ID, message })));
}

function setUp(options: { spans?: FakeSpan[]; servers?: FakeServerReceipt[]; override?: (url: URL) => Response | null } = {}) {
  const fake = createFakeObserveTraffic({ spans: options.spans ?? overlaySpanScenario(TRACE_REQUEST_ID, T), servers: options.servers ?? [fakeServerReceipt()] });
  const handler: RoutedFetchHandler = (url, init) => options.override?.(url) ?? fake.handler(url, init);
  const fetch = createRoutedFetch(handler);
  return { fake, fetch, client: createTrafficSpanClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }) };
}

describe("상수 — 관측 서버와 같은 값", () => {
  it("채우는 중의 여유 30초 · 창의 뒤 5분 · 기본 5분 · 최대 24시간", () => {
    expect(RECEIPT_FILLING_MARGIN_MILLISECONDS).toBe(30_000);
    expect(RECEIPT_WINDOW_AFTER_MILLISECONDS).toBe(5 * MINUTE);
    expect(RECEIPT_WINDOW_DEFAULT_MILLISECONDS).toBe(5 * MINUTE);
    expect(RECEIPT_WINDOW_MAXIMUM_MILLISECONDS).toBe(24 * 60 * MINUTE);
  });
});

describe("수신 상태의 창 — receiptWindow(시각들, 지금)", () => {
  const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

  it("시각이 없으면 기준 = 지금 · 창 = 지금부터 거꾸로 5분", () => {
    expect(receiptWindow([], NOW)).toEqual({ from: iso(NOW - 5 * MINUTE), to: iso(NOW), referenceMilliseconds: NOW });
  });

  it("기준 = 가장 늦은 시각 · 창 = 가장 이른 시각 ~ 가장 늦은 시각 + 5분(차례와 상관없이)", () => {
    expect(receiptWindow([T + 3700, T, T + 120], NOW)).toEqual({ from: iso(T), to: iso(T + 3700 + 5 * MINUTE), referenceMilliseconds: T + 3700 });
  });

  it("끝은 지금을 넘지 않는다", () => {
    expect(receiptWindow([NOW - MINUTE], NOW)).toEqual({ from: iso(NOW - MINUTE), to: iso(NOW), referenceMilliseconds: NOW - MINUTE });
  });

  it("시계가 앞서 시각이 지금보다 뒤면 — 끝은 지금, 시작은 끝보다 늦지 않다(관측 서버가 거꾸로를 422 로 거절한다)", () => {
    expect(receiptWindow([NOW + MINUTE], NOW)).toEqual({ from: iso(NOW), to: iso(NOW), referenceMilliseconds: NOW + MINUTE });
  });

  it("24시간보다 넓으면 끝에서 거꾸로 24시간(관측 서버의 최대 기간)", () => {
    const window = receiptWindow([T - 3 * 24 * 60 * MINUTE, T], NOW);
    expect(window).toEqual({ from: iso(T + 5 * MINUTE - 24 * 60 * MINUTE), to: iso(T + 5 * MINUTE), referenceMilliseconds: T });
    expect(Date.parse(window.to) - Date.parse(window.from)).toBe(RECEIPT_WINDOW_MAXIMUM_MILLISECONDS);
  });
});

describe("경로 다듬기 — sanitizeSpanPath(관측 서버가 막아도 받은 글자를 그대로 믿지 않는다)", () => {
  it.each([
    ["그대로", "/api/doc", "/api/doc"],
    ["빈 글자", "", ""],
    ["날것 ? 뒤를 버린다", "/search?q=secret-word", "/search"],
    ["%3F(대소문자) 뒤를 버린다", "/search%3fq=secret-word", "/search"],
    ["%3F 대문자", "/search%3Fq=secret-word", "/search"],
    ["제어 문자는 U+FFFD", "/a\u0000b\u0007c\u001fd\u007fe\u0085f", "/a�b�c�d�e�f"],
    ["줄바꿈", "/a\r\nb", "/a��b"],
    ["태그는 글자 그대로(이스케이프는 React)", "/<script>alert(1)</script>", "/<script>alert(1)</script>"],
    ["; 는 남는다(규약 3.2)", "/search;q=x", "/search;q=x"],
  ])("%s", (_label, input, expected) => {
    expect(sanitizeSpanPath(input)).toBe(expected);
  });

  it("길이는 자르지 않는다(화면에서 자른다 — 데이터에는 받은 1024자까지)", () => {
    expect(sanitizeSpanPath(`/${"a".repeat(1023)}`)).toHaveLength(1024);
  });
});

describe("buildRequestSpans — 구간 조회 → 수신 상태 조회", () => {
  it("클라이언트가 없으면 not_configured(부르지 않는다)", async () => {
    expectFailure(await buildRequestSpans(null, TRACE_REQUEST_ID, logLines(), NOW), "not_configured");
  });

  it("구간 조회 한 번 → 수신 상태 조회 한 번(이 차례) · 창은 로그와 구간을 합친 시각에서(구간의 시작 = 끝 − 걸린 시간)", async () => {
    const { fetch, fake, client } = setUp();
    const spans = okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, logLines(), NOW));
    expect(fetch.mock.calls.map(([input]) => new URL(input).pathname)).toEqual(["/traffic/requests", "/traffic/map"]);
    expect(fake.calls[0].parameters).toEqual({ request_id: TRACE_REQUEST_ID });
    // 가장 이른 시각 = front 구간의 시작(T + 0, 로그의 첫 줄은 T + 10) · 가장 늦은 시각 = front 구간의 끝(T + 3700, 로그의 끝은 T + 3680)
    expect(fake.calls[1].parameters).toEqual({ from: new Date(T).toISOString(), to: new Date(T + 3700 + 5 * MINUTE).toISOString() });
    expect(spans.referenceAt).toBe(new Date(T + 3700).toISOString());
    expect(spans.truncated).toBe(false);
    expect(spans.spans.map((span) => span.service)).toEqual(["llm-wrapper", "backend", "front"]);   // 관측 서버의 차례(end_ms) 그대로
    expect(okValue(spans.receipt)).toEqual([{
      server: "ci-agent-158", readProgressAt: null, receiveDelayed: false, sequenceGaps: 0, missing: [], requestsDropped: 0, requestsRejected: 0,
    }]);
  });

  it("로그를 읽지 못했으면(null) 창은 구간만으로", async () => {
    const { fake, client } = setUp({ spans: [fakeSpan({ requestId: TRACE_REQUEST_ID, endMilliseconds: T + 500, durationMilliseconds: 200 })] });
    okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, null, NOW));
    expect(fake.calls[1].parameters).toEqual({ from: new Date(T + 300).toISOString(), to: new Date(T + 500 + 5 * MINUTE).toISOString() });
  });

  it("로그도 구간도 없으면 기준은 지금 · 창은 지금부터 거꾸로 5분 — 그래도 수신 상태를 본다(방금 끝난 요청이면 아직 안 들어왔을 수 있다)", async () => {
    const { fetch, fake, client } = setUp({ spans: [] });
    const spans = okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, [], NOW));
    expect(spans.spans).toEqual([]);
    expect(spans.referenceAt).toBe(new Date(NOW).toISOString());
    expect(callsToPath(fetch.mock.calls, "/traffic/map")).toHaveLength(1);
    expect(fake.calls[1].parameters).toEqual({ from: new Date(NOW - 5 * MINUTE).toISOString(), to: new Date(NOW).toISOString() });
  });

  it("구간 조회가 실패하면 그 실패 — 빈 목록으로 두지 않고, 수신 상태는 부르지 않는다", async () => {
    const { fetch, client } = setUp({ override: (url) => (url.pathname === "/traffic/requests" ? textResponse(leakyErrorBody(), 503) : null) });
    const result = await buildRequestSpans(client, TRACE_REQUEST_ID, logLines(), NOW);
    expectFailure(result, "unavailable", 503);
    expect(callsToPath(fetch.mock.calls, "/traffic/map")).toHaveLength(0);
  });

  it("구간의 꼴이 틀리면 unparseable(칸을 0 으로 메우지 않는다)", async () => {
    const { client } = setUp({ override: (url) => (url.pathname === "/traffic/requests"
      ? jsonBody({ success: true, data: { request_id: TRACE_REQUEST_ID, spans: [{ server: "ci-agent-158" }], truncated: false } }) : null) });
    expectFailure(await buildRequestSpans(client, TRACE_REQUEST_ID, logLines(), NOW), "unparseable");
  });

  it("수신 상태 조회가 실패해도 구간은 그대로 — receipt 칸만 그 실패", async () => {
    const { client } = setUp({ override: (url) => (url.pathname === "/traffic/map" ? textResponse(leakyErrorBody(), 504) : null) });
    const spans = okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, logLines(), NOW));
    expect(spans.spans).toHaveLength(3);
    expectFailure(spans.receipt, "server_timeout", 504);
    expectNoForbiddenText(spans);
  });

  it("관측 서버의 truncated 를 그대로 싣는다", async () => {
    const many = Array.from({ length: 501 }, (_, index) => fakeSpan({ requestId: TRACE_REQUEST_ID, endMilliseconds: T + index }));
    const { client } = setUp({ spans: many });
    const spans = okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, [], NOW));
    expect(spans.truncated).toBe(true);
    expect(spans.spans).toHaveLength(500);
  });

  it("서버 이름 속의 주소 꼴(IPv4)은 가려서 싣는다 — 구간 · 수신 상태 모두(화면 데이터에 주소가 없다)", async () => {
    const { client } = setUp({
      spans: [fakeSpan({ requestId: TRACE_REQUEST_ID, server: "edge-192.168.0.7", endMilliseconds: T + 100 })],
      servers: [fakeServerReceipt({ server: "edge-192.168.0.7" }), fakeServerReceipt({ server: "ci-agent-158" })],
    });
    const spans = okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, [], NOW));
    expect(spans.spans[0].server).toBe("edge-(주소)");
    expect(okValue(spans.receipt).map((receipt) => receipt.server)).toEqual(["ci-agent-158", "edge-(주소)"]);
    expect(JSON.stringify(spans)).not.toContain("192.168.0.7");
  });

  it("경로는 sanitizeSpanPath 로 다듬어 싣는다(쿼리 · 제어 문자가 데이터에 남지 않는다)", async () => {
    const { client } = setUp({ spans: [fakeSpan({ requestId: TRACE_REQUEST_ID, path: "/search?q=secret-word\u0007", endMilliseconds: T + 100 })] });
    const spans = okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, [], NOW));
    expect(spans.spans[0].path).toBe("/search");
    expect(JSON.stringify(spans)).not.toContain("secret-word");
  });

  it("거부(reject)하지 않는다 — 네트워크가 동기로 던져도 실패 결과", async () => {
    const fetch = createRoutedFetch(() => { throw new Error("boom"); });
    const client = createTrafficSpanClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch });
    expectFailure(await buildRequestSpans(client, TRACE_REQUEST_ID, [], NOW), "unreachable");
  });
});
