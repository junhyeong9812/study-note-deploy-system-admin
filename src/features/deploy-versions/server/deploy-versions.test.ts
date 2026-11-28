/** 버전 목록의 서버 쪽 진입 — middleware 없이 진입 함수를 직접 부른다(실제 설정 읽기 · 전역 fetch = 가짜 master).
 * 지키는 것: 세션 확인이 설정 읽기 · master 호출보다 먼저(세션이 없으면 master 0회) · 고르지 않았으면 부르지 않음 · 틀린 입력은 부르기 전에 거절 ·
 * 나가는 요청은 GET 뿐 · 비밀값은 X-Deploy-Secret 로만 · 결과 · 응답 · 로그에 비밀값 · master 주소 · 원문이 없다 · 설정이 비면 "설정 없음". */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public location: string) { super(`redirect:${location}`); }
  }
  return { RedirectSignal, cookieValues: new Map<string, string>(), configReads: 0 };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (navigation.cookieValues.has(name) ? { name, value: navigation.cookieValues.get(name)! } : undefined),
    has: (name: string) => navigation.cookieValues.has(name),
    getAll: () => [...navigation.cookieValues].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers({ host: "evil.example.test" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (location: string) => { throw new navigation.RedirectSignal(location); },
  permanentRedirect: (location: string) => { throw new navigation.RedirectSignal(location); },
  notFound: () => { throw new Error("notFound"); },
}));
// 진입 모듈이 설정을 읽은 횟수(같은 모듈 안의 sessionSigningKey 가 부르는 것은 세지 않는다)
vi.mock("@/shared/config/server-config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/shared/config/server-config")>();
  return { ...original, readServerConfig: () => { navigation.configReads += 1; return original.readServerConfig(); } };
});

import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { deployVersionsResponse, loadDeployVersions } from "@/features/deploy-versions/server/deploy-versions";
import {
  MASTER_DEPLOYS_PATH, MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH, commitChain, createFakeMaster, deploymentJson, minutesAfterStart, type FakeMaster,
} from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, SECRET_HEADER_NAMES, expectFailure, expectNoForbiddenText, expectReadOnlyRequest, headersOf,
  leakyErrorBody, leakyNetworkError, okValue, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";
const API_PATH = "/api/deploys/versions";

const invalidSessions: [string, () => string | undefined][] = [
  ["쿠키 없음", () => undefined],
  ["잘못된 서명", () => issueSessionToken(OTHER_KEY, Date.now())],
  ["만료", () => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1000)],
];

function setSessionCookie(value: string | undefined) {
  navigation.cookieValues.clear();
  if (value !== undefined) navigation.cookieValues.set(SESSION_COOKIE_NAME, value);
}

function validSession() {
  setSessionCookie(issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
}

function apiRequest(input: SearchParamsInput): Request {
  const url = new URL(API_PATH, FAKE_ORIGIN);
  for (const [name, value] of Object.entries(input)) {
    for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) url.searchParams.append(name, each);
  }
  return new Request(url, { method: "GET", headers: { origin: FAKE_ORIGIN } });
}

async function captureThrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

let master: FakeMaster;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  const chain = commitChain(["첫 커밋", "둘째 커밋", "셋째 커밋"]);
  master = createFakeMaster([
    deploymentJson("backend", chain[2].sha, "succeeded", minutesAfterStart(30)),
    deploymentJson("backend", chain[1].sha, "failed", minutesAfterStart(20)),
    deploymentJson("backend", chain[0].sha, "succeeded", minutesAfterStart(10)),
  ], chain);
  vi.stubGlobal("fetch", master.fetch);
  navigation.configReads = 0;
  setSessionCookie(undefined);
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function everythingLogged(): string {
  const consoleText = consoleSpies.flatMap((spy) => spy.mock.calls.flat()).map((part) => String(part));
  const streamText = [process.stdout.write, process.stderr.write].flatMap((write) =>
    (vi.isMockFunction(write) ? write.mock.calls.map((call) => String(call[0])) : []));
  return [...consoleText, ...streamText].join("\n");
}

