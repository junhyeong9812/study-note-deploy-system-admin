/** 요청 추적의 구간 칸(T7, 순수) — 구간 조회 → 수신 상태 조회의 차례 · 창 · 실패가 칸마다 따로 · 서버 이름의 주소 가리기 · 경로 다듬기.
 * 관측 서버는 가짜(관측 서버의 실제 규칙 흉내 — traffic-span-test-fakes). */
import { describe, expect, it } from "vitest";
import { fakeLogLine } from "@/features/log-trace/lib/log-trace-test-fakes";
import type { LogEntryView } from "@/features/logs/lib/log-query";
import {
  RECEIPT_FILLING_MARGIN_MILLISECONDS, RECEIPT_WINDOW_MAXIMUM_MILLISECONDS,
  buildRequestSpans, receiptWindow, sanitizeSpanPath,
} from "@/features/request-trace/lib/request-trace-spans";
import { TRACE_REQUEST_ID, TRACE_START_MILLISECONDS, entryOf } from "@/features/request-trace/lib/request-trace-test-fakes";
import { createTrafficSpanClient } from "@/features/request-trace/lib/traffic-span-client";
import {
  OVERLAY_LOG_SCENARIO, callsToPath, createFakeObserveTraffic, fakeReceivedEntry, fakeServerReceipt, fakeSpan, overlaySpanScenario,
  type FakeReceivedEntry, type FakeServerReceipt, type FakeSpan,
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

function setUp(options: { spans?: FakeSpan[]; servers?: FakeServerReceipt[]; entries?: FakeReceivedEntry[]; override?: (url: URL) => Response | null } = {}) {
  const fake = createFakeObserveTraffic({
    spans: options.spans ?? overlaySpanScenario(TRACE_REQUEST_ID, T), servers: options.servers ?? [fakeServerReceipt()], entries: options.entries,
  });
  const handler: RoutedFetchHandler = (url, init) => options.override?.(url) ?? fake.handler(url, init);
  const fetch = createRoutedFetch(handler);
  return { fake, fetch, client: createTrafficSpanClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch }) };
}

describe("상수 — 관측 서버와 같은 값", () => {
  it("채우는 중의 여유 30초 · 최대 24시간", () => {
    expect(RECEIPT_FILLING_MARGIN_MILLISECONDS).toBe(30_000);
    expect(RECEIPT_WINDOW_MAXIMUM_MILLISECONDS).toBe(24 * 60 * MINUTE);
  });
});

describe("수신 상태의 창 — receiptWindow(시각들, 지금) (T7 리뷰 3: 끝은 지금 — 관측 서버는 버린 수 · missing 을 받은 시각으로 거른다)", () => {
  const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("기준 = 가장 늦은 시각 · 창 = 가장 이른 시각 ~ 지금(가장 이른 시각 + 24시간 안이면) — 차례와 상관없이", () => {
    expect(receiptWindow([T + 3700, T, T + 120], NOW)).toEqual({ from: iso(T), to: iso(NOW), referenceMilliseconds: T + 3700 });
  });

  it("방금의 요청이면 지금까지", () => {
    expect(receiptWindow([NOW - MINUTE], NOW)).toEqual({ from: iso(NOW - MINUTE), to: iso(NOW), referenceMilliseconds: NOW - MINUTE });
  });

  it("7일 전의 요청이면 그 요청부터 24시간(관측 서버의 최대 기간)", () => {
    expect(receiptWindow([NOW - 7 * DAY], NOW)).toEqual({ from: iso(NOW - 7 * DAY), to: iso(NOW - 6 * DAY), referenceMilliseconds: NOW - 7 * DAY });
  });

  it("시각들이 24시간보다 넓어도 시작은 가장 이른 시각 · 끝은 그 + 24시간", () => {
    const window = receiptWindow([T - 3 * DAY, T], NOW);
    expect(window).toEqual({ from: iso(T - 3 * DAY), to: iso(T - 2 * DAY), referenceMilliseconds: T });
    expect(Date.parse(window.to) - Date.parse(window.from)).toBe(RECEIPT_WINDOW_MAXIMUM_MILLISECONDS);
  });

  it("시계가 앞서 시각이 지금보다 뒤면 — 끝은 지금, 시작은 끝보다 늦지 않다(관측 서버가 거꾸로를 422 로 거절한다)", () => {
    expect(receiptWindow([NOW + MINUTE], NOW)).toEqual({ from: iso(NOW), to: iso(NOW), referenceMilliseconds: NOW + MINUTE });
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
    // 가장 이른 시각 = front 구간의 시작(T + 0, 로그의 첫 줄은 T + 10) · 끝 = 지금 · 기준 = front 구간의 끝(T + 3700, 로그의 끝은 T + 3680)
    expect(fake.calls[1].parameters).toEqual({ from: new Date(T).toISOString(), to: new Date(NOW).toISOString() });
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
    expect(fake.calls[1].parameters).toEqual({ from: new Date(T + 300).toISOString(), to: new Date(NOW).toISOString() });
  });

  it("로그도 구간도 없으면(시각이 하나도 없으면) 진도를 판정하지 않는다 — 수신 상태를 부르지 않고 receipt 는 빈 목록(T7 리뷰 5)", async () => {
    const { fetch, client } = setUp({ spans: [], servers: [fakeServerReceipt({ readProgressMilliseconds: null })] });
    const spans = okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, [], NOW));
    expect(spans.spans).toEqual([]);
    expect(okValue(spans.receipt)).toEqual([]);
    expect(callsToPath(fetch.mock.calls, "/traffic/map")).toHaveLength(0);
  });

  it("로그를 읽지 못했고(null) 구간도 없으면 — 역시 부르지 않는다", async () => {
    const { fetch, client } = setUp({ spans: [] });
    okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, null, NOW));
    expect(callsToPath(fetch.mock.calls, "/traffic/map")).toHaveLength(0);
  });

  it("구간이 없어도 로그가 있으면 수신 상태를 본다(창은 로그의 시각에서)", async () => {
    const { fake, client } = setUp({ spans: [] });
    okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, logLines(), NOW));
    expect(fake.calls[1]).toEqual({ path: "/traffic/map", parameters: { from: new Date(T + 10).toISOString(), to: new Date(NOW).toISOString() } });
  });

  it("요청 + 5분 뒤에 받은 항목의 버린 수 · missing 도 창에 든다 — 요청보다 앞서 받은 것 · 지금 뒤의 것은 들지 않는다(가짜는 받은 시각으로 거른다)", async () => {
    const { client } = setUp({
      servers: [fakeServerReceipt({ readProgressMilliseconds: NOW })],
      entries: [
        fakeReceivedEntry({ receivedMilliseconds: T - MINUTE, requestsDropped: 100, missing: ["old-nginx:rotated"] }),
        fakeReceivedEntry({ receivedMilliseconds: T + 6 * MINUTE, requestsDropped: 4, requestsRejected: 2, missing: ["backend-nginx:rotated"] }),
        fakeReceivedEntry({ receivedMilliseconds: NOW, requestsDropped: 1000 }),
      ],
    });
    const [receipt] = okValue(okValue(await buildRequestSpans(client, TRACE_REQUEST_ID, logLines(), NOW)).receipt);
    expect(receipt).toMatchObject({ server: "ci-agent-158", requestsDropped: 4, requestsRejected: 2, missing: ["backend-nginx:rotated"] });
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
