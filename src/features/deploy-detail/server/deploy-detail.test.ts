/** 배포 상세 데이터 경로 — GET /api/deploys/detail(Route Handler → server/ 진입). 명세 ② 인증 경계 · §10.2.
 * 전역 fetch 를 가짜로 바꾼다(실제 master · GitHub 를 부르지 않는다 — GitHub 기준 주소 상수 api.github.com 도 가짜가 답한다).
 * 진입 모듈의 캐시가 사례 사이에 이어지지 않게 사례마다 모듈을 새로 읽는다(vi.resetModules). */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookieValue !== undefined && name === "admin_session" ? { name, value: state.cookieValue } : undefined),
    has: () => state.cookieValue !== undefined,
    getAll: () => [],
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import { SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  fakeSha, githubCommitObject, githubCommitWithFiles, githubComparison, githubFile, githubPullRequest, githubResponse, rateLimitedResponse,
} from "@/features/deploy-detail/lib/github-test-fakes";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, UPSTREAM_RAW_MARKER, createRoutedFetch, expectNoForbiddenText, headersOf, jsonBody,
  type RoutedFetchHandler,
} from "@/shared/lib/upstream-test-fakes";

const GITHUB_TOKEN_VALUE = "fake-github-token-marker-route-r85";
const SHA_A = fakeSha(1);
const SHA_MIDDLE = fakeSha(3);
const SHA_B = fakeSha(2);
const DETAIL_PATH = "/api/deploys/detail";
const REPOSITORY_PATH = "/repos/junhyeong9812/study-note-deploy-system-backend";

const ROWS = [
  { request_id: "selected-1", service: "backend", commit_sha: SHA_B, state: "succeeded", accepted_at: "2026-11-22T02:00:00Z",
    finished_at: "2026-11-22T02:05:00Z", ci_ms: 60000, cd_ms: 30000, detail: `${UPSTREAM_RAW_MARKER} build output` },
  { request_id: "previous-1", service: "backend", commit_sha: SHA_A, state: "succeeded", accepted_at: "2026-11-22T01:00:00Z",
    finished_at: "2026-11-22T01:05:00Z", ci_ms: 60000, cd_ms: 30000 },
];

let masterHandler: RoutedFetchHandler = () => jsonBody({ success: true, data: { deployments: ROWS } });
let githubHandler: RoutedFetchHandler = defaultGithubHandler;

function defaultGithubHandler(url: URL): Response {
  if (url.pathname.includes("/compare/")) return githubResponse(githubComparison(SHA_A, SHA_B, [githubCommitObject(SHA_MIDDLE), githubCommitObject(SHA_B)]));
  if (url.pathname.endsWith("/pulls")) return githubResponse([githubPullRequest(12)]);
  const sha = url.pathname.split("/").pop()!;
  return githubResponse(githubCommitWithFiles(sha, [githubFile("src/a.ts")]));
}

const networkFetch = createRoutedFetch((url, init) => {
  if (url.hostname === "api.github.com") return githubHandler(url, init);
  if (url.origin === new URL(FAKE_DEPLOY_MASTER_URL).origin) return masterHandler(url, init);
  throw new Error(`unexpected host ${url.hostname}`);
});

const consoleLines: string[] = [];

function githubCalls() {
  return networkFetch.mock.calls.filter(([input]) => new URL(input).hostname === "api.github.com");
}

function masterCalls() {
  return networkFetch.mock.calls.filter(([input]) => new URL(input).origin === new URL(FAKE_DEPLOY_MASTER_URL).origin);
}

