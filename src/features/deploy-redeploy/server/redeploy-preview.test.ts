/** 재배포 확인 화면의 서버 쪽 진입 — middleware 없이 진입 함수를 직접 부른다(실제 설정 읽기 · 전역 fetch = 가짜 master).
 * 지키는 것: 세션 → 입력 → 설정 → 호출(세션이 없으면 master 0회 · 설정 읽기 0회) · 틀린 입력은 부르기 전에 거절 · 나가는 요청은 GET 뿐 ·
 * 비밀값은 X-Deploy-Secret 로만 · 결과 · 응답 · 로그에 비밀값 · master 주소 · 원문이 없다 · 설정이 비면 "설정 없음" · 실패 로그 1줄. */
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
vi.mock("@/shared/config/server-config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/shared/config/server-config")>();
  return { ...original, readServerConfig: () => { navigation.configReads += 1; return original.readServerConfig(); } };
});

import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { loadRedeployPreview, redeployPreviewResponse } from "@/features/deploy-redeploy/server/redeploy-preview";
import { branchFrom, installCommitGraph, type GraphCommit } from "@/features/deploy-redeploy/lib/redeploy-test-fakes";
import {
  MASTER_DEPLOYS_PATH, MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH, createFakeMaster, deploymentJson, minutesAfterStart, type FakeMaster,
} from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, SECRET_HEADER_NAMES, expectFailure, expectNoForbiddenText, expectReadOnlyRequest, headersOf,
  leakyErrorBody, leakyNetworkError, okValue, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const OTHER_KEY = "fake-other-signing-key-for-tests-0000000000";
const API_PATH = "/api/deploys/redeploy";

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

let main: GraphCommit[];
let master: FakeMaster;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
let validInput: SearchParamsInput;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  main = branchFrom(null, ["첫 커밋", "둘째 커밋", "셋째 커밋", "넷째 커밋"]);
  master = createFakeMaster([
    deploymentJson("backend", main[3].sha, "succeeded", minutesAfterStart(30)),
    deploymentJson("backend", main[1].sha, "succeeded", minutesAfterStart(20)),
    deploymentJson("backend", main[0].sha, "succeeded", minutesAfterStart(10)),
  ]);
  installCommitGraph(master, main);
  validInput = { service: "backend", commit: main[1].sha };
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

describe("인증 — 세션 → 입력 → 설정 → 호출", () => {
  for (const [label, makeCookie] of invalidSessions) {
    it(`화면용 · ${label} → /login, master 0회 · 설정 읽기 0회`, async () => {
      setSessionCookie(makeCookie());
      const thrown = await captureThrown(() => loadRedeployPreview(validInput));
      expect(thrown).toBeInstanceOf(navigation.RedirectSignal);
      expect([`/login`, `${FAKE_ORIGIN}/login`]).toContain((thrown as InstanceType<typeof navigation.RedirectSignal>).location);
      expect(master.fetch).not.toHaveBeenCalled();
      expect(navigation.configReads).toBe(0);
    });

    it(`데이터 경로용 · ${label} → 401(데이터 없음 · no-store), master 0회 · 설정 읽기 0회`, async () => {
      setSessionCookie(makeCookie());
      const response = await redeployPreviewResponse(apiRequest(validInput));
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body).not.toHaveProperty("data");
      expect(master.fetch).not.toHaveBeenCalled();
      expect(navigation.configReads).toBe(0);
    });
  }

  it("세션 없음 + 틀린 입력 → 세션 거절이 먼저", async () => {
    expect(await captureThrown(() => loadRedeployPreview({ service: "backend", commit: "abc" }))).toBeInstanceOf(navigation.RedirectSignal);
    expect((await redeployPreviewResponse(apiRequest({ service: "backend", commit: "abc" }))).status).toBe(401);
    expect(master.fetch).not.toHaveBeenCalled();
  });

  it("틀린 입력 → 설정을 읽지 않고 master 를 부르지 않는다(입력이 설정보다 먼저)", async () => {
    validSession();
    await loadRedeployPreview({ service: "backend", commit: main[1].sha.slice(0, 7) });
    expect(navigation.configReads).toBe(0);
    expect(master.fetch).not.toHaveBeenCalled();
  });
});

describe("입력", () => {
  it.each([
    [{ commit: "0123456789abcdef0123456789abcdef01234567" }, "service", null],
    [{ service: "nope", commit: "0123456789abcdef0123456789abcdef01234567" }, "service", null],
    [{ service: "backend" }, "commit", "backend"],
    [{ service: "backend", commit: "0123456" }, "commit", "backend"],
    [{ service: "backend", commit: "0123456789ABCDEF0123456789ABCDEF01234567" }, "commit", "backend"],
    [{ service: ["backend", "front"], commit: "0123456789abcdef0123456789abcdef01234567" }, "service", null],
  ] as const)("%j → 화면용 query null · preview invalid_input(field %s) · service = %s · master 0회", async (input, field, service) => {
    validSession();
    const view = await loadRedeployPreview(input as SearchParamsInput);
    expect(view.query).toBeNull();
    expect(view.service).toBe(service);
    expectFailure(view.preview, "invalid_input");
    expect(view.preview).toMatchObject({ field });
    expect(master.fetch).not.toHaveBeenCalled();
  });

  it("틀린 입력 → 데이터 경로 422 invalid_input(field commit), master 0회", async () => {
    validSession();
    const response = await redeployPreviewResponse(apiRequest({ service: "backend", commit: "0123456" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "invalid_input", field: "commit" } });
    expect(master.fetch).not.toHaveBeenCalled();
  });
});

