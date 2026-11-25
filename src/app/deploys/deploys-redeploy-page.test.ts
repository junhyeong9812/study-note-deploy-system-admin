/** 재배포 확인 화면(/deploys/redeploy) — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 master — 갈라지는 git 이력)를 거친다.
 * 지키는 것: 지금 버전 → 고른 버전(짧은 SHA · 전체는 title · 제목 · 마지막 배포 시각) · 방향은 글로(되돌립니다 · 앞으로 올립니다 · 같은 버전을 다시 올립니다 ·
 * 두 버전의 앞뒤를 확인하지 못함 — 까닭) · 사이의 커밋 표와 수 · 100개 상한 안내 · 되돌릴 때의 데이터 꼴 안내 · 배포 진행 중 안내 ·
 * 성공 이력에 없는 커밋은 비교 없음 · 틀린 입력 · 실패 · 버전 목록으로 돌아가는 링크 · 폼 · 단추 · 입력 · 스크립트 없음(이 조각에는 접수가 없다).
 * 또 버전 목록의 줄마다 이 화면으로 가는 링크("이 버전으로" · 지금 버전은 "다시 올리기"). */
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

import RedeployPreviewPage from "@/app/deploys/redeploy/page";
import DeployVersionsPage from "@/app/deploys/versions/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { gitCommitRangeJson, masterGitFailure, masterGitSuccess } from "@/features/deploy-detail/lib/deploy-git-test-fakes";
import { branchFrom, installCommitGraph, type GraphCommit } from "@/features/deploy-redeploy/lib/redeploy-test-fakes";
import {
  MASTER_DEPLOYS_PATH, MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH, createFakeMaster, deploymentJson, minutesAfterStart, type FakeMaster,
} from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, expectNoForbiddenText, expectReadOnlyRequest, leakyErrorBody, leakyNetworkError, textResponse,
} from "@/shared/lib/upstream-test-fakes";

type Renderer = { renderToStaticMarkup: (node: unknown) => string };

