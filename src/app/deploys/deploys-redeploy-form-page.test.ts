/** 재배포 확인 화면의 접수 폼(6-4) — 실제 렌더. 폼은 comparison 이고 진행 중인 배포가 없을 때만(방향을 판정하지 못해도 — 안내와 함께) ·
 * POST /api/deploys/redeploy · 비밀번호(type=password · autocomplete=current-password · 이름표) · 숨은 칸(서비스 · 커밋 · 확인 값) ·
 * 단추의 글에 서비스와 짧은 SHA · 확인 값은 이 화면이 그릴 때 정한 요청 ID 를 담고 세션 키로 검증된다 · 주소(쿼리)에 확인 값이 없다 ·
 * 계정 이름이 requested_by 로 쓸 수 없으면 폼 대신 안내 · 스크립트 없음. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => false }));
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
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { REDEPLOY_REQUEST_ID_PATTERN, verifyRedeployConfirmation } from "@/features/deploy-redeploy/lib/redeploy-confirmation";
import { branchFrom, installCommitGraph, type GraphCommit } from "@/features/deploy-redeploy/lib/redeploy-test-fakes";
import { loadRedeployPreview } from "@/features/deploy-redeploy/server/redeploy-preview";
import { MASTER_DEPLOYS_PATH, createFakeMaster, deploymentJson, minutesAfterStart, type FakeMaster } from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import { FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, expectNoForbiddenText, expectReadOnlyRequest, leakyErrorBody, textResponse } from "@/shared/lib/upstream-test-fakes";

type Renderer = { renderToStaticMarkup: (node: unknown) => string };

async function renderRedeploy(searchParams: Record<string, string | string[]>): Promise<string> {
  const element: unknown = await RedeployPreviewPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  return ((await import(/* @vite-ignore */ rendererModuleName)) as Renderer).renderToStaticMarkup(element);
}

function mainOf(html: string): string {
  const match = /<main[\s>][\s\S]*<\/main>/.exec(html);
  expect(match, "본문 <main> 이 있다").not.toBeNull();
  return match![0];
}

function formsOf(html: string): string[] {
  return [...mainOf(html).matchAll(/<form[\s>][\s\S]*?<\/form>/gi)].map((match) => match[0]);
}

/** 태그 하나의 속성(이름 → 값, & 등은 되돌린다). */
function attributesOf(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
    attributes[match[1].toLowerCase()] = match[2].replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return attributes;
}

function inputsOf(form: string): Record<string, string>[] {
  return [...form.matchAll(/<input[^>]*>/gi)].map((match) => attributesOf(match[0]));
}

function hiddenValue(form: string, name: string): string | undefined {
  return inputsOf(form).find((input) => input.name === name && input.type === "hidden")?.value;
}

let main: GraphCommit[];
let master: FakeMaster;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_USER", FAKE_ADMIN_ID);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  vi.stubEnv("LOG_REDIS_URL", "");
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  main = branchFrom(null, ["첫 커밋", "로그인 고침", "표에 칸 더함", "목록 정렬", "배포 스크립트"]);
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

describe("폼의 꼴", () => {
  it("POST /api/deploys/redeploy(주소에 쿼리 없음) · 숨은 칸 서비스 · 커밋(전체 SHA) · 확인 값 · 비밀번호 칸 · 단추", async () => {
    const forms = formsOf(await renderRedeploy({ service: "backend", commit: main[1].sha }));
    expect(forms).toHaveLength(1);
    const form = forms[0];
    const formTag = attributesOf(/<form[^>]*>/i.exec(form)![0]);
    expect(formTag.method?.toLowerCase()).toBe("post");
    expect(formTag.action).toBe("/api/deploys/redeploy");
    expect(hiddenValue(form, "service")).toBe("backend");
    expect(hiddenValue(form, "commit")).toBe(main[1].sha);
    expect(hiddenValue(form, "confirmation")).toMatch(/^rc1\./);
    const password = inputsOf(form).find((input) => input.name === "password");
    expect(password).toMatchObject({ type: "password", autocomplete: "current-password" });
    expect(password).toHaveProperty("required");
    // 이름표 — <label for=id> 또는 칸을 감싼 <label>
    const labelledById = password!.id !== undefined && new RegExp(`<label[^>]*for="${password!.id}"[^>]*>[^<]*비밀번호`).test(form);
    const wrapped = /<label[^>]*>[^<]*비밀번호[\s\S]*?<input[^>]*name="password"[\s\S]*?<\/label>/.test(form);
    expect(labelledById || wrapped, "비밀번호 칸의 이름표").toBe(true);
    const buttons = [...form.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)];
    expect(buttons).toHaveLength(1);
    expect(attributesOf(buttons[0][0]).type ?? "submit").toBe("submit");
    expect(buttons[0][1].replace(/<[^>]+>/g, "")).toContain(`backend 를 ${main[1].sha.slice(0, 7)} 로 배포`);
    expect(inputsOf(form).map((input) => input.name).sort()).toEqual(["commit", "confirmation", "password", "service"]);
  });

  it("확인 값은 세션 키 · 이 계정 · 이 서비스 · 이 커밋으로 검증되고, 요청 ID 는 master 가 받는 꼴(adm-…)", async () => {
    const form = formsOf(await renderRedeploy({ service: "backend", commit: main[1].sha }))[0];
    const confirmation = hiddenValue(form, "confirmation")!;
    const check = verifyRedeployConfirmation(confirmation, FAKE_SIGNING_KEY, { service: "backend", commitSha: main[1].sha, account: FAKE_ADMIN_ID }, Date.now());
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.requestId).toMatch(REDEPLOY_REQUEST_ID_PATTERN);
    expect(check.requestId.startsWith("adm-")).toBe(true);
    expect(Math.abs(Date.now() - check.issuedAt)).toBeLessThan(60_000);
    expect(verifyRedeployConfirmation(confirmation, FAKE_SIGNING_KEY, { service: "backend", commitSha: main[3].sha, account: FAKE_ADMIN_ID }, Date.now()).ok).toBe(false);
  });

  it("다시 그리면(새로 고침) 새 요청 ID", async () => {
    const first = hiddenValue(formsOf(await renderRedeploy({ service: "backend", commit: main[1].sha }))[0], "confirmation")!;
    const second = hiddenValue(formsOf(await renderRedeploy({ service: "backend", commit: main[1].sha }))[0], "confirmation")!;
    expect(first.split(".")[1]).not.toBe(second.split(".")[1]);
  });

  it("확인 값은 링크 · 주소에 실리지 않는다 · 비밀값 · 세션 키 · master 주소 없음 · 스크립트 없음 · master 요청은 GET 뿐", async () => {
    const html = await renderRedeploy({ service: "backend", commit: main[1].sha });
    const confirmation = hiddenValue(formsOf(html)[0], "confirmation")!;
    for (const match of html.matchAll(/(?:href|action|src)="([^"]*)"/g)) expect(match[1]).not.toContain(confirmation.split(".")[3]);
    expect(html).not.toContain(FAKE_SIGNING_KEY);
    expect(html).not.toContain(FAKE_DEPLOY_MASTER_URL);
    expectNoForbiddenText(html);
    expect(mainOf(html)).not.toMatch(/<script[\s>]/i);
    for (const [, init] of master.fetch.mock.calls) expectReadOnlyRequest(init);
  });

  it("화면 모델 — submission 은 form(확인 값 · 요청 ID)", async () => {
    const view = await loadRedeployPreview({ service: "backend", commit: main[1].sha });
    expect(view.submission).toMatchObject({ kind: "form" });
    if (view.submission?.kind !== "form") return;
    expect(view.submission.confirmation.split(".")[1]).toBe(view.submission.requestId);
  });
});