describe("인증 — 세션 확인이 설정 읽기 · master 호출보다 먼저", () => {
  for (const [label, makeCookie] of invalidSessions) {
    it(`화면용 · ${label} → /login, master 0회 · 설정 읽기 0회`, async () => {
      setSessionCookie(makeCookie());
      const thrown = await captureThrown(() => loadDeployVersions({ service: "backend" }));
      expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
      expect([`/login`, `${FAKE_ORIGIN}/login`]).toContain((thrown as InstanceType<typeof navigation.RedirectSignal>).location);
      expect(master.fetch).not.toHaveBeenCalled();
      expect(navigation.configReads).toBe(0);
    });

    it(`데이터 경로용 · ${label} → 401(데이터 없음 · no-store), master 0회 · 설정 읽기 0회`, async () => {
      setSessionCookie(makeCookie());
      const response = await deployVersionsResponse(apiRequest({ service: "backend" }));
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body).not.toHaveProperty("data");
      expect(master.fetch).not.toHaveBeenCalled();
      expect(navigation.configReads).toBe(0);
    });
  }

  it("세션 없음 + 틀린 입력 → 입력 거절이 아니라 세션 거절(검증보다 세션이 먼저)", async () => {
    const thrown = await captureThrown(() => loadDeployVersions({ service: "not-a-service" }));
    expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
    const response = await deployVersionsResponse(apiRequest({ service: "not-a-service" }));
    expect(response.status).toBe(401);
    expect(master.fetch).not.toHaveBeenCalled();
  });
});

describe("서비스 고르기", () => {
  it("고르지 않았으면 query.service = null · versions = null, master 를 부르지 않는다", async () => {
    validSession();
    expect(await loadDeployVersions({})).toEqual({ query: { service: null }, versions: null });
    expect(master.fetch).not.toHaveBeenCalled();
  });

  it("틀린 service(허용 목록 밖 · 배열) → 화면용 query null · versions invalid_input, master 를 부르지 않는다", async () => {
    validSession();
    for (const service of ["not-a-service", "Backend", ["backend", "front"]] as (string | string[])[]) {
      const view = await loadDeployVersions({ service });
      expect(view.query).toBeNull();
      expect(view.versions).not.toBeNull();
      expectFailure(view.versions!, "invalid_input");
      expect(view.versions).toMatchObject({ field: "service" });
    }
    expect(master.fetch).not.toHaveBeenCalled();
  });

  it("틀린 service → 데이터 경로 422 invalid_input(field service), master 를 부르지 않는다", async () => {
    validSession();
    const response = await deployVersionsResponse(apiRequest({ service: ["backend", "front"] }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "invalid_input", field: "service" } });
    expect(master.fetch).not.toHaveBeenCalled();
  });
});

describe("유효한 세션 — 읽기만(GET), 비밀값은 그 헤더로만", () => {
  it("화면용 → 그 서비스의 이력과 git 조회만 부른다 · 전부 GET · 본문 없음 · X-Deploy-Secret 만", async () => {
    validSession();
    const view = await loadDeployVersions({ service: "backend" });
    expect(view.query).toEqual({ service: "backend" });
    const list = okValue(view.versions!);
    expect(list.versions.map((version) => version.title)).toEqual(["셋째 커밋", "첫 커밋"]);
    const paths = new Set(master.requestedUrls().map((url) => `${url.origin}${url.pathname}`));
    for (const path of paths) {
      expect([MASTER_DEPLOYS_PATH, MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH].map((each) => `${FAKE_DEPLOY_MASTER_URL}${each}`)).toContain(path);
    }
    expect(paths).toContain(`${FAKE_DEPLOY_MASTER_URL}${MASTER_DEPLOYS_PATH}`);
    for (const [, init] of master.fetch.mock.calls) {
      expectReadOnlyRequest(init);
      const headers = headersOf(init);
      for (const name of SECRET_HEADER_NAMES) expect(headers.get(name), name).toBe(name === "x-deploy-secret" ? FAKE_DEPLOY_SECRET : null);
    }
    expectNoForbiddenText(view);
  });

  it("데이터 경로용 → 200 · no-store · {success:true,data:{query,versions}} · 비밀값 · 주소 없음", async () => {
    validSession();
    const response = await deployVersionsResponse(apiRequest({ service: "backend" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.success).toBe(true);
    expect(body.data.query).toEqual({ service: "backend" });
    expect(body.data.versions.ok).toBe(true);
    expect(body.data.versions.value.versions).toHaveLength(2);
    expectNoForbiddenText(text);
  });

  it("데이터 경로용 · 고르지 않음 → 200 · versions null · master 0회", async () => {
    validSession();
    const response = await deployVersionsResponse(apiRequest({}));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ query: { service: null }, versions: null });
    expect(master.fetch).not.toHaveBeenCalled();
  });
});

