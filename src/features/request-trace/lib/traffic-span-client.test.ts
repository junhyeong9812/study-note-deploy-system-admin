/** 관측 서버 통신 조회 클라이언트(T7) — 기존 관례(getUpstream: X-Observe-Secret · 5초 · GET 만 · 리다이렉트 따라가지 않음 · no-store) ·
 * 응답의 꼴(관측 서버 TrafficController.kt 의 실제 칸 — 고정 자료는 TrafficControllerTest.kt 가 고정한 한 벌) · 꼴이 틀리면 unparseable(칸을 0 · 빈 목록으로 메우지 않는다) ·
 * 오류 상태의 대응(401 · 422 · 503 · 504) · 원문을 넘기지 않음. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrafficSpanClient } from "@/features/request-trace/lib/traffic-span-client";
import {
  OBSERVE_SERVER_FIXTURE, OBSERVE_SPAN_FIXTURE, createFakeObserveTraffic, fakeServerReceipt, fakeSpan,
} from "@/features/request-trace/lib/traffic-span-test-fakes";
import {
  REAL_MAP_BODY, REAL_MAP_OLD_WINDOW_BODY, REAL_REQUESTS_BODY, REAL_REQUEST_ID,
} from "@/features/request-trace/lib/traffic-span-real-responses-test-fakes";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, SECRET_HEADER_NAMES, UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal, expectFailure,
  expectNoForbiddenText, expectReadOnlyRequest, hangUntilAborted, headersOf, jsonBody, leakyErrorBody, leakyNetworkError, okValue, textResponse,
  type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const REQUEST_ID = "req-0123456789ab";

function clientWith(handler: RoutedFetchHandler, timeoutSignal?: (milliseconds: number) => AbortSignal) {
  const fetch = createRoutedFetch(handler);
  return { fetch, client: createTrafficSpanClient({ baseUrl: `${FAKE_OBSERVE_URL}/`, secret: FAKE_OBSERVE_SECRET, fetch, timeoutSignal }) };
}

/** 고정 자료 한 벌을 그대로 돌려주는 관측 서버. */
function fixtureSpans(spans: Record<string, unknown>[] = [OBSERVE_SPAN_FIXTURE], extra: Record<string, unknown> = {}): RoutedFetchHandler {
  return () => jsonBody({ success: true, data: { request_id: REQUEST_ID, spans, truncated: false, ...extra } });
}