async function callDetail(search: string): Promise<Response> {
  const route = await import("@/app/api/deploys/detail/route");
  return route.GET(new Request(new URL(`${DETAIL_PATH}${search}`, FAKE_ORIGIN)));
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("LOG_REDIS_URL", "");
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  masterHandler = () => jsonBody({ success: true, data: { deployments: ROWS } });
  githubHandler = defaultGithubHandler;
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  consoleLines.length = 0;
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("인증 경계", () => {
  it.each([
    ["쿠키 없음", () => undefined],
    ["잘못된 서명", () => issueSessionToken("fake-other-signing-key-for-tests-0000000000", Date.now())],
    ["만료", () => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
  ])("%s → 401, master · GitHub 를 부르지 않는다", async (_label, makeCookie) => {
    state.cookieValue = makeCookie();
    const response = await callDetail(`?service=backend&selected=selected-1&commit=${SHA_B}`);
    expect(response.status).toBe(401);
    expect(networkFetch).not.toHaveBeenCalled();
  });
});

describe("입력 거절 → 422, 호출 0회", () => {
  it.each([
    ["잘못된 SHA", `?service=backend&selected=selected-1&commit=xyz123`, "commit"],
    ["짧은 SHA", `?service=backend&selected=selected-1&commit=abcdef`, "commit"],
    ["허용 목록 밖 서비스", `?service=ci-cd&selected=selected-1`, "service"],
    ["서비스 없음", `?selected=selected-1`, "service"],
    ["잘못된 요청 ID", `?service=backend&selected=${encodeURIComponent("../x")}`, "selected"],
    ["요청 ID 없음", `?service=backend`, "selected"],
    ["같은 이름 여러 번", `?service=backend&service=front&selected=selected-1`, "service"],
  ])("%s → 422 invalid_input(field)", async (_label, search, field) => {
    const response = await callDetail(search);
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: false, error: { code: "invalid_input", field } });
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("목록 밖 commit → 422 invalid_input(commit), 그 커밋은 GitHub 에서 부르지 않는다", async () => {
    const outside = fakeSha(99);
    const response = await callDetail(`?service=backend&selected=selected-1&commit=${outside}`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ success: false, error: { code: "invalid_input", field: "commit" } });
    expect(githubCalls().some(([input]) => new URL(input).pathname.endsWith(`/commits/${outside}`))).toBe(false);
  });
});

describe("선택한 배포 없음 → 404", () => {
  it("master 목록에 없으면 404 not_found, GitHub 를 부르지 않는다", async () => {
    const response = await callDetail("?service=backend&selected=missing-1");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: { code: "not_found" } });
    expect(githubCalls()).toHaveLength(0);
  });
});