describe("폼이 있는 때 · 없는 때", () => {
  it("같은 버전(다시 올리기)에도 폼", async () => {
    expect(formsOf(await renderRedeploy({ service: "backend", commit: main[4].sha }))).toHaveLength(1);
  });

  it("방향을 판정하지 못해도 폼은 있다 — 폼 위에 '그래도 올리려면' 안내", async () => {
    const side = branchFrom(main[2], ["옆 가지"]);
    installCommitGraph(master, [...main, ...side]);
    master.deployments.splice(1, 0, deploymentJson("backend", side[0].sha, "succeeded", minutesAfterStart(35)));
    const main_ = mainOf(await renderRedeploy({ service: "backend", commit: side[0].sha }));
    expect(main_).toContain("두 버전의 앞뒤를 확인하지 못");
    expect(main_).toContain("그래도 올리려면");
    expect(formsOf(main_)).toHaveLength(1);
    expect(main_.indexOf("그래도 올리려면")).toBeLessThan(main_.indexOf("<form"));
  });

  it("진행 중인 배포가 있으면 폼이 없다(안내만)", async () => {
    master.deployments.unshift(deploymentJson("backend", main[4].sha, "ci_running", minutesAfterStart(50)));
    const html = await renderRedeploy({ service: "backend", commit: main[1].sha });
    expect(mainOf(html)).toContain("배포 진행 중 — 끝난 뒤에 올릴 수 있습니다");
    expect(formsOf(html)).toEqual([]);
    expect(mainOf(html)).not.toMatch(/<input[\s>]|<button[\s>]/i);
    expect((await loadRedeployPreview({ service: "backend", commit: main[1].sha })).submission).toBeNull();
  });

  it.each([
    ["성공 이력에 없는 커밋", () => ({ service: "backend", commit: main[2].sha })],
    ["틀린 입력", () => ({ service: "backend", commit: "0123456" })],
  ])("%s → 폼 없음", async (_label, input) => {
    const html = await renderRedeploy(input());
    expect(formsOf(html)).toEqual([]);
    expect(mainOf(html)).not.toMatch(/<input[\s>]|<button[\s>]/i);
  });

  it("이력 조회 실패 → 폼 없음", async () => {
    master.override[MASTER_DEPLOYS_PATH] = () => textResponse(leakyErrorBody(), 503);
    const html = await renderRedeploy({ service: "backend", commit: main[1].sha });
    expect(formsOf(html)).toEqual([]);
  });

  it.each(["jun@example.com", "준형", "jun kim"])("계정 이름 %j 은 requested_by 로 쓸 수 없다 → 폼 대신 '이 계정 이름으로는 배포를 일으킬 수 없습니다'", async (account) => {
    vi.stubEnv("ADMIN_USER", account);
    const html = await renderRedeploy({ service: "backend", commit: main[1].sha });
    expect(formsOf(html)).toEqual([]);
    expect(mainOf(html)).toContain("이 계정 이름으로는 배포를 일으킬 수 없습니다");
    expect(mainOf(html)).toContain("되돌립니다");   // 비교는 그대로 보인다
    expect((await loadRedeployPreview({ service: "backend", commit: main[1].sha })).submission).toEqual({ kind: "account_not_allowed" });
  });
});