function fixtureServers(servers: Record<string, unknown>[] = [OBSERVE_SERVER_FIXTURE]): RoutedFetchHandler {
  return () => jsonBody({ success: true, data: { from: "2026-11-25T04:05:00Z", to: "2026-11-25T04:10:00Z", servers, edges: [] } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("구간 조회 — GET /traffic/requests?request_id=…", () => {
  it("부르는 법: 경로 · 인자 하나 · GET · 본문 없음 · no-store · redirect manual · 비밀값 머리글은 X-Observe-Secret 하나", async () => {
    const { fetch, client } = clientWith(fixtureSpans());
    okValue(await client.requestSpans(REQUEST_ID));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.origin).toBe(new URL(FAKE_OBSERVE_URL).origin);
    expect(url.pathname).toBe("/traffic/requests");
    expect([...url.searchParams]).toEqual([["request_id", REQUEST_ID]]);
    expectReadOnlyRequest(init);
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("manual");
    for (const name of SECRET_HEADER_NAMES) expect(headersOf(init).get(name)).toBe(name === "x-observe-secret" ? FAKE_OBSERVE_SECRET : null);
  });

  it("관측 서버의 고정 자료(TrafficControllerTest 의 한 줄)를 칸마다 그대로 읽는다 — 계약 밖 칸은 버린다", async () => {
    const { client } = clientWith(fixtureSpans([{ ...OBSERVE_SPAN_FIXTURE, extra: UPSTREAM_RAW_MARKER }], { extra: UPSTREAM_RAW_MARKER }));
    const page = okValue(await client.requestSpans(REQUEST_ID));
    expect(page).toEqual({
      truncated: false,
      spans: [{
        server: "ci-agent-158", service: "backend", caller: "front", method: "GET", path: "/api/doc", pathTruncated: false, status: 200,
        endAt: "2026-11-25T04:09:57Z", durationMilliseconds: 41, upstreamMilliseconds: null, upstreamStatus: "200", slot: "blue", bytesSent: 5120,
      }],
    });
    expectNoForbiddenText(page);
  });

  it("가짜 관측 서버(실제 규칙 흉내) — 차례는 관측 서버가 준 그대로(end_ms · 서비스순), 500 개 넘으면 truncated", async () => {
    const start = Date.UTC(2026, 10, 22, 10, 0, 0, 0);
    const fake = createFakeObserveTraffic({
      spans: Array.from({ length: 501 }, (_, index) => fakeSpan({ requestId: REQUEST_ID, endMilliseconds: start + index, service: index % 2 === 0 ? "front" : "backend" })),
    });
    const { client } = clientWith(fake.handler);
    const page = okValue(await client.requestSpans(REQUEST_ID));
    expect(page.truncated).toBe(true);
    expect(page.spans).toHaveLength(500);
    expect(page.spans[0].endAt).toBe("2026-11-22T10:00:00Z");
    expect(page.spans[1].endAt).toBe("2026-11-22T10:00:00.001Z");
  });

  it("구간이 없으면 빈 목록 · truncated 거짓(성공 — 실패와 다르다)", async () => {
    const { client } = clientWith(createFakeObserveTraffic().handler);
    expect(okValue(await client.requestSpans(REQUEST_ID))).toEqual({ spans: [], truncated: false });
  });

  it.each([
    ["upstream_ms 가 수", { upstream_ms: 40 }, { upstreamMilliseconds: 40 }],
    ["upstream_status · slot 이 null", { upstream_status: null, slot: null }, { upstreamStatus: null, slot: null }],
    ["경로가 빈 글자", { path: "" }, { path: "" }],
    ["path_truncated 참", { path_truncated: true }, { pathTruncated: true }],
    ["시각에 밀리초", { end_at: "2026-11-25T04:09:57.123Z" }, { endAt: "2026-11-25T04:09:57.123Z" }],
    ["걸린 시간 0ms", { duration_ms: 0 }, { durationMilliseconds: 0 }],
    ["부른 쪽 edge", { caller: "edge" }, { caller: "edge" }],
    ["상태 499", { status: 499 }, { status: 499 }],
  ])("받는 꼴: %s", async (_label, change, expected) => {
    const { client } = clientWith(fixtureSpans([{ ...OBSERVE_SPAN_FIXTURE, ...change }]));
    expect(okValue(await client.requestSpans(REQUEST_ID)).spans[0]).toMatchObject(expected);
  });

  const withoutField = (field: string) => Object.fromEntries(Object.entries(OBSERVE_SPAN_FIXTURE).filter(([name]) => name !== field));
  it.each([
    ...Object.keys(OBSERVE_SPAN_FIXTURE).map((field) => [`칸 빠짐 ${field}`, [withoutField(field)]] as const),
    ["duration_ms 가 글자", [{ ...OBSERVE_SPAN_FIXTURE, duration_ms: "41" }]],
    ["duration_ms 가 음수", [{ ...OBSERVE_SPAN_FIXTURE, duration_ms: -1 }]],
    ["duration_ms 가 소수", [{ ...OBSERVE_SPAN_FIXTURE, duration_ms: 4.5 }]],
    ["upstream_ms 가 글자", [{ ...OBSERVE_SPAN_FIXTURE, upstream_ms: "0.040" }]],
    ["status 가 글자", [{ ...OBSERVE_SPAN_FIXTURE, status: "200" }]],
    ["end_at 이 수", [{ ...OBSERVE_SPAN_FIXTURE, end_at: 1764043797000 }]],
    ["end_at 이 시각 아님", [{ ...OBSERVE_SPAN_FIXTURE, end_at: "어제" }]],
    ["path_truncated 가 글자", [{ ...OBSERVE_SPAN_FIXTURE, path_truncated: "false" }]],
    ["서비스 이름에 태그", [{ ...OBSERVE_SPAN_FIXTURE, service: "<b>backend</b>" }]],
    ["호출자에 주소", [{ ...OBSERVE_SPAN_FIXTURE, caller: "10.0.0.5" }]],
    ["서버 이름에 태그", [{ ...OBSERVE_SPAN_FIXTURE, server: "<img src=x>" }]],
    ["줄이 객체 아님", ["backend"]],
    ["null 줄", [null]],
  ] as const)("꼴이 틀리면 unparseable — %s(0 · 빈 목록으로 메우지 않는다)", async (_label, spans) => {
    const { client } = clientWith(fixtureSpans(spans as unknown as Record<string, unknown>[]));
    expectFailure(await client.requestSpans(REQUEST_ID), "unparseable");
  });

  it.each([
    ["spans 빠짐", { request_id: REQUEST_ID, truncated: false }],
    ["spans 가 객체", { request_id: REQUEST_ID, spans: {}, truncated: false }],
    ["truncated 빠짐", { request_id: REQUEST_ID, spans: [] }],
    ["truncated 가 글자", { request_id: REQUEST_ID, spans: [], truncated: "false" }],
    ["request_id 가 물은 것과 다름", { request_id: "req-ffffffffffff", spans: [], truncated: false }],
  ])("봉투 안이 틀리면 unparseable — %s", async (_label, data) => {
    const { client } = clientWith(() => jsonBody({ success: true, data }));
    expectFailure(await client.requestSpans(REQUEST_ID), "unparseable");
  });

  it.each([
    ["JSON 아님", () => textResponse(`{${leakyErrorBody()}`)],
    ["success 가 거짓인 200", () => jsonBody({ success: false, data: { request_id: REQUEST_ID, spans: [], truncated: false } })],
    ["data 없음", () => jsonBody({ success: true })],
  ] as const)("2xx 인데 봉투가 틀리면 unparseable — %s", async (_label, respond) => {
    const { client } = clientWith(() => respond());
    expectFailure(await client.requestSpans(REQUEST_ID), "unparseable");
  });

  it.each([
    [401, "unauthorized"], [422, "invalid_request"], [503, "unavailable"], [504, "server_timeout"], [500, "bad_status"], [404, "bad_status"], [302, "bad_status"],
  ] as const)("HTTP %s → %s(상태 함께 · 원문 없음)", async (status, reason) => {
    const { client } = clientWith(() => textResponse(leakyErrorBody(), status));
    expectFailure(await client.requestSpans(REQUEST_ID), reason, status);
  });

  it("닿지 않음(예외 문구에 주소 · 비밀값) → unreachable, 원문 없음", async () => {
    const { client } = clientWith(() => Promise.reject(leakyNetworkError()));
    expectFailure(await client.requestSpans(REQUEST_ID), "unreachable");
  });

  it("5초 안에 응답하지 않으면 timeout — 기한은 5000ms 하나", async () => {
    vi.useFakeTimers();
    const timer = createTimerTimeoutSignal();
    const { client } = clientWith((_url, init) => hangUntilAborted(init), timer.factory);
    const pending = client.requestSpans(REQUEST_ID);
    await vi.advanceTimersByTimeAsync(5_000);
    expectFailure(await pending, "timeout");
    expect(timer.requestedMilliseconds).toEqual([5_000]);
  });

  it("요청 ID 는 인자로만 — 글자를 인코딩해 싣는다(점 · 밑줄 · 하이픈)", async () => {
    const { fetch, client } = clientWith(createFakeObserveTraffic().handler);
    await client.requestSpans("a.b_c-d");
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("request_id")).toBe("a.b_c-d");
  });
});

describe("수신 상태 — GET /traffic/map?from=&to= 의 servers[]", () => {
  it("부르는 법: 경로 · 인자 from · to(받은 글자 그대로, 이 차례) · 같은 관례", async () => {
    const { fetch, client } = clientWith(fixtureServers());
    okValue(await client.serverReceipts("2026-11-25T04:05:00.000Z", "2026-11-25T04:10:00.000Z"));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.pathname).toBe("/traffic/map");
    expect([...url.searchParams]).toEqual([["from", "2026-11-25T04:05:00.000Z"], ["to", "2026-11-25T04:10:00.000Z"]]);
    expectReadOnlyRequest(init);
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("manual");
    for (const name of SECRET_HEADER_NAMES) expect(headersOf(init).get(name)).toBe(name === "x-observe-secret" ? FAKE_OBSERVE_SECRET : null);
  });

  it("관측 서버의 고정 자료(TrafficControllerTest 의 servers 한 항목)를 쓰는 칸만 읽는다 — edges · last_received_at · first_seq_seen 은 싣지 않는다", async () => {
    const { client } = clientWith(fixtureServers([{ ...OBSERVE_SERVER_FIXTURE, extra: UPSTREAM_RAW_MARKER }]));
    expect(okValue(await client.serverReceipts("2026-11-25T04:05:00.000Z", "2026-11-25T04:10:00.000Z"))).toEqual([{
      server: "ci-agent-158", readProgressAt: "2026-11-25T04:09:00Z", receiveDelayed: false, sequenceGaps: 1, missing: ["backend-nginx:rotated"],
      requestsDropped: 7, requestsRejected: 3,
    }]);
  });

  it("읽기 진도가 null 인 서버(아직 진도가 없다)도 그대로 — 빈 servers 는 빈 목록", async () => {
    const fake = createFakeObserveTraffic({ servers: [fakeServerReceipt({ server: "ci-agent-164", readProgressMilliseconds: null, firstSeqSeen: null })] });
    const { client } = clientWith(fake.handler);
    expect(okValue(await client.serverReceipts("2026-11-25T04:05:00.000Z", "2026-11-25T04:10:00.000Z"))).toEqual([{
      server: "ci-agent-164", readProgressAt: null, receiveDelayed: false, sequenceGaps: 0, missing: [], requestsDropped: 0, requestsRejected: 0,
    }]);
    const { client: emptyClient } = clientWith(createFakeObserveTraffic().handler);
    expect(okValue(await emptyClient.serverReceipts("2026-11-25T04:05:00.000Z", "2026-11-25T04:10:00.000Z"))).toEqual([]);
  });

  const withoutServerField = (field: string) => Object.fromEntries(Object.entries(OBSERVE_SERVER_FIXTURE).filter(([name]) => name !== field));
  it.each([
    ...["server", "read_progress_at", "receive_delayed", "sequence_gaps", "missing", "requests_dropped", "requests_rejected"]
      .map((field) => [`칸 빠짐 ${field}`, [withoutServerField(field)]] as const),
    ["read_progress_at 이 시각 아님", [{ ...OBSERVE_SERVER_FIXTURE, read_progress_at: "곧" }]],
    ["receive_delayed 가 글자", [{ ...OBSERVE_SERVER_FIXTURE, receive_delayed: "false" }]],
    ["requests_dropped 가 음수", [{ ...OBSERVE_SERVER_FIXTURE, requests_dropped: -1 }]],
    ["requests_rejected 가 글자", [{ ...OBSERVE_SERVER_FIXTURE, requests_rejected: "3" }]],
    ["sequence_gaps 가 소수", [{ ...OBSERVE_SERVER_FIXTURE, sequence_gaps: 0.5 }]],
    ["missing 이 글자", [{ ...OBSERVE_SERVER_FIXTURE, missing: "backend-nginx:rotated" }]],
    ["missing 안에 수", [{ ...OBSERVE_SERVER_FIXTURE, missing: [1] }]],
  ] as const)("꼴이 틀리면 unparseable — %s", async (_label, servers) => {
    const { client } = clientWith(fixtureServers(servers as unknown as Record<string, unknown>[]));
    expectFailure(await client.serverReceipts("2026-11-25T04:05:00.000Z", "2026-11-25T04:10:00.000Z"), "unparseable");
  });

  it("servers 빠짐 → unparseable(빈 목록 = '모두 다 들어옴'으로 읽히지 않게)", async () => {
    const { client } = clientWith(() => jsonBody({ success: true, data: { from: "x", to: "y", edges: [] } }));
    expectFailure(await client.serverReceipts("2026-11-25T04:05:00.000Z", "2026-11-25T04:10:00.000Z"), "unparseable");
  });

  it.each([[401, "unauthorized"], [422, "invalid_request"], [503, "unavailable"], [504, "server_timeout"]] as const)("HTTP %s → %s", async (status, reason) => {
    const { client } = clientWith(() => textResponse(leakyErrorBody(), status));
    expectFailure(await client.serverReceipts("2026-11-25T04:05:00.000Z", "2026-11-25T04:10:00.000Z"), reason, status);
  });
});

