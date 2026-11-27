/** ⑬ T4b — 부르는 쪽이 호출자 머리글을 덮어쓰지 못하고, 대소문자만 다른 이름으로 둘이 되지 않는다 — 나가는 요청에는 늘 정확히 하나 · `admin`.
 * 보이는 동작으로 본다: 공용 도우미 getUpstream 의 진입 · 직접 fetch 하는 클라이언트의 진입 · 도우미 withCallerService 자체(입력의 꼴 셋). */
import { describe, expect, it, vi } from "vitest";
import { createObserveClient } from "@/features/auth/lib/observe-client";
import { withCallerService } from "@/shared/lib/caller-service";
import { getUpstream } from "@/shared/lib/upstream-fetch";
import { FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, jsonBody } from "@/shared/lib/upstream-test-fakes";

const GIVEN: [string, Record<string, string>][] = [
  ["X-Caller-Service: front", { "X-Caller-Service": "front" }],
  ["x-caller-service: edge(소문자 이름)", { "x-caller-service": "edge" }],
  ["X-CALLER-SERVICE: backend(대문자 이름)", { "X-CALLER-SERVICE": "backend" }],
  ["빈 글자", { "X-Caller-Service": "" }],
  ["대소문자만 다른 이름 둘", { "X-Caller-Service": "front", "x-caller-service": "edge" }],
];

function recordingFetch() {
  const headers: Headers[] = [];
  const fetch = vi.fn(async (_input: string, init: RequestInit = {}) => {
    headers.push(new Headers(init.headers ?? {}));
    return jsonBody({ success: true, data: {} });
  });
  return { headers, fetch };
}

describe("getUpstream — 부르는 쪽이 준 호출자 머리글을 덮는다(정확히 하나 · admin)", () => {
  it.each(GIVEN)("%s", async (_label, given) => {
    const recorder = recordingFetch();
    await getUpstream(`${FAKE_OBSERVE_URL}/logs`, { fetch: recorder.fetch, headers: { "X-Observe-Secret": FAKE_OBSERVE_SECRET, ...given } });
    expect(recorder.headers).toHaveLength(1);
    expect(recorder.headers[0].get("x-caller-service")).toBe("admin");
    expect(recorder.headers[0].get("x-observe-secret")).toBe(FAKE_OBSERVE_SECRET);
  });

  it("ourService: false(바깥) — 이 머리글을 더하지 않고, 부르는 쪽이 준 그 밖의 머리글은 그대로", async () => {
    const recorder = recordingFetch();
    await getUpstream("https://api.github.com/repos/x/y/commits/z/pulls", {
      fetch: recorder.fetch, ourService: false, headers: { Authorization: "Bearer fake-github-token-marker", "X-GitHub-Api-Version": "2022-11-28" },
    });
    expect(recorder.headers[0].get("x-caller-service")).toBeNull();
    expect(recorder.headers[0].get("authorization")).toBe("Bearer fake-github-token-marker");
    expect(recorder.headers[0].get("x-github-api-version")).toBe("2022-11-28");
    expect(recorder.headers[0].get("accept")).toBe("application/json");
  });
});

describe("직접 fetch 하는 클라이언트의 진입 — 정확히 하나 · admin", () => {
  it("관측 서버의 로그인 판정(POST /auth/attempts)", async () => {
    const recorder = recordingFetch();
    await createObserveClient({ baseUrl: FAKE_OBSERVE_URL, secret: FAKE_OBSERVE_SECRET, fetch: recorder.fetch, clock: () => Date.UTC(2026, 10, 27) })
      .recordAttempt({ attempt_id: "44444444-4444-4444-8444-444444444444", at: "2026-11-27T00:00:00.000Z", credential_ok: true, ip: "198.51.100.77", user_agent: "FakeBrowser/1.0", replayed: false });
    for (const headers of recorder.headers) {
      expect(headers.get("x-caller-service")).toBe("admin");
      expect(headers.get("x-observe-secret")).toBe(FAKE_OBSERVE_SECRET);
    }
  });
});

describe("withCallerService — 입력의 꼴(객체 · Headers · 배열)과 상관없이 정확히 하나 · admin · 그 밖은 그대로", () => {
  it.each([
    ["객체", { Accept: "application/json", "x-caller-service": "front" }],
    ["Headers", new Headers({ Accept: "application/json", "X-CALLER-SERVICE": "edge" })],
    ["배열", [["Accept", "application/json"], ["X-Caller-Service", "front"], ["x-caller-service", "edge"]]],
  ] as [string, unknown][])("%s", (_label, input) => {
    const merged = withCallerService(input as Record<string, string>);
    expect(merged.get("x-caller-service")).toBe("admin");
    expect(merged.get("accept")).toBe("application/json");
    expect([...merged.keys()].filter((name) => name === "x-caller-service")).toHaveLength(1);
  });

  it("빈 입력에도 싣는다", () => {
    expect(withCallerService({}).get("x-caller-service")).toBe("admin");
  });
});
