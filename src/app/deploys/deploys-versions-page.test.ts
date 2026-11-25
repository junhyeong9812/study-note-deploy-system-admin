/** 버전 목록 화면(/deploys/versions) — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 master)를 거친다.
 * 지키는 것: 지금 버전("지금" 글) · 성공한 커밋만 한 줄씩(가장 최근 시각 KST + 횟수) · 짧은 SHA + 전체 SHA(title) · 커밋 제목(없으면 "제목 없음") ·
 * "배포 진행 중" 한 줄 · "최근 200건의 배포에서 찾은 버전"(상한에 닿으면 더 적는다) · 실패는 그 구역에만 "확인하지 못함" + 까닭 ·
 * 서비스 고르기(링크) · 고르지 않음 · 틀린 입력 · 폼 · 단추 · 스크립트 없음(본문) · 비밀값 · 주소 없음 · 내비게이션 · 배포 이력 화면에서 오는 링크. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ restricted: false, cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => state.restricted }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookieValue !== undefined && name === "admin_session" ? { name, value: state.cookieValue } : undefined),
    has: () => state.cookieValue !== undefined,
    getAll: () => [],
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import DeploysPage from "@/app/deploys/page";
import DeployVersionsPage from "@/app/deploys/versions/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  MASTER_DEPLOYS_PATH, MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH, commitChain, createFakeMaster, deploymentJson, minutesAfterStart, uniqueSha,
  type FakeCommit, type FakeMaster,
} from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import { DeployVersionsScreen } from "@/features/deploy-versions/ui/DeployVersionsScreen";
import { upstreamFailure } from "@/shared/lib/upstream-result";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, expectNoForbiddenText, expectReadOnlyRequest, jsonBody, leakyErrorBody, leakyNetworkError, textResponse,
} from "@/shared/lib/upstream-test-fakes";

type Renderer = { renderToStaticMarkup: (node: unknown) => string };

async function renderer(): Promise<Renderer> {
  const rendererModuleName = "react-dom/server";
  return (await import(/* @vite-ignore */ rendererModuleName)) as Renderer;
}

async function renderVersions(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const element: unknown = await DeployVersionsPage({ searchParams: Promise.resolve(searchParams) });
  return (await renderer()).renderToStaticMarkup(element);
}

async function renderDeploys(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const element = await DeploysPage({ searchParams: Promise.resolve(searchParams) });
  return (await renderer()).renderToStaticMarkup(element);
}

/** 본문(<main>…</main>) — 공통 틀(내비게이션 · 로그아웃 단추)을 뺀 화면 자신. */
function mainOf(html: string): string {
  const match = /<main[\s>][\s\S]*<\/main>/.exec(html);
  expect(match, "본문 <main> 이 있다").not.toBeNull();
  return match![0];
}