describe("실제 관측 서버의 응답(T7 리뷰가 실제 PostgreSQL · Redis 로 받은 본문 그대로)", () => {
  it("구간 여섯 · 두 서버 — unparseable 없이 칸마다 그대로(시각의 소수 0 · 3자리 · null 셋 · 1024자 경로)", async () => {
    const { client } = clientWith(() => textResponse(REAL_REQUESTS_BODY));
    const page = okValue(await client.requestSpans(REAL_REQUEST_ID));
    expect(page.truncated).toBe(false);
    expect(page.spans.map((span) => [span.server, span.service, span.caller, span.status, span.endAt, span.durationMilliseconds, span.upstreamMilliseconds])).toEqual([
      ["ci-agent-llm.home", "ci-agent", "ci-master", 200, "2026-11-26T00:33:23.001Z", 12, null],
      ["ci-agent-llm.home", "llm-wrapper", "backend", 200, "2026-11-26T00:33:23.500Z", 900, 899],
      ["ci-agent-158", "backend", "front", 504, "2026-11-26T00:33:23.877Z", 0, 5],
      ["ci-agent-158", "backend", "front", 200, "2026-11-26T00:33:23.980Z", 1400, null],
      ["ci-agent-158", "front", "edge", 200, "2026-11-26T00:33:24Z", 1500, 1490],
      ["ci-agent-158", "front", "edge", 200, "2026-11-26T00:33:24.007Z", 9, 9],
    ]);
    expect(page.spans[2]).toMatchObject({ upstreamStatus: "502, 504", slot: "blue", path: "/api/fail" });
    expect(page.spans[0]).toMatchObject({ upstreamStatus: null, slot: null });
    expect(page.spans[5]).toMatchObject({ pathTruncated: true });
    expect(page.spans[5].path).toHaveLength(1024);
  });

  it("수신 상태 두 서버 — 기간 안의 missing · 버린 수와 누적 sequence_gaps 를 그대로", async () => {
    const { client } = clientWith(() => textResponse(REAL_MAP_BODY));
    expect(okValue(await client.serverReceipts("2026-11-26T00:24:44.000Z", "2026-11-26T00:35:44.000Z"))).toEqual([
      { server: "ci-agent-158", readProgressAt: "2026-11-26T00:34:04Z", receiveDelayed: false, sequenceGaps: 1, missing: ["backend-nginx:rotated"], requestsDropped: 3, requestsRejected: 0 },
      { server: "ci-agent-llm.home", readProgressAt: "2026-11-26T00:34:39Z", receiveDelayed: false, sequenceGaps: 0, missing: [], requestsDropped: 0, requestsRejected: 0 },
    ]);
  });

  it("20시간 전의 창에서도 sequence_gaps 는 1(기간과 무관한 누적) — missing · 버린 수는 0(기간에 묶임)", async () => {
    const { client } = clientWith(() => textResponse(REAL_MAP_OLD_WINDOW_BODY));
    const [first] = okValue(await client.serverReceipts("2026-11-25T04:34:44.000Z", "2026-11-25T05:34:44.000Z"));
    expect(first).toMatchObject({ server: "ci-agent-158", sequenceGaps: 1, missing: [], requestsDropped: 0 });
  });
});