describe("유효한 세션 — 읽기만(GET), 비밀값은 그 헤더로만", () => {
  it("화면용 → query · service · 되돌리기 비교, 이력과 git 조회만 · 전부 GET · X-Deploy-Secret 만", async () => {
    validSession();
    const view = await loadRedeployPreview(validInput);
    expect(view.query).toEqual({ service: "backend", commitSha: main[1].sha });
    expect(view.service).toBe("backend");
    const result = okValue(view.preview);
    expect(result.kind).toBe("comparison");
    if (result.kind === "comparison") expect(result.direction).toMatchObject({ kind: "rollback", between: { commits: [{ sha: main[3].sha }, { sha: main[2].sha }] } });
    const allowed = [MASTER_DEPLOYS_PATH, MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH].map((path) => `${FAKE_DEPLOY_MASTER_URL}${path}`);
    for (const url of master.requestedUrls()) expect(allowed).toContain(`${url.origin}${url.pathname}`);
    for (const [, init] of master.fetch.mock.calls) {
      expectReadOnlyRequest(init);
      const headers = headersOf(init);
      for (const name of SECRET_HEADER_NAMES) expect(headers.get(name), name).toBe(name === "x-deploy-secret" ? FAKE_DEPLOY_SECRET : null);
    }
    expectNoForbiddenText(view);
  });

  it("데이터 경로용 → 200 · no-store · {success:true,data:{query,service,preview}} · 비밀값 · 주소 없음", async () => {
    validSession();
    const response = await redeployPreviewResponse(apiRequest(validInput));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.success).toBe(true);
    expect(body.data.query).toEqual({ service: "backend", commitSha: main[1].sha });
    expect(body.data.preview.ok).toBe(true);
    expect(body.data.preview.value.kind).toBe("comparison");
    expectNoForbiddenText(text);
  });

  it("성공 이력에 없는 커밋 → 데이터 경로도 200 · preview.kind not_deployable", async () => {
    validSession();
    const response = await redeployPreviewResponse(apiRequest({ service: "backend", commit: main[2].sha }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.preview.value).toEqual({ kind: "not_deployable", service: "backend", commitSha: main[2].sha });
  });
});

describe("실패 — 비밀값 · 주소 · 원문이 결과 · 응답 · 로그에 없다", () => {
  const behaviors: [string, () => Promise<Response> | Response, string][] = [
    ["500 + 비밀값 · 주소를 담은 오류 본문", () => textResponse(leakyErrorBody(), 500), "bad_status"],
    ["200 + 깨진 본문", () => textResponse(`{${leakyErrorBody()}`), "unparseable"],
    ["연결 실패(예외 문구에 주소 · 비밀값)", () => Promise.reject(leakyNetworkError()), "unreachable"],
  ];
  for (const [label, behavior, reason] of behaviors) {
    it(`이력 조회 ${label} → preview = ${reason}, 응답은 200`, async () => {
      validSession();
      master.override[MASTER_DEPLOYS_PATH] = behavior;
      const view = await loadRedeployPreview(validInput);
      expectFailure(view.preview, reason);
      expectNoForbiddenText(view);
      const response = await redeployPreviewResponse(apiRequest(validInput));
      expect(response.status).toBe(200);
      expectNoForbiddenText(await response.text());
      expectNoForbiddenText(everythingLogged());
    });
  }

  it("이력 조회의 실패는 앱 로그 1줄 — 이유 낱말과 상태 코드만", async () => {
    validSession();
    master.override[MASTER_DEPLOYS_PATH] = () => textResponse(leakyErrorBody(), 503);
    await loadRedeployPreview(validInput);
    const logged = everythingLogged();
    expect(logged).toContain("upstream=unavailable");
    expect(logged).toContain("status=503");
    expectNoForbiddenText(logged);
  });

  it("방향 조회(git)만 실패 → 비교는 unknown · 로그 1줄(이유 낱말) · 원문 없음", async () => {
    validSession();
    master.override[MASTER_GIT_COMMITS_PATH] = () => textResponse(leakyErrorBody(), 500);
    master.override[MASTER_GIT_COMMIT_PATH] = () => textResponse(leakyErrorBody(), 500);
    const view = await loadRedeployPreview(validInput);
    const result = okValue(view.preview);
    expect(result.kind === "comparison" ? result.direction.kind : result.kind).toBe("unknown");
    const logged = everythingLogged();
    expect(logged).toContain("upstream=bad_status");
    expectNoForbiddenText(view);
    expectNoForbiddenText(logged);
  });
});

describe("설정이 비면 '설정 없음'(부르지 않는다)", () => {
  it.each(["DEPLOY_MASTER_URL", "DEPLOY_SECRET"])("%s 없음 → preview not_configured, master 0회", async (key) => {
    validSession();
    vi.stubEnv(key, "");
    expectFailure((await loadRedeployPreview(validInput)).preview, "not_configured");
    expect(master.fetch).not.toHaveBeenCalled();
  });
});
