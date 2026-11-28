/** 관측 서버 지도 조회 클라이언트(T8) — 기존 관례(getUpstream: X-Observe-Secret · 5초 · GET 만 · 리다이렉트 따라가지 않음 · no-store) ·
 * 응답의 꼴(TrafficController.kt 의 실제 칸 — 고정 자료는 실제 관측 서버의 응답 한 벌) · 꼴이 틀리면 unparseable(0 · 빈 목록으로 메우지 않는다) ·
 * 모르는 칸(주소)은 버린다 · 오류 상태의 대응 · 원문을 넘기지 않음. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrafficMapClient } from "@/features/traffic-map/lib/traffic-map-client";
import {
  LEAKED_ADDRESS, REAL_MAP_24H_BODY, createFakeObserveMap, fakeEdge, fakeMapServer, observeEdgeRow, observeMapServerRow,
} from "@/features/traffic-map/lib/traffic-map-test-fakes";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, SECRET_HEADER_NAMES, createRoutedFetch, createTimerTimeoutSignal, expectFailure, expectNoForbiddenText,
  expectReadOnlyRequest, hangUntilAborted, headersOf, jsonBody, leakyErrorBody, leakyNetworkError, okValue, textResponse, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const FROM = "2026-11-25T04:05:00.000Z";
const TO = "2026-11-25T04:10:00.000Z";

function clientWith(handler: RoutedFetchHandler, timeoutSignal?: (milliseconds: number) => AbortSignal) {
  const fetch = createRoutedFetch(handler);
  return { fetch, client: createTrafficMapClient({ baseUrl: `${FAKE_OBSERVE_URL}/`, secret: FAKE_OBSERVE_SECRET, fetch, timeoutSignal }) };
}

function answer(data: Record<string, unknown>): RoutedFetchHandler {
  return () => jsonBody({ success: true, data: { from: "2026-11-25T04:05:00Z", to: "2026-11-25T04:10:00Z", servers: [], edges: [], ...data } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("부르는 법", () => {
  it("GET /traffic/map?from=&to=(받은 글자 그대로, 이 차례) · 본문 없음 · no-store · redirect manual · 비밀값 머리글은 X-Observe-Secret 하나", async () => {
    const { fetch, client } = clientWith(createFakeObserveMap().handler);
    okValue(await client.trafficMap(FROM, TO));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.origin).toBe(new URL(FAKE_OBSERVE_URL).origin);
    expect(url.pathname).toBe("/traffic/map");
    expect([...url.searchParams]).toEqual([["from", FROM], ["to", TO]]);
    expectReadOnlyRequest(init);
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("manual");
    for (const name of SECRET_HEADER_NAMES) expect(headersOf(init).get(name)).toBe(name === "x-observe-secret" ? FAKE_OBSERVE_SECRET : null);
  });

  it("5초 안에 응답하지 않으면 timeout — 기한은 5000ms 하나", async () => {
    vi.useFakeTimers();
    const timer = createTimerTimeoutSignal();
    const { client } = clientWith((_url, init) => hangUntilAborted(init), timer.factory);
    const pending = client.trafficMap(FROM, TO);
    await vi.advanceTimersByTimeAsync(5_000);
    expectFailure(await pending, "timeout");
    expect(timer.requestedMilliseconds).toEqual([5_000]);
  });
});

describe("실제 관측 서버의 응답(t7-out/map_24h.json — 실제 PostgreSQL · Redis)", () => {
  it("칸마다 그대로 · 모르는 칸(last_received_at 등 아닌 것)은 없다", async () => {
    const { client } = clientWith(() => textResponse(REAL_MAP_24H_BODY));
    expect(okValue(await client.trafficMap("2026-11-25T00:34:44.000Z", "2026-11-26T00:34:44.000Z"))).toEqual({
      from: "2026-11-25T00:34:44Z", to: "2026-11-26T00:34:44Z",
      servers: [
        { server: "ci-agent-158", readProgressAt: "2026-11-26T00:34:04Z", receiveDelayed: false, sequenceGaps: 1, lastReceivedAt: "2026-11-26T00:34:45.056Z",
          missing: [], requestsDropped: 0, requestsRejected: 0, firstSeqSeen: 1 },
        { server: "ci-agent-llm.home", readProgressAt: "2026-11-26T00:34:39Z", receiveDelayed: false, sequenceGaps: 0, lastReceivedAt: "2026-11-26T00:34:45.056Z",
          missing: [], requestsDropped: 0, requestsRejected: 0, firstSeqSeen: 1 },
      ],
      edges: [{
        service: "backend", caller: "front", trafficClass: "request", count: 4, status: { "2xx": 4, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 },
        errorRate: 0, p50: { kind: "at_most", milliseconds: 50 }, p95: { kind: "at_most", milliseconds: 50 }, maxMilliseconds: 40, fillingCount: 0,
      }],
    });
  });
});

describe("가짜 관측 서버(실제 규칙 흉내)로", () => {
  it("선의 칸 — 분위수의 두 꼴(le_ms · gt_ms) · null(health · stream · 채워진 칸 0) · error_rate null · filling_count", async () => {
    const fake = createFakeObserveMap({ edges: [
      fakeEdge({ service: "backend", caller: "front", count: 20, status: { "2xx": 18, "3xx": 0, "4xx": 0, "5xx": 2, other: 0 }, p50: { le_ms: 5 }, p95: { gt_ms: 180000 }, maxMilliseconds: 200_000, fillingCount: 50 }),
      fakeEdge({ service: "observe", caller: "alert", trafficClass: "health", count: 0, status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 }, p50: null, p95: null, maxMilliseconds: null, fillingCount: 4 }),
    ] });
    const { client } = clientWith(fake.handler);
    expect(okValue(await client.trafficMap(FROM, TO)).edges).toEqual([
      { service: "backend", caller: "front", trafficClass: "request", count: 20, status: { "2xx": 18, "3xx": 0, "4xx": 0, "5xx": 2, other: 0 }, errorRate: 0.1,
        p50: { kind: "at_most", milliseconds: 5 }, p95: { kind: "over", milliseconds: 180000 }, maxMilliseconds: 200_000, fillingCount: 50 },
      { service: "observe", caller: "alert", trafficClass: "health", count: 0, status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 }, errorRate: null,
        p50: null, p95: null, maxMilliseconds: null, fillingCount: 4 },
    ]);
  });

  it("서버의 칸 — 진도 null · last_received_at null · first_seq_seen null 도 그대로", async () => {
    const fake = createFakeObserveMap({ servers: [fakeMapServer({ readProgressMilliseconds: null, receiveDelayed: true, lastReceivedMilliseconds: null, firstSeqSeen: null, sequenceGaps: 3, missing: ["backend-nginx:rotated"], requestsDropped: 7, requestsRejected: 2 })] });
    const { client } = clientWith(fake.handler);
    expect(okValue(await client.trafficMap(FROM, TO)).servers).toEqual([{
      server: "ci-agent-158", readProgressAt: null, receiveDelayed: true, sequenceGaps: 3, lastReceivedAt: null, missing: ["backend-nginx:rotated"],
      requestsDropped: 7, requestsRejected: 2, firstSeqSeen: null,
    }]);
  });

  it("모르는 칸(upstream_addr · remote_addr · extra)은 결과 어디에도 없다", async () => {
    const fake = createFakeObserveMap({ edges: [fakeEdge()], servers: [fakeMapServer()] });
    const { client } = clientWith(fake.handler);
    const snapshot = okValue(await client.trafficMap(FROM, TO));
    expect(JSON.stringify(snapshot)).not.toContain(LEAKED_ADDRESS);
    expectNoForbiddenText(snapshot);
  });

  it("선 · 서버가 없으면 빈 목록(성공 — 실패와 다르다)", async () => {
    const { client } = clientWith(createFakeObserveMap().handler);
    expect(okValue(await client.trafficMap(FROM, TO))).toMatchObject({ servers: [], edges: [] });
  });
});

describe("꼴이 틀리면 unparseable(0 · 빈 목록으로 메우지 않는다)", () => {
  const edge = observeEdgeRow(fakeEdge());
  const server = observeMapServerRow(fakeMapServer());
  const without = (row: Record<string, unknown>, field: string) => Object.fromEntries(Object.entries(row).filter(([name]) => name !== field));
  it.each([
    ...["service", "caller", "class", "count", "status", "error_rate", "p50", "p95", "max_ms", "filling_count"].map((field) => [`선의 칸 빠짐 ${field}`, { edges: [without(edge, field)] }] as const),
    ...["server", "read_progress_at", "receive_delayed", "sequence_gaps", "missing", "requests_dropped", "requests_rejected"].map((field) => [`서버의 칸 빠짐 ${field}`, { servers: [without(server, field)] }] as const),
    ["edges 빠짐", { edges: undefined }],
    ["servers 빠짐", { servers: undefined }],
    ["from 이 시각 아님", { from: "어제" }],
    ["모르는 갈래", { edges: [{ ...edge, class: "visit" }] }],
    ["count 가 글자", { edges: [{ ...edge, count: "20" }] }],
    ["count 가 음수", { edges: [{ ...edge, count: -1 }] }],
    ["status 의 열쇠 빠짐", { edges: [{ ...edge, status: { "2xx": 20, "3xx": 0, "4xx": 0, "5xx": 0 } }] }],
    ["p50 이 두 꼴 다", { edges: [{ ...edge, p50: { le_ms: 5, gt_ms: 180000 } }] }],
    ["p50 이 수", { edges: [{ ...edge, p50: 50 }] }],
    ["error_rate 가 1 초과", { edges: [{ ...edge, error_rate: 1.5 }] }],
    ["서비스 이름에 태그", { edges: [{ ...edge, service: "<b>x</b>" }] }],
    ["호출자에 주소", { edges: [{ ...edge, caller: LEAKED_ADDRESS }] }],
    ["서버 이름에 태그", { servers: [{ ...server, server: "<img src=x>" }] }],
    ["진도가 시각 아님", { servers: [{ ...server, read_progress_at: "곧" }] }],
    ["missing 안에 수", { servers: [{ ...server, missing: [1] }] }],
    ["선이 객체 아님", { edges: ["backend"] }],
  ] as const)("%s", async (_label, data) => {
    const { client } = clientWith(answer(data as Record<string, unknown>));
    expectFailure(await client.trafficMap(FROM, TO), "unparseable");
  });

  it.each([
    ["JSON 아님", () => textResponse(`{${leakyErrorBody()}`)],
    ["success 거짓인 200", () => jsonBody({ success: false, data: {} })],
    ["data 없음", () => jsonBody({ success: true })],
  ] as const)("봉투가 틀리면 — %s", async (_label, respond) => {
    const { client } = clientWith(() => respond());
    expectFailure(await client.trafficMap(FROM, TO), "unparseable");
  });
});

describe("오류", () => {
  it.each([[401, "unauthorized"], [422, "invalid_request"], [503, "unavailable"], [504, "server_timeout"], [500, "bad_status"], [302, "bad_status"]] as const)(
    "HTTP %s → %s(상태 함께 · 원문 없음)", async (status, reason) => {
      const { client } = clientWith(() => textResponse(leakyErrorBody(), status));
      expectFailure(await client.trafficMap(FROM, TO), reason, status);
    });

  it("관측 서버의 422(24시간 초과 — 오류 글에 주소)를 그대로 내지 않는다", async () => {
    const { client } = clientWith(createFakeObserveMap().handler);
    const result = await client.trafficMap("2026-11-25T00:34:43.999Z", "2026-11-26T00:34:44.000Z");
    expectFailure(result, "invalid_request", 422);
    expect(JSON.stringify(result)).not.toContain(LEAKED_ADDRESS);
  });

  it("닿지 않음(예외 문구에 주소 · 비밀값) → unreachable", async () => {
    const { client } = clientWith(() => Promise.reject(leakyNetworkError()));
    expectFailure(await client.trafficMap(FROM, TO), "unreachable");
  });
});