describe("아주 큰 수(T7 리뷰 7) — 시각을 만들 수 없는 값은 unparseable(화면이 예외로 깨지지 않게)", () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  it.each([
    ["걸린 시간 7일 + 1ms", { duration_ms: WEEK + 1 }],
    ["걸린 시간 9000000000000000", { duration_ms: 9_000_000_000_000_000 }],
    ["upstream 7일 + 1ms", { upstream_ms: WEEK + 1 }],
    ["upstream 9000000000000000", { upstream_ms: 9_000_000_000_000_000 }],
  ])("%s → unparseable", async (_label, change) => {
    const { client } = clientWith(fixtureSpans([{ ...OBSERVE_SPAN_FIXTURE, ...change }]));
    expectFailure(await client.requestSpans(REQUEST_ID), "unparseable");
  });

  it("걸린 시간 · upstream 정확히 7일은 받는다(상한은 포함)", async () => {
    const { client } = clientWith(fixtureSpans([{ ...OBSERVE_SPAN_FIXTURE, duration_ms: WEEK, upstream_ms: WEEK }]));
    expect(okValue(await client.requestSpans(REQUEST_ID)).spans[0]).toMatchObject({ durationMilliseconds: WEEK, upstreamMilliseconds: WEEK });
  });

  it("바이트는 시각을 만들지 않으므로 상한 없이 받는다(정수이기만 하면)", async () => {
    const { client } = clientWith(fixtureSpans([{ ...OBSERVE_SPAN_FIXTURE, bytes_sent: 9_000_000_000_000_000 }]));
    expect(okValue(await client.requestSpans(REQUEST_ID)).spans[0].bytesSent).toBe(9_000_000_000_000_000);
  });
});