async function render(page: (props: { searchParams: Promise<Record<string, string | string[]>> }) => Promise<unknown>, searchParams: Record<string, string | string[]>): Promise<string> {
  const element: unknown = await page({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  return ((await import(/* @vite-ignore */ rendererModuleName)) as Renderer).renderToStaticMarkup(element);
}

const renderRedeploy = (searchParams: Record<string, string | string[]>) => render(RedeployPreviewPage, searchParams);
const renderVersions = (searchParams: Record<string, string | string[]>) => render(DeployVersionsPage, searchParams);

function mainOf(html: string): string {
  const match = /<main[\s>][\s\S]*<\/main>/.exec(html);
  expect(match, "본문 <main> 이 있다").not.toBeNull();
  return match![0];
}

/** 본문의 표 몸통 줄(<td> 가 있는 <tr>). */
function bodyRows(html: string): string[] {
  return [...mainOf(html).matchAll(/<tr[\s>][\s\S]*?<\/tr>/g)].map((match) => match[0]).filter((row) => row.includes("<td"));
}

function short(commit: GraphCommit | string): string {
  return (typeof commit === "string" ? commit : commit.sha).slice(0, 7);
}

let main: GraphCommit[];
let master: FakeMaster;

/** 기본 이력: 지금 = main[4](배포 스크립트), 그 앞 성공 main[3] · main[1] · main[0]. main[2] 는 배포된 적 없다. */
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  state.restricted = false;
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  main = branchFrom(null, ["첫 커밋", "로그인 고침", "표에 칸 더함", "목록 정렬", "배포 스크립트", "여섯째 커밋"]);
  master = createFakeMaster([
    deploymentJson("backend", main[4].sha, "succeeded", minutesAfterStart(40)),
    deploymentJson("backend", main[3].sha, "succeeded", minutesAfterStart(30)),
    deploymentJson("backend", main[1].sha, "succeeded", minutesAfterStart(20)),
    deploymentJson("backend", main[0].sha, "succeeded", minutesAfterStart(10)),
  ]);
  installCommitGraph(master, main);
  vi.stubGlobal("fetch", master.fetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("되돌리기 — 지금 버전 → 고른 버전, 사라지게 되는 커밋", () => {
  it("서비스 · 지금 버전(짧은 SHA · 전체 title · 제목 · 마지막 배포 KST) · 고른 버전(같은 칸)", async () => {
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: main[1].sha }));
    expect(main_).toContain("backend");
    expect(main_).toContain("지금 버전");
    expect(main_).toContain("고른 버전");
    for (const [commit, subject, kst] of [[main[4], "배포 스크립트", "2026-11-20 09:43:00"], [main[1], "로그인 고침", "2026-11-20 09:23:00"]] as const) {
      expect(main_).toContain(`title="${commit.sha}"`);
      expect(main_).toContain(`>${short(commit)}<`);
      expect(main_).toContain(subject);
      expect(main_).toContain(kst);
    }
    expect(main_.indexOf("지금 버전")).toBeLessThan(main_.indexOf("고른 버전"));
  });

  it("'되돌립니다' + '사라지는 커밋 3개' + 표(최신순 — 지금 버전 쪽이 위) · 배포된 적 없는 사이 커밋도 보인다", async () => {
    const html = await renderRedeploy({ service: "backend", commit: main[1].sha });
    const main_ = mainOf(html);
    expect(main_).toContain("되돌립니다");
    expect(main_).not.toContain("앞으로 올립니다");
    expect(main_).toContain("사라지는 커밋 3개");
    const rows = bodyRows(html);
    const indexOf = (commit: GraphCommit) => rows.findIndex((row) => row.includes(`>${short(commit)}<`));
    expect(indexOf(main[4])).toBeGreaterThanOrEqual(0);
    expect(indexOf(main[4])).toBeLessThan(indexOf(main[3]));
    expect(indexOf(main[3])).toBeLessThan(indexOf(main[2]));
    expect(rows[indexOf(main[2])]).toContain("표에 칸 더함");
    expect(rows.some((row) => row.includes(`>${short(main[0])}<`))).toBe(false);   // 고른 버전 앞의 커밋은 없다
  });

  it("되돌릴 때는 데이터 꼴 안내 — 목록을 보고 판단하세요", async () => {
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: main[1].sha }));
    expect(main_).toContain("데이터 꼴(표의 구조)을 바꾼 커밋이 사이에 있으면 되돌린 뒤 앱이 깨질 수 있습니다");
    expect(main_).toContain("목록을 보고 판단하세요");
  });

  it("버전 목록으로 돌아가는 링크(그 서비스)", async () => {
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: main[1].sha }));
    expect(main_).toMatch(/<a[^>]*href="\/deploys\/versions\?service=backend"[^>]*>버전 목록으로</);
  });
});

