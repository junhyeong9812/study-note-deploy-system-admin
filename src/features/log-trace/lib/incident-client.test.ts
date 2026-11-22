/** 알림 서버 알림 기록 클라이언트 — 명세 §11.2 "앞뒤 30분 안의 알림 기록(알림 서버 /incidents)" · ② "상태 코드와 짧은 사유만" · "필요한 칸만" · 세부 5 "장애 사유는 가려서" ·
 * "각각 5초" · 읽기 전용. 계약 = alert AlertController.kt:96-106 · incident/IncidentStore.kt:84-87. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INCIDENT_LIST_MAXIMUM_LIMIT, createIncidentClient } from "@/features/log-trace/lib/incident-client";
import { alertIncident, alertIncidentsBody } from "@/features/log-trace/lib/log-trace-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_OBSERVE_URL, UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal, expectFailure,
  expectNoForbiddenText, expectReadOnlyRequest, hangUntilAborted, headersOf, headersThenStalledBody, jsonBody, leakyErrorBody,
  leakyNetworkError, okValue, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";

const ALERT_MAX_LIMIT = 200;   // AlertController.kt:101 coerceIn(1, 200)

function client(fetch: ReturnType<typeof createRoutedFetch>, timeoutSignal?: (milliseconds: number) => AbortSignal) {
  return createIncidentClient({ baseUrl: FAKE_ALERT_URL, secret: FAKE_ALERT_SECRET, fetch, timeoutSignal });
}

describe("createIncidentClient — 요청", () => {
  it("GET <base>/incidents?limit=<n> · X-Alert-Secret · redirect manual · 본문 없음 · 다른 비밀 헤더 없음", async () => {
    const fetch = createRoutedFetch(() => alertIncidentsBody([alertIncident()]));
    await createIncidentClient({ baseUrl: `${FAKE_ALERT_URL}/`, secret: FAKE_ALERT_SECRET, fetch }).listIncidents(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.origin).toBe(new URL(FAKE_ALERT_URL).origin);
    expect(url.pathname).toBe("/incidents");
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "200" });
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("X-Alert-Secret")).toBe(FAKE_ALERT_SECRET);
    expect(headersOf(init).has("X-Observe-Secret")).toBe(false);
    expect(headersOf(init).has("X-Deploy-Secret")).toBe(false);
    expect(init?.redirect).toBe("manual");
  });

  it("상한은 알림 서버와 같다", () => {
    expect(INCIDENT_LIST_MAXIMUM_LIMIT).toBe(ALERT_MAX_LIMIT);
  });

  it.each([0, -1, 201, 1.5, Number.NaN])("limit %d → 호출하지 않고 invalid_input(limit)", async (limit) => {
    const fetch = createRoutedFetch(() => alertIncidentsBody([]));
    const result = await client(fetch).listIncidents(limit);
    expectFailure(result, "invalid_input");
    expect(!result.ok && result.field).toBe("limit");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("제한 시간 신호를 5000ms 로", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch(() => alertIncidentsBody([]));
    await client(fetch, timeout.factory).listIncidents(1);
    expect(timeout.requestedMilliseconds).toEqual([5_000]);
  });
});

describe("createIncidentClient — 응답 칸 선택", () => {
  it("at · kind · key · title · deliveredBy · suppressed 만, 순서 그대로(detail · 계약 밖 칸 없음)", async () => {
    const rows = [
      alertIncident({ at: "2026-11-22T09:55:00Z", kind: "event", key: "admin:lock", title: "로그인 잠금", delivered_by: "", suppressed: true, extra: UPSTREAM_RAW_MARKER }),
      alertIncident(),
    ];
    const fetch = createRoutedFetch(() => alertIncidentsBody(rows));
    const incidents = okValue(await client(fetch).listIncidents(200));
    expect(incidents).toStrictEqual([
      { at: "2026-11-22T09:55:00Z", kind: "event", key: "admin:lock", title: "로그인 잠금", deliveredBy: null, suppressed: true },
      { at: "2026-11-22T09:50:00.123456Z", kind: "monitor_down", key: "front", title: "front DOWN", deliveredBy: "telegram", suppressed: false },
    ]);
    expectNoForbiddenText(incidents);
    expect(JSON.stringify(incidents)).not.toContain("connection refused");
  });

  it("빈 목록 → ok []", async () => {
    const fetch = createRoutedFetch(() => alertIncidentsBody([]));
    expect(okValue(await client(fetch).listIncidents(200))).toEqual([]);
  });

  it("모르는 kind 낱말도 그대로 넘긴다(열거로 거절하지 않는다)", async () => {
    const fetch = createRoutedFetch(() => alertIncidentsBody([alertIncident({ kind: "brand_new_kind" })]));
    expect(okValue(await client(fetch).listIncidents(200))[0].kind).toBe("brand_new_kind");
  });

  it("key · title 의 주소 꼴은 가리고 줄바꿈은 공백으로", async () => {
    const fetch = createRoutedFetch(() => alertIncidentsBody([
      alertIncident({ key: `${FAKE_OBSERVE_URL}/health`, title: `observe DOWN\n10.0.0.5:9200 닿지 않음` }),
    ]));
    const [incident] = okValue(await client(fetch).listIncidents(200));
    expect(incident.key).toBe("(주소)/health");
    expect(incident.title).toBe("observe DOWN (주소) 닿지 않음");
    expectNoForbiddenText(incident);
  });

  it("title 이 120자를 넘으면 120자로", async () => {
    const fetch = createRoutedFetch(() => alertIncidentsBody([alertIncident({ title: "가".repeat(200) })]));
    expect(okValue(await client(fetch).listIncidents(200))[0].title).toBe("가".repeat(120));
  });

  const malformed: [string, Record<string, unknown>][] = [
    ["at 빠짐", { at: undefined }],
    ["at 이 시각이 아님", { at: "yesterday" }],
    ["at 이 숫자", { at: 1763805600000 }],
    ["kind 가 숫자", { kind: 3 }],
    ["key 빠짐", { key: undefined }],
    ["title 이 null", { title: null }],
    ["delivered_by 가 숫자", { delivered_by: 1 }],
    ["suppressed 가 글자", { suppressed: "false" }],
  ];

  it.each(malformed)("%s → 전체 unparseable", async (_label, overrides) => {
    const row = alertIncident(overrides);
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete row[key];
    const fetch = createRoutedFetch(() => alertIncidentsBody([alertIncident(), row]));
    expectFailure(await client(fetch).listIncidents(200), "unparseable");
  });

  it.each([
    ["봉투 아님", () => jsonBody({ incidents: [] })],
    ["success false", () => jsonBody({ success: false, data: { incidents: [] } })],
    ["incidents 가 객체", () => jsonBody({ success: true, data: { incidents: { a: 1 } } })],
    ["JSON 아님", () => textResponse(`<html>${UPSTREAM_RAW_MARKER}</html>`, 200, "text/html")],
  ] as const)("%s → unparseable", async (_label, makeResponse) => {
    const fetch = createRoutedFetch(() => makeResponse());
    expectFailure(await client(fetch).listIncidents(200), "unparseable");
  });
});

describe("createIncidentClient — 알림 서버의 오류를 화면용 짧은 사유로", () => {
  it.each([
    [401, "unauthorized"], [503, "unavailable"], [422, "invalid_request"], [400, "bad_status"], [500, "bad_status"], [302, "bad_status"],
  ] as const)("HTTP %i → %s, 원문 · 비밀값 · 주소 없음", async (status, reason) => {
    const fetch = createRoutedFetch(() => textResponse(leakyErrorBody(), status));
    expectFailure(await client(fetch).listIncidents(200), reason, status);
  });

  it("알림 서버의 실제 503 꼴(history_unavailable) → unavailable", async () => {
    const fetch = createRoutedFetch(() => jsonBody({ success: false, error: { code: "history_unavailable" } }, 503));
    const result = await client(fetch).listIncidents(200);
    expectFailure(result, "unavailable", 503);
    expect(JSON.stringify(result)).not.toContain("history_unavailable");
  });

  it("연결 실패 → unreachable", async () => {
    const fetch = createRoutedFetch(() => Promise.reject(leakyNetworkError()));
    expectFailure(await client(fetch).listIncidents(200), "unreachable");
  });
});

describe("createIncidentClient — 5초 기한(가짜 타이머) · 재시도 없음", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ["응답하지 않음", (init: RequestInit) => hangUntilAborted(init)],
    ["본문이 끝나지 않음", (init: RequestInit) => Promise.resolve(headersThenStalledBody(init))],
  ] as const)("%s → 5초에 timeout, 호출 1회", async (_label, behave) => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((_url, init) => behave(init));
    const pending = track(client(fetch, timeout.factory).listIncidents(200));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expectFailure(pending.value!, "timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
