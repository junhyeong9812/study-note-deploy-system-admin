import { describe, expect, it, vi } from "vitest";
import { createAlertClient } from "@/features/auth/lib/alert-client";
import { createFakeFetch, jsonResponse, type FetchStep } from "@/features/auth/lib/test-fakes";

const BASE_URL = "http://alert.example.test:16000";
const SECRET = "fake-alert-secret";
const LOCKED_UNTIL = "2026-01-01T00:15:00.000Z";

function client(steps: FetchStep[]) {
  const fetch = createFakeFetch(steps);
  const timeoutSignal = vi.fn((_milliseconds: number) => new AbortController().signal);
  return { fetch, timeoutSignal, alert: createAlertClient({ baseUrl: BASE_URL, secret: SECRET, fetch, timeoutSignal }) };
}

describe("알림 서버 — 잠금 이벤트", () => {
  it("POST /events · X-Alert-Secret · key 에 locked_until · 알림 서버 형식에 맞는 본문", async () => {
    const { fetch, timeoutSignal, alert } = client([jsonResponse({ success: true, data: { sent: true } }, 202)]);
    expect(await alert.sendLoginLocked(LOCKED_UNTIL)).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/events`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-Alert-Secret")).toBe(SECRET);
    const body = JSON.parse(String(init.body));
    expect(body.source).toMatch(/^[a-z0-9-]{1,40}$/);          // 알림 서버 AlertController 검증 규칙
    expect(body.kind).toMatch(/^[a-z0-9_]{1,40}$/);
    expect(["info", "warning", "critical"]).toContain(body.severity);
    expect(typeof body.title).toBe("string");
    expect(body.title.trim().length).toBeGreaterThan(0);
    expect(body.key).toContain(LOCKED_UNTIL);
    expect(body.key.length).toBeLessThanOrEqual(120);
    expect(timeoutSignal).toHaveBeenCalledWith(5000);
  });

  it("잠금 시각이 다르면 key 가 다르다(재전송이 겹치지 않게)", async () => {
    const { fetch, alert } = client([jsonResponse({}, 202), jsonResponse({}, 202)]);
    await alert.sendLoginLocked(LOCKED_UNTIL);
    await alert.sendLoginLocked("2026-01-01T01:15:00.000Z");
    const keys = fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)).key);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it.each([
    ["연결 실패", () => new TypeError("fetch failed") as FetchStep],
    ["401", () => jsonResponse({ success: false }, 401) as FetchStep],
    ["500", () => jsonResponse({ success: false }, 500) as FetchStep],
  ])("실패(%s)는 false — 예외를 밖으로 내지 않는다", async (_label, makeStep) => {
    const { alert } = client([makeStep(), makeStep()]);
    await expect(alert.sendLoginLocked(LOCKED_UNTIL)).resolves.toBe(false);
  });
});