describe("앞으로 · 같은 버전 · 판정 못 함", () => {
  it("앞으로 — 옛 버전으로 되돌린 상태에서 새 버전을 고르면 '앞으로 올립니다' + '더해지는 커밋 3개'", async () => {
    master.deployments = [
      deploymentJson("backend", main[1].sha, "succeeded", minutesAfterStart(50)),
      deploymentJson("backend", main[4].sha, "succeeded", minutesAfterStart(40)),
      deploymentJson("backend", main[1].sha, "succeeded", minutesAfterStart(20)),
      deploymentJson("backend", main[0].sha, "succeeded", minutesAfterStart(10)),
    ];
    const html = await renderRedeploy({ service: "backend", commit: main[4].sha });
    const main_ = mainOf(html);
    expect(main_).toContain("앞으로 올립니다");
    expect(main_).not.toContain("되돌립니다");
    expect(main_).toContain("더해지는 커밋 3개");
    for (const commit of [main[4], main[3], main[2]]) expect(bodyRows(html).some((row) => row.includes(`>${short(commit)}<`))).toBe(true);
  });

  it("같은 버전 — '같은 버전을 다시 올립니다', 사이의 커밋 표 · 데이터 꼴 안내 없음", async () => {
    const html = await renderRedeploy({ service: "backend", commit: main[4].sha });
    const main_ = mainOf(html);
    expect(main_).toContain("같은 버전을 다시 올립니다");
    expect(main_).not.toContain("되돌립니다");
    expect(main_).not.toContain("사라지는 커밋");
    expect(main_).not.toContain("더해지는 커밋");
    expect(main_).not.toContain("데이터 꼴");
    expect(bodyRows(html)).toEqual([]);
  });

  it("갈라진 이력 — '두 버전의 앞뒤를 확인하지 못함 — 갈라진 이력', 두 SHA 는 그대로 · 방향 글 없음", async () => {
    const side = branchFrom(main[2], ["옆 가지 하나", "옆 가지 둘"]);
    installCommitGraph(master, [...main, ...side]);
    master.deployments = [
      deploymentJson("backend", main[4].sha, "succeeded", minutesAfterStart(40)),
      deploymentJson("backend", side[1].sha, "succeeded", minutesAfterStart(30)),
      deploymentJson("backend", main[0].sha, "succeeded", minutesAfterStart(10)),
    ];
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: side[1].sha }));
    expect(main_).toContain("두 버전의 앞뒤를 확인하지 못함");
    expect(main_).toContain("갈라진 이력");
    expect(main_).toContain(`title="${main[4].sha}"`);
    expect(main_).toContain(`title="${side[1].sha}"`);
    for (const word of ["되돌립니다", "앞으로 올립니다", "같은 버전을 다시 올립니다"]) expect(main_).not.toContain(word);
  });

  it("얕은 이력(relation unknown) — '두 버전의 앞뒤를 확인하지 못함 — 서버의 git 이력이 얕아 판정할 수 없음'", async () => {
    master.override[MASTER_GIT_COMMITS_PATH] = () => masterGitSuccess(gitCommitRangeJson([], { relation: "unknown", range_complete: false }));
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: main[1].sha }));
    expect(main_).toContain("두 버전의 앞뒤를 확인하지 못함");
    expect(main_).toContain("서버의 git 이력이 얕아 판정할 수 없음");
    expect(main_).not.toContain("되돌립니다");
  });

  it.each([
    ["git 이력에 없음(404)", () => masterGitFailure(404, "commit_not_found"), "이 서버의 git 이력에 없음"],
    ["agent 없는 서비스(422)", () => masterGitFailure(422, "invalid_request"), "요청 조건 거절됨"],
    ["연결 실패", () => Promise.reject(leakyNetworkError()), "닿지 않음"],
  ] as const)("git 조회 %s — '두 버전의 앞뒤를 확인하지 못함 — <까닭>', 두 SHA 는 그대로 · 제목 없음", async (_label, behavior, reason) => {
    master.override[MASTER_GIT_COMMITS_PATH] = behavior;
    master.override[MASTER_GIT_COMMIT_PATH] = behavior;
    const html = await renderRedeploy({ service: "backend", commit: main[1].sha });
    const main_ = mainOf(html);
    expect(main_).toContain("두 버전의 앞뒤를 확인하지 못함");
    expect(main_).toContain(reason);
    expect(main_).toContain(`title="${main[4].sha}"`);
    expect(main_).toContain(`title="${main[1].sha}"`);
    expect(main_).toContain("제목 없음");
    expect(main_).not.toContain("되돌립니다");
    expectNoForbiddenText(html);
  });

  it("사이의 커밋이 100개를 넘으면 '커밋이 100개보다 많아 일부만 보입니다' · 표는 100줄", async () => {
    const long = branchFrom(null, Array.from({ length: 130 }, (_, index) => `커밋 ${index}`));
    installCommitGraph(master, long);
    master.deployments = [
      deploymentJson("backend", long[129].sha, "succeeded", minutesAfterStart(40)),
      deploymentJson("backend", long[0].sha, "succeeded", minutesAfterStart(10)),
    ];
    const html = await renderRedeploy({ service: "backend", commit: long[0].sha });
    expect(mainOf(html)).toContain("커밋이 100개보다 많아 일부만 보입니다");
    expect(bodyRows(html)).toHaveLength(100);
  });

  it("범위에 얕은 경계가 들어 있으면 '일부가 빠졌을 수 있습니다'", async () => {
    const graphRange = master.override[MASTER_GIT_COMMITS_PATH]!;
    master.override[MASTER_GIT_COMMITS_PATH] = async (url, init) => {
      const response = await graphRange(url, init);
      const body = await response.json();
      if (body.success && body.data.relation === "ancestor") body.data.range_complete = false;
      return masterGitSuccess(body.data);
    };
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: main[1].sha }));
    expect(main_).toContain("되돌립니다");
    expect(main_).toContain("일부가 빠졌을 수 있습니다");
  });

  it("상한 · 경계에 닿지 않았으면 그 안내가 없다", async () => {
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: main[1].sha }));
    expect(main_).not.toContain("일부만 보입니다");
    expect(main_).not.toContain("일부가 빠졌을 수 있습니다");
  });

  it("커밋 제목의 꺾쇠는 글자로", async () => {
    main[2].subject = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: main[1].sha }));
    expect(main_).not.toContain("<script");
    expect(main_).not.toContain("<img");
    expect(main_).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("고를 수 없는 버전 · 진행 중 · 틀린 입력 · 실패", () => {
  it.each([
    ["배포된 적 없는 커밋(사이 커밋)", () => main[2].sha],
    ["실패한 배포의 커밋", () => {
      master.deployments.unshift(deploymentJson("backend", main[5].sha, "failed", minutesAfterStart(45)));
      return main[5].sha;
    }],
    ["다른 서비스에서만 성공한 커밋", () => {
      master.deployments.unshift(deploymentJson("front", main[5].sha, "succeeded", minutesAfterStart(45)));
      return main[5].sha;
    }],
  ] as const)("%s → '배포된 적 없는 버전은 고를 수 없습니다', 비교 없음 · 돌아가는 링크", async (_label, choose) => {
    const commit = choose();
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit }));
    expect(main_).toContain("배포된 적 없는 버전은 고를 수 없습니다");
    for (const word of ["되돌립니다", "앞으로 올립니다", "같은 버전을 다시 올립니다", "사라지는 커밋", "두 버전의 앞뒤"]) expect(main_).not.toContain(word);
    expect(main_).toContain('href="/deploys/versions?service=backend"');
    expect(master.gitRequests().filter((url) => url.search.includes(commit))).toEqual([]);
  });

  it("진행 중인 배포가 있으면 '배포 진행 중 — 끝난 뒤에 올릴 수 있습니다'(비교는 그대로)", async () => {
    master.deployments.unshift(deploymentJson("backend", main[5].sha, "ci_running", minutesAfterStart(50)));
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: main[1].sha }));
    expect(main_).toContain("배포 진행 중 — 끝난 뒤에 올릴 수 있습니다");
    expect(main_).toContain("되돌립니다");
  });

  it("진행 중인 배포가 없으면 그 안내가 없다", async () => {
    expect(mainOf(await renderRedeploy({ service: "backend", commit: main[1].sha }))).not.toContain("배포 진행 중");
  });

  it.each([
    [{ service: "backend", commit: "0123456" }, "커밋", 'href="/deploys/versions?service=backend"'],
    [{ service: "backend" }, "커밋", 'href="/deploys/versions?service=backend"'],
    [{ service: "nope", commit: "0123456789abcdef0123456789abcdef01234567" }, "서비스", 'href="/deploys/versions"'],
    [{}, "서비스", 'href="/deploys/versions"'],
  ] as const)("틀린 입력 %j → '조회 조건이 맞지 않습니다'(%s) · 버전 목록 링크 · master 0회", async (input, label, link) => {
    const main_ = mainOf(await renderRedeploy(input as Record<string, string>));
    expect(main_).toContain("조회 조건이 맞지 않습니다");
    expect(main_).toContain(`${label} 값을 확인하세요`);
    expect(main_).toContain(link);
    expect(master.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["닿지 못함", () => Promise.reject(leakyNetworkError()), "배포 서버: 닿지 않음"],
    ["503", () => textResponse(leakyErrorBody(), 503), "배포 서버: 서버 일시 장애 · HTTP 503"],
  ] as const)("이력 조회 %s → '확인하지 못함' + 까닭(비교 없음) · 머리 · 내비게이션 그대로", async (_label, behavior, words) => {
    master.override[MASTER_DEPLOYS_PATH] = behavior;
    const html = await renderRedeploy({ service: "backend", commit: main[1].sha });
    const main_ = mainOf(html);
    expect(main_).toContain("확인하지 못함");
    expect(main_).toContain(words);
    expect(main_).not.toContain("되돌립니다");
    expect(main_).toContain('href="/deploys/versions?service=backend"');
    expect(html).toContain("로그아웃");
    expect(html).toMatch(/<a[^>]*href="\/deploys"[^>]*>배포 이력</);
    expectNoForbiddenText(html);
  });

  it("설정 없음 → '배포 서버: 설정 없음', master 0회", async () => {
    vi.stubEnv("DEPLOY_MASTER_URL", "");
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: main[1].sha }));
    expect(main_).toContain("배포 서버: 설정 없음");
    expect(master.fetch).not.toHaveBeenCalled();
  });
});

