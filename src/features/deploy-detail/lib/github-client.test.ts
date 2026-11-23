/** GitHub 클라이언트 · 캐시 — 명세 §10.2 "호출마다 5초 제한, 재시도 없음" · "PR 본문은 글자 그대로" · "PR 조회는 10분" · "GITHUB_TOKEN 은 선택" ·
 * 읽기 전용(GET 만) · 다른 서버의 응답은 필요한 칸만. §10.3 — 커밋 목록 · diff 는 master git 조회로 옮겼다(deploy-git-client.test). GitHub 에는 PR 만 남는다. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_API_BASE_URL, choosePullRequest, createGitHubClient, type GitHubClient, type PullRequestSummary,
} from "@/features/deploy-detail/lib/github-client";
import { PULL_REQUEST_CACHE_MILLISECONDS, createCachedGitHubClient } from "@/features/deploy-detail/lib/github-cache";
import {
  FAKE_GITHUB_API_URL, FAKE_GITHUB_TOKEN, REPOSITORY_WEB, TEST_REPOSITORY, fakeSha, githubPullRequest, githubResponse, rateLimitedResponse,
} from "@/features/deploy-detail/lib/github-test-fakes";
import { UPSTREAM_FAILURE_MESSAGES } from "@/shared/lib/upstream-result";
import {
  UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal, expectFailure, expectNoForbiddenText, expectReadOnlyRequest,
  hangUntilAborted, headersOf, headersThenStalledBody, leakyNetworkError, okValue, track, type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const SHA_A = fakeSha(1);
const SHA_B = fakeSha(2);
const FORBIDDEN = [UPSTREAM_RAW_MARKER, FAKE_GITHUB_TOKEN, "github-api.example.test"];

function clientWith(handler: RoutedFetchHandler, token: string | null = null) {
  const fetch = createRoutedFetch(handler);
  const client = createGitHubClient({ baseUrl: FAKE_GITHUB_API_URL, token, fetch });
  return { fetch, client };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("요청 — 경로 · 머리글 · 읽기 전용", () => {
  it("실제 기준 주소 상수는 api.github.com", () => {
    expect(GITHUB_API_BASE_URL).toBe("https://api.github.com");
  });

  it("PR: GET <base>/repos/{owner}/{repo}/commits/{sha}/pulls · 쪽 나눔 인자 없음 · Accept · API 버전 · redirect manual(끝의 / 허용)", async () => {
    const fetch = createRoutedFetch(() => githubResponse([]));
    const client = createGitHubClient({ baseUrl: `${FAKE_GITHUB_API_URL}/`, token: null, fetch });
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(input);
    expect(url.origin).toBe(FAKE_GITHUB_API_URL);
    expect(url.pathname).toBe(`/repos/junhyeong9812/study-note-deploy-system-backend/commits/${SHA_B}/pulls`);
    expect([...url.searchParams]).toEqual([]);
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("Accept")).toBe("application/vnd.github+json");
    expect(headersOf(init).get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(init?.redirect).toBe("manual");
  });

  it("토큰이 있으면 Authorization: Bearer <토큰>", async () => {
    const { fetch, client } = clientWith(() => githubResponse([]), FAKE_GITHUB_TOKEN);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(headersOf(fetch.mock.calls[0][1]).get("Authorization")).toBe(`Bearer ${FAKE_GITHUB_TOKEN}`);
  });

  it.each([null, ""])("토큰이 %j 면 Authorization 을 싣지 않는다", async (token) => {
    const { fetch, client } = clientWith(() => githubResponse([]), token);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(headersOf(fetch.mock.calls[0][1]).has("Authorization")).toBe(false);
  });

  it("다른 서버의 비밀 머리글은 싣지 않는다", async () => {
    const { fetch, client } = clientWith(() => githubResponse([]), FAKE_GITHUB_TOKEN);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    const headers = headersOf(fetch.mock.calls[0][1]);
    for (const name of ["X-Deploy-Secret", "X-Observe-Secret", "X-Alert-Secret", "Cookie"]) expect(headers.has(name)).toBe(false);
  });

  it("제한 시간 신호를 5000ms 로 만들어 넘긴다", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch(() => githubResponse([]));
    const client = createGitHubClient({ baseUrl: FAKE_GITHUB_API_URL, token: null, fetch, timeoutSignal: timeout.factory });
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(timeout.requestedMilliseconds).toEqual([5_000]);
    expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["abcdef", "g".repeat(40), "a".repeat(41), `${SHA_A}/../x`, `${SHA_A}...${SHA_B}`, ""])("SHA 인자 %j 가 형식 밖이면 부르지 않는다(invalid_input sha)", async (sha) => {
    const { fetch, client } = clientWith(() => githubResponse([]));
    const result = await client.listPullRequestsForCommit(TEST_REPOSITORY, sha);
    expectFailure(result, "invalid_input");
    expect(!result.ok && result.field).toBe("sha");
    expect(fetch).toHaveBeenCalledTimes(0);
  });
});

describe("PR — 필요한 칸만 · 병합된 것 우선", () => {
  it("번호 · 제목 · 본문(글자 그대로) · 상태 · 병합 시각 · 주소만", async () => {
    const body = "## 제목\r\n<img src=x onerror=alert(1)>\n- [ ] 할 일";
    const { client } = clientWith(() => githubResponse([githubPullRequest(12, { body, title: "<b>feat</b>" })]));
    const pullRequests = okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B));
    expect(pullRequests).toStrictEqual([{
      number: 12, title: "<b>feat</b>", body, state: "closed", mergedAt: "2026-11-22T00:00:00Z", htmlUrl: `${REPOSITORY_WEB}/pull/12`,
    }]);
    expectNoForbiddenText(pullRequests, FORBIDDEN);
  });

  it("PR 없음 — 빈 목록", async () => {
    const { client } = clientWith(() => githubResponse([]));
    expect(okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B))).toEqual([]);
  });

  it("본문이 null 이면 null · 병합 안 됐으면 mergedAt null", async () => {
    const { client } = clientWith(() => githubResponse([githubPullRequest(3, { body: null, merged_at: null, state: "open" })]));
    const [pullRequest] = okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B));
    expect(pullRequest.body).toBeNull();
    expect(pullRequest.mergedAt).toBeNull();
    expect(pullRequest.state).toBe("open");
  });

  it.each([
    ["배열이 아님", { message: "x" }],
    ["number 가 글자", [githubPullRequest(1, { number: "1" })]],
    ["state 가 열거 밖", [githubPullRequest(1, { state: "merged" })]],
    ["html_url 이 github.com 이 아님", [githubPullRequest(1, { html_url: "http://github.com.evil.example.test/pull/1" })]],
  ])("꼴이 다르면 unparseable — %s", async (_label, body) => {
    const { client } = clientWith(() => githubResponse(body));
    expectFailure(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B), "unparseable");
  });

  const open = (number: number): PullRequestSummary => ({ number, title: `t${number}`, body: null, state: "open", mergedAt: null, htmlUrl: `${REPOSITORY_WEB}/pull/${number}` });
  const merged = (number: number): PullRequestSummary => ({ ...open(number), state: "closed", mergedAt: "2026-11-22T00:00:00Z" });

  it("choosePullRequest — 여럿이면 병합된 것 우선(GitHub 순서의 첫 병합)", () => {
    expect(choosePullRequest([open(1), merged(2), merged(3)])?.number).toBe(2);
  });

  it("choosePullRequest — 병합된 것이 없으면 첫 번째 · 빈 목록이면 null", () => {
    expect(choosePullRequest([open(5), open(6)])?.number).toBe(5);
    expect(choosePullRequest([])).toBeNull();
  });
});

describe("실패 — 한도 초과 · 없는 SHA · 5xx · 리다이렉트 · 깨진 JSON · 연결 실패 · 시간 초과(재시도 없음)", () => {
  type Call = (client: GitHubClient) => Promise<{ ok: boolean }>;
  const calls: [string, Call][] = [
    ["pulls", (client) => client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B)],
  ];

  for (const [name, call] of calls) {
    it.each([403, 429] as const)(`${name}: %d + x-ratelimit-remaining: 0 → rate_limited(한 번만 부른다)`, async (status) => {
      const { fetch, client } = clientWith(() => rateLimitedResponse(status), FAKE_GITHUB_TOKEN);
      const result = await call(client) as Parameters<typeof expectFailure>[0];
      expectFailure(result, "rate_limited", status);
      expect(!result.ok && result.message).toBe("한도 초과");
      expectNoForbiddenText(result, FORBIDDEN);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${name}: 403 + retry-after(2차 한도) → rate_limited`, async () => {
      const { client } = clientWith(() => githubResponse({ message: "secondary" }, 403, { "retry-after": "60" }));
      expectFailure(await call(client) as Parameters<typeof expectFailure>[0], "rate_limited", 403);
    });

    it(`${name}: 한도 머리글 없는 403 → bad_status(한도 초과가 아니다)`, async () => {
      const { client } = clientWith(() => githubResponse({ message: `forbidden ${UPSTREAM_RAW_MARKER}` }, 403));
      expectFailure(await call(client) as Parameters<typeof expectFailure>[0], "bad_status", 403);
    });

    it.each([404, 422])(`${name}: %d(없는 SHA · 저장소) → not_found`, async (status) => {
      const { client } = clientWith(() => githubResponse({ message: `No commit found for SHA: ${UPSTREAM_RAW_MARKER}` }, status));
      const result = await call(client) as Parameters<typeof expectFailure>[0];
      expectFailure(result, "not_found", status);
      expect(!result.ok && result.message).toBe("찾을 수 없음");
    });

    it.each([
      [500, "bad_status"], [502, "bad_status"], [503, "unavailable"], [504, "server_timeout"], [401, "unauthorized"],
    ])(`${name}: %d → %s(원문 없음, 재시도 없음)`, async (status, reason) => {
      const { fetch, client } = clientWith(() => githubResponse(`<html>${UPSTREAM_RAW_MARKER} ${FAKE_GITHUB_TOKEN}</html>`, status), FAKE_GITHUB_TOKEN);
      const result = await call(client) as Parameters<typeof expectFailure>[0];
      expectFailure(result, reason, status);
      expectNoForbiddenText(result, FORBIDDEN);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([301, 302, 307])(`${name}: 리다이렉트 %d → 따라가지 않고 bad_status`, async (status) => {
      const { fetch, client } = clientWith(() => new Response(null, { status, headers: { location: "https://evil.example.test/repos" } }));
      expectFailure(await call(client) as Parameters<typeof expectFailure>[0], "bad_status", status);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${name}: 깨진 JSON → unparseable`, async () => {
      const { client } = clientWith(() => githubResponse(`{"sha":"${UPSTREAM_RAW_MARKER}`));
      expectFailure(await call(client) as Parameters<typeof expectFailure>[0], "unparseable");
    });

    it(`${name}: 연결 실패 → unreachable(예외 문구 없음)`, async () => {
      const { fetch, client } = clientWith(() => { throw leakyNetworkError(); });
      expectFailure(await call(client) as Parameters<typeof expectFailure>[0], "unreachable");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${name}: 응답하지 않으면 5초에 timeout(재시도 없음)`, async () => {
      vi.useFakeTimers();
      const timeout = createTimerTimeoutSignal();
      const fetch = createRoutedFetch((_url, init) => hangUntilAborted(init));
      const client = createGitHubClient({ baseUrl: FAKE_GITHUB_API_URL, token: null, fetch, timeoutSignal: timeout.factory });
      const pending = track(call(client));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(pending.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(pending.settled).toBe(true);
      expectFailure(pending.value as Parameters<typeof expectFailure>[0], "timeout");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${name}: 머리글만 주고 본문을 끝내지 않으면 5초에 timeout`, async () => {
      vi.useFakeTimers();
      const timeout = createTimerTimeoutSignal();
      const fetch = createRoutedFetch((_url, init) => headersThenStalledBody(init));
      const client = createGitHubClient({ baseUrl: FAKE_GITHUB_API_URL, token: null, fetch, timeoutSignal: timeout.factory });
      const pending = track(call(client));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pending.settled).toBe(true);
      expectFailure(pending.value as Parameters<typeof expectFailure>[0], "timeout");
    });
  }

  it("새 실패 이유의 화면 글자는 고정 표에 있고 비밀 · 주소가 없다", () => {
    expect(UPSTREAM_FAILURE_MESSAGES.rate_limited).toBe("한도 초과");
    expect(UPSTREAM_FAILURE_MESSAGES.not_found).toBe("찾을 수 없음");
    for (const message of Object.values(UPSTREAM_FAILURE_MESSAGES)) expectNoForbiddenText(message, FORBIDDEN);
  });
});

describe("캐시 — PR 10분 · 실패는 저장 안 함 · 상한", () => {
  function cachedClientWith(handler: RoutedFetchHandler, options: { maximumEntries?: number } = {}) {
    let now = 1_763_800_000_000;
    const fetch = createRoutedFetch(handler);
    const inner = createGitHubClient({ baseUrl: FAKE_GITHUB_API_URL, token: null, fetch });
    const client = createCachedGitHubClient(inner, { clock: () => now, ...options });
    return { fetch, client, advance: (milliseconds: number) => { now += milliseconds; } };
  }

  function defaultHandler(): Response {
    return githubResponse([githubPullRequest(12)]);
  }

  it("PR 캐시 수명 상수는 10분", () => {
    expect(PULL_REQUEST_CACHE_MILLISECONDS).toBe(600_000);
  });

  it("PR — 10분 안에는 적중, 10분이 되는 순간부터 다시 부른다", async () => {
    const { fetch, client, advance } = cachedClientWith(defaultHandler);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    advance(PULL_REQUEST_CACHE_MILLISECONDS - 1);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(1);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("PR 없음(빈 목록)도 성공이므로 10분 저장", async () => {
    const { fetch, client } = cachedClientWith(() => githubResponse([]));
    expect(okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B))).toEqual([]);
    expect(okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B))).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["한도 초과", () => rateLimitedResponse(403)],
    ["5xx", () => githubResponse("oops", 500)],
    ["깨진 JSON", () => githubResponse("{")],
    ["없는 SHA", () => githubResponse({ message: "No commit found" }, 422)],
  ])("실패(%s)는 저장하지 않는다 — 다음 요청이 다시 부르고, 성공하면 그때부터 저장", async (_label, makeFailure) => {
    let failing = true;
    const { fetch, client } = cachedClientWith(() => (failing ? makeFailure() : defaultHandler()));
    for (const call of [() => client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B)]) {
      failing = true;
      fetch.mockClear();
      expect((await call()).ok).toBe(false);
      failing = false;
      expect((await call()).ok).toBe(true);
      expect((await call()).ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("상한 — 항목 수가 넘으면 가장 오래된 것부터 버린다(PR 저장소)", async () => {
    const { fetch, client } = cachedClientWith(defaultHandler, { maximumEntries: 2 });
    for (const index of [1, 2, 3]) await client.listPullRequestsForCommit(TEST_REPOSITORY, fakeSha(index));
    await client.listPullRequestsForCommit(TEST_REPOSITORY, fakeSha(3));
    expect(fetch).toHaveBeenCalledTimes(3);
    await client.listPullRequestsForCommit(TEST_REPOSITORY, fakeSha(1));
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("캐시를 거쳐도 값은 원래 클라이언트와 같다(필요한 칸만)", async () => {
    const { client } = cachedClientWith(defaultHandler);
    const [pullRequest] = okValue(await client.listPullRequestsForCommit(TEST_REPOSITORY, SHA_B));
    expect(Object.keys(pullRequest).sort()).toEqual(["body", "htmlUrl", "mergedAt", "number", "state", "title"]);
  });
});