describe("정상 — 200 응답의 꼴", () => {
  it("요약 · 범위 · 저장소 · PR · 커밋 목록 · 고른 커밋 — 필요한 칸만, no-store", async () => {
    const response = await callDetail(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.success).toBe(true);
    const data = body.data;
    expect(data.query).toEqual({ service: "backend", selectedRequestId: "selected-1", commitSha: SHA_MIDDLE });
    expect(data.deployment).toEqual({ ok: true, value: {
      requestId: "selected-1", state: "succeeded", service: "backend", commitSha: SHA_B, failedStage: null,
      acceptedAt: "2026-11-22T02:00:00Z", finishedAt: "2026-11-22T02:05:00Z", integrationMilliseconds: 60000, deliveryMilliseconds: 30000,
    } });
    expect(data.range).toEqual({ status: "range", baseRequestId: "previous-1", baseCommitSha: SHA_A, headCommitSha: SHA_B });
    expect(data.repository).toEqual({ owner: "junhyeong9812", name: "study-note-deploy-system-backend" });
    expect(data.pullRequest.value).toMatchObject({ number: 12, title: "PR 12" });
    expect(data.commits.value.commits.map((commit: { sha: string }) => commit.sha)).toEqual([SHA_MIDDLE, SHA_B]);
    expect(data.commit.value.sha).toBe(SHA_MIDDLE);
    expect(data.commit.value.files).toHaveLength(1);
    expectNoForbiddenText(body);
  });

  it("master 는 service · limit 200 · X-Deploy-Secret 로, GitHub 는 api.github.com 의 저장소 경로로 · 전부 GET", async () => {
    await callDetail(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    const [masterInput, masterInit] = masterCalls()[0];
    const masterUrl = new URL(masterInput);
    expect(masterUrl.pathname).toBe("/deploys");
    expect(masterUrl.searchParams.get("service")).toBe("backend");
    expect(masterUrl.searchParams.get("limit")).toBe("200");
    expect(headersOf(masterInit).get("X-Deploy-Secret")).toBe(FAKE_DEPLOY_SECRET);
    const paths = githubCalls().map(([input]) => new URL(input).pathname).sort();
    expect(paths).toEqual([
      `${REPOSITORY_PATH}/commits/${SHA_B}/pulls`, `${REPOSITORY_PATH}/commits/${SHA_MIDDLE}`, `${REPOSITORY_PATH}/compare/${SHA_A}...${SHA_B}`,
    ].sort());
    for (const [input, init] of githubCalls()) {
      expect(new URL(input).origin).toBe("https://api.github.com");
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(headersOf(init).has("X-Deploy-Secret")).toBe(false);
    }
  });

  it("갈라진 이력은 표시 칸으로", async () => {
    githubHandler = (url) => (url.pathname.includes("/compare/")
      ? githubResponse(githubComparison(SHA_A, SHA_B, [githubCommitObject(SHA_B)], { status: "diverged", behind_by: 2 }))
      : defaultGithubHandler(url));
    const body = await (await callDetail("?service=backend&selected=selected-1")).json();
    expect(body.data.commits.value.diverged).toBe(true);
    expect(body.data.commits.value.comparisonStatus).toBe("diverged");
  });
});

describe("GitHub 실패 — 배포 요약은 200 으로, GitHub 칸만 가린 이유", () => {
  it.each([
    ["한도 초과", () => rateLimitedResponse(403), "rate_limited"],
    ["5xx", () => githubResponse(`${UPSTREAM_RAW_MARKER} ${GITHUB_TOKEN_VALUE}`, 502), "bad_status"],
    ["리다이렉트", () => new Response(null, { status: 301, headers: { location: "https://evil.example.test/" } }), "bad_status"],
    ["깨진 JSON", () => githubResponse(`{"x":"${UPSTREAM_RAW_MARKER}`), "unparseable"],
  ])("%s → 200 · deployment ok · pullRequest · commits 는 %s(원문 없음)", async (_label, makeResponse, reason) => {
    githubHandler = () => makeResponse();
    const response = await callDetail("?service=backend&selected=selected-1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.deployment.ok).toBe(true);
    expect(body.data.pullRequest).toMatchObject({ ok: false, reason });
    expect(body.data.commits).toMatchObject({ ok: false, reason });
    expectNoForbiddenText(body, [UPSTREAM_RAW_MARKER, GITHUB_TOKEN_VALUE, "evil.example.test"]);
  });

  it("master 실패 → 200 · deployment 실패 이유 · GitHub 를 부르지 않는다", async () => {
    masterHandler = () => jsonBody({ success: false, error: { code: UPSTREAM_RAW_MARKER } }, 503);
    const response = await callDetail("?service=backend&selected=selected-1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.deployment).toMatchObject({ ok: false, reason: "unavailable", status: 503 });
    expect(body.data.commits).toBeNull();
    expect(githubCalls()).toHaveLength(0);
    expectNoForbiddenText(body);
  });

  it("실패한 GitHub 칸은 앱 로그 1줄 이상(이유 낱말 · 상태 코드만)", async () => {
    githubHandler = () => rateLimitedResponse(429);
    await callDetail("?service=backend&selected=selected-1");
    expect(consoleLines.some((line) => line.includes("upstream=rate_limited"))).toBe(true);
    expectNoForbiddenText(consoleLines.join("\n"), [UPSTREAM_RAW_MARKER, "api.github.com"]);
  });
});

describe("GITHUB_TOKEN — 선택 설정 · 값은 어디에도 나오지 않는다", () => {
  it("토큰이 있으면 GitHub 요청마다 Authorization: Bearer, master 요청에는 싣지 않는다", async () => {
    vi.stubEnv("GITHUB_TOKEN", GITHUB_TOKEN_VALUE);
    await callDetail(`?service=backend&selected=selected-1&commit=${SHA_B}`);
    expect(githubCalls().length).toBeGreaterThan(0);
    for (const [, init] of githubCalls()) expect(headersOf(init).get("Authorization")).toBe(`Bearer ${GITHUB_TOKEN_VALUE}`);
    for (const [, init] of masterCalls()) expect(headersOf(init).has("Authorization")).toBe(false);
  });

  it("토큰이 없으면 Authorization 없이 부른다(설정 없음이 아니다 — 칸이 정상)", async () => {
    const body = await (await callDetail("?service=backend&selected=selected-1")).json();
    expect(githubCalls().length).toBeGreaterThan(0);
    for (const [, init] of githubCalls()) expect(headersOf(init).has("Authorization")).toBe(false);
    expect(body.data.commits.ok).toBe(true);
  });

  it.each([
    ["정상", defaultGithubHandler],
    ["401(토큰 거절)", () => githubResponse({ message: `Bad credentials ${GITHUB_TOKEN_VALUE}` }, 401)],
    ["연결 실패(예외 문구에 토큰)", () => { throw new TypeError(`fetch failed ${GITHUB_TOKEN_VALUE}`); }],
  ] as [string, RoutedFetchHandler][])("%s — 토큰 값이 응답 · 앱 로그에 없다", async (_label, handler) => {
    vi.stubEnv("GITHUB_TOKEN", GITHUB_TOKEN_VALUE);
    githubHandler = handler;
    const response = await callDetail(`?service=backend&selected=selected-1&commit=${SHA_B}`);
    const text = await response.text();
    expect(text).not.toContain(GITHUB_TOKEN_VALUE);
    expect(consoleLines.join("\n")).not.toContain(GITHUB_TOKEN_VALUE);
    expect(githubCalls().length).toBeGreaterThan(0);
  });
});

describe("캐시 — 요청 사이에 이어진다", () => {
  it("같은 요청을 두 번 — 비교 · 커밋 · PR 은 한 번씩만 부른다(master 는 매번)", async () => {
    await callDetail(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    const firstGithubCount = githubCalls().length;
    expect(firstGithubCount).toBe(3);
    await callDetail(`?service=backend&selected=selected-1&commit=${SHA_MIDDLE}`);
    expect(githubCalls().length).toBe(firstGithubCount);
    expect(masterCalls()).toHaveLength(2);
  });

  it("실패한 GitHub 응답은 다음 요청이 다시 부른다", async () => {
    githubHandler = () => rateLimitedResponse(403);
    await callDetail("?service=backend&selected=selected-1");
    const firstCount = githubCalls().length;
    githubHandler = defaultGithubHandler;
    const body = await (await callDetail("?service=backend&selected=selected-1")).json();
    expect(githubCalls().length).toBeGreaterThan(firstCount);
    expect(body.data.commits.ok).toBe(true);
  });
});

describe("소스 검사 — 진입은 server-only · 세션 검증, lib 는 순수, 화면은 lib 를 직접 쓰지 않는다", () => {
  const featureDirectory = fileURLToPath(new URL("..", import.meta.url));
  const sourceDirectory = fileURLToPath(new URL("../../..", import.meta.url));

  function sourceFiles(directory: string): string[] {
    if (!existsSync(directory)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) files.push(...sourceFiles(fullPath));
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) && !/test-fakes\.ts$/.test(entry)) files.push(fullPath);
    }
    return files;
  }

  it("server/ 진입 모듈 — server-only · requireApiSession · requireSession", () => {
    const files = sourceFiles(join(featureDirectory, "server"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/^import "server-only";/m);
      expect(source).toMatch(/\brequireApiSession\s*\(/);
      expect(source).toMatch(/\brequireSession\s*\(/);
    }
  });

  it("lib/ — 설정 · 환경 변수 · Next · server-only · server/ 를 읽지 않는다", () => {
    const files = sourceFiles(join(featureDirectory, "lib"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/process\.env/);
      for (const match of source.matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)) {
        expect(match[1], file).not.toBe("server-only");
        expect(match[1], file).not.toMatch(/^next(\/|$)/);
        expect(match[1], file).not.toBe("@/shared/config/server-config");
        expect(match[1], file).not.toMatch(/\/server\//);
      }
    }
  });

  it("src/app 은 deploy-detail 의 lib 를 값으로 임포트하지 않는다(server/ · ui/ 만)", () => {
    const appFiles = sourceFiles(join(sourceDirectory, "app"));
    expect(appFiles.length).toBeGreaterThan(0);
    for (const file of appFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/^\s*import\s+(?!type\b)[^;]*?\s+from\s+["'](@\/features\/deploy-detail\/[^"']+)["']/gm)) {
        expect(match[1], file).toMatch(/^@\/features\/deploy-detail\/(server|ui)\//);
      }
      expect(source, file).not.toMatch(/\bcreate(GitHub|CachedGitHub)Client\b|\bbuildDeployDetail\b/);
    }
  });

  it("route.ts 는 진입 모듈을 쓴다", () => {
    const routeSource = readFileSync(join(sourceDirectory, "app", "api", "deploys", "detail", "route.ts"), "utf8");
    expect(routeSource).toContain(`from "@/features/deploy-detail/server/`);
  });
});

describe("시작 검사 — GITHUB_TOKEN 은 선택", () => {
  it("비어 있어도 필수 설정 목록에 없다 · 있어도 값이 나오지 않는다", async () => {
    const { readServerConfig } = await import("@/shared/config/server-config");
    const { missingRequiredConfigKeys } = await import("@/shared/config/login-config-check");
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(missingRequiredConfigKeys(readServerConfig())).not.toContain("GITHUB_TOKEN");
    vi.stubEnv("GITHUB_TOKEN", GITHUB_TOKEN_VALUE);
    expect(readServerConfig().githubToken).toBe(GITHUB_TOKEN_VALUE);
    expect(missingRequiredConfigKeys(readServerConfig()).join(",")).not.toContain(GITHUB_TOKEN_VALUE);
  });
});