describe("아무것도 바꾸지 않는다 — 이 조각에는 접수가 없다", () => {
  it.each([["되돌리기", 1], ["같은 버전", 4]] as const)("%s 화면의 본문에 폼 · 단추 · 입력 · 스크립트가 없다 · master 요청은 전부 GET", async (_label, index) => {
    const html = await renderRedeploy({ service: "backend", commit: main[index].sha });
    const main_ = mainOf(html);
    expect(main_).not.toMatch(/<form[\s>]/i);
    expect(main_).not.toMatch(/<button[\s>]/i);
    expect(main_).not.toMatch(/<input[\s>]/i);
    expect(main_).not.toMatch(/<textarea[\s>]/i);
    expect(main_).not.toMatch(/method="post"/i);
    expect(main_).not.toMatch(/<script[\s>]/i);
    expect(master.fetch).toHaveBeenCalled();
    for (const [, init] of master.fetch.mock.calls) expectReadOnlyRequest(init);
    expectNoForbiddenText(html);
    expect(html).not.toContain(FAKE_DEPLOY_MASTER_URL);
  });

  it("내비게이션 — 버전 목록이 지금 화면 · 로그아웃", async () => {
    const html = await renderRedeploy({ service: "backend", commit: main[1].sha });
    expect(html).toMatch(/href="\/deploys\/versions" aria-current="page"[^>]*>버전 목록</);
    expect(html).toContain("로그아웃");
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
    walk(join(sourceRoot, "features", "deploy-redeploy"));
    walk(join(sourceRoot, "app", "deploys", "redeploy"));
    walk(join(sourceRoot, "app", "api", "deploys", "redeploy"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/^\s*["']use client["']/m);
  });
});

describe("버전 목록의 줄마다 확인 화면으로 가는 링크(GET)", () => {
  it("지금 버전의 줄은 '다시 올리기', 나머지 줄은 '이 버전으로' — 주소에 서비스와 전체 SHA", async () => {
    const html = await renderVersions({ service: "backend" });
    const rows = bodyRows(html);
    for (const commit of [main[4], main[3], main[1], main[0]]) {
      const row = rows.find((each) => each.includes(`>${short(commit)}<`));
      expect(row, short(commit)).toBeDefined();
      expect(row).toContain(`href="/deploys/redeploy?service=backend&amp;commit=${commit.sha}"`);
      if (commit === main[4]) {
        expect(row).toMatch(/>다시 올리기</);
        expect(row).not.toContain("이 버전으로");
      } else {
        expect(row).toMatch(/>이 버전으로</);
        expect(row).not.toContain("다시 올리기");
      }
    }
    expect(mainOf(html)).not.toMatch(/<form[\s>]|<button[\s>]/i);
  });
});