describe("master 가 이상하게 답해도 비밀값 · 주소 · 원문이 결과 · 응답 · 로그에 없다", () => {
  const behaviors: [string, () => Promise<Response> | Response, string][] = [
    ["500 + 비밀값 · 주소를 담은 오류 본문", () => textResponse(leakyErrorBody(), 500), "bad_status"],
    ["200 + 깨진 본문", () => textResponse(`{${leakyErrorBody()}`), "unparseable"],
    ["연결 실패(예외 문구에 주소 · 비밀값)", () => Promise.reject(leakyNetworkError()), "unreachable"],
  ];
  for (const [label, behavior, reason] of behaviors) {
    it(`${label} → versions = ${reason}, 응답은 200(실패는 칸의 결과로)`, async () => {
      validSession();
      master.override[MASTER_DEPLOYS_PATH] = behavior;
      const view = await loadDeployVersions({ service: "backend" });
      expectFailure(view.versions!, reason);
      expectNoForbiddenText(view);
      const response = await deployVersionsResponse(apiRequest({ service: "backend" }));
      expect(response.status).toBe(200);
      expectNoForbiddenText(await response.text());
      expectNoForbiddenText(everythingLogged());
    });
  }

  it("git 조회만 실패하면 버전은 보이고, 로그 · 결과에 원문이 없다", async () => {
    validSession();
    master.override[MASTER_GIT_COMMITS_PATH] = () => textResponse(leakyErrorBody(), 500);
    master.override[MASTER_GIT_COMMIT_PATH] = () => textResponse(leakyErrorBody(), 500);
    const view = await loadDeployVersions({ service: "backend" });
    const list = okValue(view.versions!);
    expect(list.versions).toHaveLength(2);
    expect(list.titleFailure).not.toBeNull();
    expectNoForbiddenText(view);
    expectNoForbiddenText(everythingLogged());
  });

  it("이력 조회의 실패는 앱 로그 1줄에 이유 낱말과 상태 코드만", async () => {
    validSession();
    master.override[MASTER_DEPLOYS_PATH] = () => textResponse(leakyErrorBody(), 503);
    await loadDeployVersions({ service: "backend" });
    const logged = everythingLogged();
    expect(logged).toContain("upstream=unavailable");
    expect(logged).toContain("status=503");
    expectNoForbiddenText(logged);
  });
});

describe("설정이 비면 '설정 없음'(부르지 않는다)", () => {
  it.each(["DEPLOY_MASTER_URL", "DEPLOY_SECRET"])("%s 없음 → versions not_configured, master 0회", async (key) => {
    validSession();
    vi.stubEnv(key, "");
    expectFailure((await loadDeployVersions({ service: "backend" })).versions!, "not_configured");
    expect(master.fetch).not.toHaveBeenCalled();
  });

  it("DEPLOY_MASTER_URL 이 주소가 아님 → not_configured", async () => {
    validSession();
    vi.stubEnv("DEPLOY_MASTER_URL", "deploy-master.example.test:15000");
    expectFailure((await loadDeployVersions({ service: "backend" })).versions!, "not_configured");
    expect(master.fetch).not.toHaveBeenCalled();
  });
});