/** 표의 줄(<tr …>…</tr>) 가운데 글자를 담은 것. */
function rowsContaining(html: string, text: string): string[] {
  return [...mainOf(html).matchAll(/<tr[\s>][\s\S]*?<\/tr>/g)].map((match) => match[0]).filter((row) => row.includes(text));
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

let chain: FakeCommit[];
let master: FakeMaster;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  state.restricted = false;
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  chain = commitChain(["첫 커밋", "로그인 고침", "목록 정렬", "배포 스크립트"]);
  const [first, second, third, fourth] = chain;
  master = createFakeMaster([
    deploymentJson("backend", fourth.sha, "ci_running", minutesAfterStart(40)),
    deploymentJson("backend", third.sha, "succeeded", minutesAfterStart(30)),
    deploymentJson("backend", second.sha, "failed", minutesAfterStart(20)),
    deploymentJson("backend", first.sha, "succeeded", minutesAfterStart(15)),
    deploymentJson("backend", first.sha, "succeeded", minutesAfterStart(10)),
  ], chain);
  vi.stubGlobal("fetch", master.fetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("버전 목록 — 줄의 내용", () => {
  it("성공한 커밋마다 한 줄 — 짧은 SHA(7자) · 전체 SHA(title) · 커밋 제목 · 가장 최근 배포 시각(KST, 원본 UTC 는 title) · 횟수", async () => {
    const [first, , third] = chain;
    const html = await renderVersions({ service: "backend" });
    const currentRows = rowsContaining(html, `>${shortSha(third.sha)}<`);
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0]).toContain(`title="${third.sha}"`);
    expect(currentRows[0]).toContain("목록 정렬");
    expect(currentRows[0]).toContain("2026-11-20 09:33:00");   // 00:33:00Z(접수 3분 뒤 끝남) → KST
    expect(currentRows[0]).toContain('title="UTC 2026-11-20T00:33:00Z"');
    expect(currentRows[0]).toContain("1번");
    const olderRows = rowsContaining(html, `>${shortSha(first.sha)}<`);
    expect(olderRows).toHaveLength(1);   // 두 번 배포됐어도 한 줄
    expect(olderRows[0]).toContain(`title="${first.sha}"`);
    expect(olderRows[0]).toContain("첫 커밋");
    expect(olderRows[0]).toContain("2026-11-20 09:18:00");   // 가장 최근(00:15 접수 → 00:18 끝남)
    expect(olderRows[0]).toContain("2번");
  });

  it("지금 떠 있는 버전에만 '지금' 글 — 가장 최근 성공(그 뒤 진행 중 · 실패가 있어도)", async () => {
    const [first, , third] = chain;
    const html = await renderVersions({ service: "backend" });
    expect(rowsContaining(html, `>${shortSha(third.sha)}<`)[0]).toContain(">지금<");
    expect(rowsContaining(html, `>${shortSha(first.sha)}<`)[0]).not.toContain(">지금<");
    expect(mainOf(html).split(">지금<")).toHaveLength(2);   // 하나만
    expect(mainOf(html)).toContain("배포 이력 기준");
  });

  it("최신순 — 지금 버전이 위", async () => {
    const [first, , third] = chain;
    const main = mainOf(await renderVersions({ service: "backend" }));
    expect(main.indexOf(`>${shortSha(third.sha)}<`)).toBeGreaterThan(-1);
    expect(main.indexOf(`>${shortSha(third.sha)}<`)).toBeLessThan(main.indexOf(`>${shortSha(first.sha)}<`));
  });

  it("실패한 배포 · 진행 중인 배포의 커밋은 목록에 없다 — 진행 중이면 '배포 진행 중' 한 줄(그 커밋의 짧은 SHA)", async () => {
    const [, second, , fourth] = chain;
    const html = await renderVersions({ service: "backend" });
    const main = mainOf(html);
    expect(rowsContaining(html, shortSha(second.sha))).toEqual([]);
    expect(rowsContaining(html, shortSha(fourth.sha))).toEqual([]);
    expect(main).not.toContain(shortSha(second.sha));
    expect(main).not.toContain("로그인 고침");
    expect(main).toContain("배포 진행 중");
    expect(main).toContain(shortSha(fourth.sha));
  });

  it("진행 중인 배포가 없으면 '배포 진행 중' 이 없다", async () => {
    master.deployments = master.deployments.filter((row) => row.state !== "ci_running");
    expect(mainOf(await renderVersions({ service: "backend" }))).not.toContain("배포 진행 중");
  });

  it("커밋 제목을 얻지 못한 줄은 '제목 없음' · 제목 조회가 실패했으면 그 까닭(나머지는 그대로)", async () => {
    master.override[MASTER_GIT_COMMITS_PATH] = () => Promise.reject(leakyNetworkError());
    master.override[MASTER_GIT_COMMIT_PATH] = () => Promise.reject(leakyNetworkError());
    const html = await renderVersions({ service: "backend" });
    const [first, , third] = chain;
    expect(rowsContaining(html, `>${shortSha(third.sha)}<`)[0]).toContain("제목 없음");
    expect(rowsContaining(html, `>${shortSha(first.sha)}<`)[0]).toContain("제목 없음");
    expect(mainOf(html)).toContain("커밋 제목을 확인하지 못함 — 닿지 않음");
    expectNoForbiddenText(html);
  });

  it("서버의 git 이력에 없는 커밋만 '제목 없음'(제목 조회 실패 안내는 그 경우의 것이 아니다 — 목록은 그대로)", async () => {
    const outsideSha = uniqueSha();
    master.deployments = [
      deploymentJson("backend", chain[2].sha, "succeeded", minutesAfterStart(30)),
      deploymentJson("backend", outsideSha, "succeeded", minutesAfterStart(5)),
    ];
    const html = await renderVersions({ service: "backend" });
    expect(rowsContaining(html, `>${shortSha(outsideSha)}<`)[0]).toContain("제목 없음");
    expect(rowsContaining(html, `>${shortSha(outsideSha)}<`)[0]).not.toContain("목록 정렬");
  });

  it("커밋 제목의 꺾쇠는 글자로(스크립트가 되지 않는다)", async () => {
    chain[2].subject = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    const main = mainOf(await renderVersions({ service: "backend" }));
    expect(main).not.toContain("<script");
    expect(main).not.toContain("<img");
    expect(main).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("성공한 배포가 없는 서비스 → '<서비스> 의 성공한 배포가 없습니다.'", async () => {
    master.deployments = [deploymentJson("alert", chain[0].sha, "failed", minutesAfterStart(10))];
    const main = mainOf(await renderVersions({ service: "alert" }));
    expect(main).toContain("alert 의 성공한 배포가 없습니다.");
    expect(main).not.toContain(">지금<");
  });
});

describe("잘림을 드러낸다 — 최근 200건의 배포에서 찾은 버전", () => {
  it("언제나 '최근 200건의 배포에서 찾은 버전' — 상한에 닿지 않았으면 더 오래된 배포 안내는 없다", async () => {
    const main = mainOf(await renderVersions({ service: "backend" }));
    expect(main).toContain("최근 200건의 배포에서 찾은 버전");
    expect(main).not.toContain("더 오래된 배포는 읽지 않았습니다");
  });

  it("받은 이력이 200건이면 '더 오래된 배포는 읽지 않았습니다'", async () => {
    master.deployments = Array.from({ length: 230 }, (_, index) => deploymentJson("backend", chain[index % 2].sha, "succeeded", minutesAfterStart(1000 - index)));
    const main = mainOf(await renderVersions({ service: "backend" }));
    expect(main).toContain("최근 200건의 배포에서 찾은 버전");
    expect(main).toContain("더 오래된 배포는 읽지 않았습니다");
  });
});

describe("실패 — 그 구역에만 '확인하지 못함'과 까닭, 머리 · 내비게이션은 그대로", () => {
  const cases: [string, () => Promise<Response> | Response, string[]][] = [
    ["닿지 못함", () => Promise.reject(leakyNetworkError()), ["배포 서버: 닿지 않음"]],
    ["503", () => textResponse(leakyErrorBody(), 503), ["배포 서버: 서버 일시 장애", "HTTP 503"]],
    ["해석 못 함", () => textResponse(`{${leakyErrorBody()}`), ["배포 서버: 해석 불가"]],
  ];
  for (const [label, behavior, words] of cases) {
    it(`master ${label}`, async () => {
      master.override[MASTER_DEPLOYS_PATH] = behavior;
      const html = await renderVersions({ service: "backend" });
      const main = mainOf(html);
      expect(main).toContain("확인하지 못함");
      for (const word of words) expect(main).toContain(word);
      expect(main).toContain("버전 목록");                 // 머리
      expect(main).toMatch(/href="\/deploys\/versions\?service=front"/);   // 서비스 고르기는 그대로
      expect(html).toContain("로그아웃");                  // 공통 틀
      expect(html).toMatch(/<a[^>]*href="\/deploys"[^>]*>배포 이력</);
      expect(main).not.toContain(">지금<");
      expectNoForbiddenText(html);
    });
  }

  it("시간 초과(5초)도 같은 자리에 '확인하지 못함 · 닿지 않음(5초 초과)'", async () => {
    const html = (await renderer()).renderToStaticMarkup(
      DeployVersionsScreen({ view: { query: { service: "backend" }, versions: upstreamFailure("timeout") } }),
    );
    expect(html).toContain("확인하지 못함");
    expect(html).toContain("배포 서버: 닿지 않음(5초 초과)");
    expect(html).toContain("버전 목록");
  });

  it("설정 없음 → '배포 서버: 설정 없음'", async () => {
    vi.stubEnv("DEPLOY_SECRET", "");
    const main = mainOf(await renderVersions({ service: "backend" }));
    expect(main).toContain("확인하지 못함");
    expect(main).toContain("배포 서버: 설정 없음");
    expect(master.fetch).not.toHaveBeenCalled();
  });
});

describe("서비스 고르기(링크 · GET)", () => {
  it("서비스 여섯을 링크로 — 고른 것에 aria-current, '전체' 는 없다", async () => {
    const main = mainOf(await renderVersions({ service: "backend" }));
    for (const service of ["front", "backend", "llm", "alert", "observe", "admin"]) expect(main).toContain(`href="/deploys/versions?service=${service}"`);
    expect(main).toMatch(/href="\/deploys\/versions\?service=backend" aria-current="page"/);
    expect(main).not.toMatch(/href="\/deploys\/versions\?service=front" aria-current/);
    expect(main).not.toContain(">전체<");
  });

  it("고르지 않았으면 안내 · 서비스 링크 · master 를 부르지 않는다", async () => {
    const main = mainOf(await renderVersions());
    expect(main).toContain("서비스를 고르면");
    for (const service of ["front", "backend", "llm", "alert", "observe", "admin"]) expect(main).toContain(`href="/deploys/versions?service=${service}"`);
    expect(main).not.toContain("aria-current");
    expect(master.fetch).not.toHaveBeenCalled();
  });

  it.each([["not-a-service"], ["Backend"], [["backend", "front"]]])("틀린 service %j → 조건 안내 · master 를 부르지 않는다", async (service) => {
    const main = mainOf(await renderVersions({ service }));
    expect(main).toContain("조회 조건이 맞지 않습니다");
    expect(main).toContain("서비스 값을 확인하세요");
    expect(main).toContain('href="/deploys/versions"');
    expect(master.fetch).not.toHaveBeenCalled();
  });
});

describe("아무것도 바꾸지 않는다 · 비밀값 없음 · 스크립트 없음", () => {
  it("본문에 폼 · 단추 · 스크립트가 없다 — master 로 나간 요청은 전부 GET", async () => {
    const html = await renderVersions({ service: "backend" });
    const main = mainOf(html);
    expect(main).not.toMatch(/<form[\s>]/i);
    expect(main).not.toMatch(/<button[\s>]/i);
    expect(main).not.toMatch(/<input[\s>]/i);
    expect(main).not.toMatch(/method="post"/i);
    expect(main).not.toMatch(/<script[\s>]/i);
    expect(master.fetch).toHaveBeenCalled();
    for (const [, init] of master.fetch.mock.calls) expectReadOnlyRequest(init);
  });

  it("비밀값 · master 주소 · 빌드 출력이 HTML 에 없다", async () => {
    master.deployments = master.deployments.map((row) => ({ ...row, detail: "build output raw-upstream-text-marker-zz9" }));
    const html = await renderVersions({ service: "backend" });
    expectNoForbiddenText(html);
    expect(html).not.toContain("build output");
    expect(html).not.toContain(FAKE_DEPLOY_MASTER_URL);
  });

  it("이 화면의 소스는 브라우저 스크립트가 아니다(\"use client\" 없음)", () => {
    const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const fullPath = join(directory, entry);
        if (statSync(fullPath).isDirectory()) walk(fullPath);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) files.push(fullPath);
      }
    };
    walk(join(sourceRoot, "features", "deploy-versions"));
    walk(join(sourceRoot, "app", "deploys", "versions"));
    walk(join(sourceRoot, "app", "api", "deploys", "versions"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/^\s*["']use client["']/m);
  });
});

describe("내비게이션 · 배포 이력 화면과의 길", () => {
  it("내비게이션에 '버전 목록'(지금 화면) · 배포 이력은 링크(지금 화면 아님) · 로그아웃", async () => {
    const html = await renderVersions({ service: "backend" });
    expect(html).toMatch(/href="\/deploys\/versions" aria-current="page"[^>]*>버전 목록</);
    expect(html).toMatch(/<a[^>]*href="\/deploys"[^>]*>배포 이력</);
    expect(html).not.toMatch(/href="\/deploys" aria-current/);
    expect(html).toContain("로그아웃");
  });

  it("임시 제한 중이면 버전 목록 화면에도 표시", async () => {
    state.restricted = true;
    expect(await renderVersions()).toContain("임시 제한 중");
  });

  it("배포 이력 화면의 본문에 버전 목록으로 가는 링크 — 서비스를 골랐으면 그 서비스로", async () => {
    master.override[MASTER_DEPLOYS_PATH] = () => jsonBody({ success: true, data: { deployments: [] } });
    expect(mainOf(await renderDeploys())).toContain('href="/deploys/versions"');
    expect(mainOf(await renderDeploys({ service: "front" }))).toContain('href="/deploys/versions?service=front"');
  });

  it("배포 이력 화면의 내비게이션에도 '버전 목록'(지금 화면 아님)", async () => {
    const html = await renderDeploys();
    expect(html).toMatch(/<a[^>]*href="\/deploys\/versions"[^>]*>버전 목록</);
    expect(html).not.toMatch(/href="\/deploys\/versions" aria-current/);
  });

  it("배포 이력 화면은 requested_by 가 실린 이력도 그대로 그린다(모르는 칸을 받아들인다)", async () => {
    master.deployments = [
      deploymentJson("backend", chain[0].sha, "succeeded", minutesAfterStart(10), { requested_by: "admin:fake-admin" }),
      deploymentJson("backend", chain[1].sha, "failed", minutesAfterStart(5), { requested_by: "github", future_field: { nested: true } }),
    ];
    const main = mainOf(await renderDeploys({ service: "backend" }));
    expect(main).not.toContain("배포 이력을 불러오지 못했습니다");
    expect(main).toContain(`>${shortSha(chain[0].sha)}<`);
    expect(main).toContain(`>${shortSha(chain[1].sha)}<`);
    expect(main).toContain("2건");
  });
});
