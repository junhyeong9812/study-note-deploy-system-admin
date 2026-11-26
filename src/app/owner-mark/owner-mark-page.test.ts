/** 주인 표시 화면(/owner-mark) — 실제 렌더(서버 컴포넌트 → HTML) · 명세 §17 2b.
 * 이 브라우저의 상태: 요청에 실려 온 study_owner 를 backend 와 같은 규칙으로 판정해 보인다(주인 · 만든 날 · 끝나는 날 / 표시 없음 / 쓸 수 없음(까닭의 낱말)).
 * 설정이 쓸 수 없으면 단추 대신 "설정 없음"(무엇이 없는지 이름으로). 쿠키의 값 · 서명 · 열쇠는 HTML · 화면 데이터에 없다. 스크립트 없이 동작하는 폼. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 요청의 쿠키 — 사례는 Map 으로 한 이름에 한 값을 두거나(cookies), 날 `Cookie` 머리글을 그대로 둔다(rawCookieHeader — 같은 이름 둘 · 공백 · 빈 값).
 * 가짜 headers() 는 그 날 머리글을, 가짜 cookies() 는 Next 처럼 그 머리글을 풀어 **같은 이름이면 마지막 값 하나만** 준다(명세 §18 — 실행으로 확인된 Next 의 동작). */
const state = vi.hoisted(() => {
  const cookies = new Map<string, string>();
  const holder = { cookies, rawCookieHeader: null as string | null };
  const header = (): string | null => holder.rawCookieHeader ?? (cookies.size === 0 ? null : [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
  const parsed = (): Map<string, string> => {
    const result = new Map<string, string>();
    for (const piece of (header() ?? "").split(";")) {
      const at = piece.indexOf("=");
      if (at < 0) continue;
      result.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());   // 같은 이름은 마지막 값이 남는다
    }
    return result;
  };
  return Object.assign(holder, { header, parsed });
});

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => false }));
vi.mock("next/headers", () => ({
  cookies: async () => {
    const parsed = state.parsed();
    return {
      get: (name: string) => (parsed.has(name) ? { name, value: parsed.get(name)! } : undefined),
      has: (name: string) => parsed.has(name),
      getAll: (name?: string) => [...parsed].filter(([key]) => name === undefined || key === name).map(([key, value]) => ({ name: key, value })),
    };
  },
  headers: async () => {
    const header = state.header();
    return new Headers(header === null ? {} : { cookie: header });
  },
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import OwnerMarkPage from "@/app/owner-mark/page";
import { GET as ownerMarkGet } from "@/app/api/owner-mark/route";
import { ADMIN_SCREENS } from "@/features/admin-shell/ui/admin-screens";
import { SESSION_COOKIE_NAME, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { ownerMarkValue } from "@/features/owner-mark/lib/owner-mark";
import { FAKE_OWNER_COOKIE_DOMAIN, FAKE_OWNER_COOKIE_SECRET } from "@/features/owner-mark/lib/owner-mark-test-fakes";

const NOW = Date.UTC(2026, 10, 28, 3, 0, 0);   // 2026-11-28 12:00:00 KST
const DAY = 24 * 60 * 60 * 1000;

async function render(): Promise<string> {
  const element = await OwnerMarkPage();
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function textOf(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/\s+/g, " ");
}

function section(html: string, key: "status" | "actions"): string {
  const match = new RegExp(`<section[^>]*aria-labelledby="owner-mark-${key}-title"[^>]*>([\\s\\S]*?)</section>`).exec(html);
  expect(match, `${key} 칸이 없다`).not.toBeNull();
  expect(match![1]).toMatch(new RegExp(`<h2[^>]*id="owner-mark-${key}-title"`));
  return match![1];
}

function forms(fragment: string): { action: string; method: string; button: string; inputs: string[] }[] {
  return [...fragment.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)].map(([, attributes, body]) => ({
    action: /action="([^"]*)"/.exec(attributes)?.[1] ?? "",
    method: (/method="([^"]*)"/.exec(attributes)?.[1] ?? "").toLowerCase(),
    button: textOf(/<button[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/.exec(body)?.[1] ?? "").trim(),
    inputs: [...body.matchAll(/<input[^>]*>/g)].map((match) => match[0]),
  }));
}

function alerts(fragment: string): string[] {
  return [...fragment.matchAll(/<(p|div)[^>]*role="alert"[^>]*>([\s\S]*?)<\/\1>/g)].map((match) => textOf(match[2]).trim());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("LOG_REDIS_URL", "");
  vi.stubEnv("OWNER_COOKIE_SECRET", FAKE_OWNER_COOKIE_SECRET);
  vi.stubEnv("OWNER_COOKIE_DOMAIN", FAKE_OWNER_COOKIE_DOMAIN);
  state.cookies.clear();
  state.rawCookieHeader = null;
  state.cookies.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, NOW - 60_000));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("주인 표시 화면은 다른 서버를 부르지 않는다"); }));
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

describe("5 화면 — 제목 · 설명 · 내비게이션", () => {
  it("제목 '주인 표시' · 주인 표시가 무엇인지 한 줄(이 브라우저에서만 Claude 대체 답변과 실습 · 30일 · 되돌리는 법)", async () => {
    const html = await render();
    expect(html).toContain(">주인 표시</h1>");
    const text = textOf(html);
    expect(text).toContain("이 브라우저에서만 Claude 대체 답변과 실습을 쓸 수 있습니다");
    expect(text).toContain("30일");
    expect(text).toContain("주인 표시 지우기");
    expect(text).toContain("OWNER_COOKIE_SECRET 을 바꾸면 모든 표시가 한꺼번에 없어집니다");
  });

  it("화면 목록과 메뉴에 든다 — key owner-mark · '주인 표시' · /owner-mark · 지금 화면 표시", async () => {
    expect(ADMIN_SCREENS.find((screen) => screen.key === "owner-mark")).toMatchObject({ title: "주인 표시", path: "/owner-mark" });
    expect(await render()).toMatch(/<a[^>]*href="\/owner-mark"[^>]*aria-current="page"[^>]*>주인 표시<\/a>/);
  });

  it("단추 둘 — 폼의 POST(스크립트 없이) · 이 브라우저를 주인으로 표시 → /api/owner-mark · 주인 표시 지우기 → /api/owner-mark/clear · 숨은 칸 없음", async () => {
    const html = await render();
    expect(forms(section(html, "actions"))).toEqual([
      { action: "/api/owner-mark", method: "post", button: "이 브라우저를 주인으로 표시", inputs: [] },
      { action: "/api/owner-mark/clear", method: "post", button: "주인 표시 지우기", inputs: [] },
    ]);
    expect(html).not.toContain("<script");
  });
});

describe("5 이 브라우저의 상태 — backend 와 같은 규칙으로 판정", () => {
  it("맞는 표시 → '주인으로 표시됨' · 만든 날 · 끝나는 날(30일 뒤 — KST)", async () => {
    state.cookies.set("study_owner", ownerMarkValue(FAKE_OWNER_COOKIE_SECRET, NOW - DAY));
    const status = textOf(section(await render(), "status"));
    expect(status).toContain("주인으로 표시됨");
    expect(status).toContain("만든 날 2026-11-27 12:00:00");
    expect(status).toContain("끝나는 날 2026-12-27 12:00:00");
  });

  it("표시 없음 → '표시 없음'", async () => {
    const status = section(await render(), "status");
    expect(textOf(status)).toContain("표시 없음");
    expect(textOf(status)).not.toContain("주인으로 표시됨");
  });

  it.each([
    ["다른 열쇠로 서명", () => ownerMarkValue("fake-other-owner-secret-0000000000000", NOW - DAY), "bad_signature"],
    ["30일이 지남", () => ownerMarkValue(FAKE_OWNER_COOKIE_SECRET, NOW - 31 * DAY), "expired"],
    ["꼴이 틀림", () => "ow1.not-a-time.x", "malformed"],
    ["61초 미래", () => ownerMarkValue(FAKE_OWNER_COOKIE_SECRET, NOW + 61_000), "malformed"],
  ] as [string, () => string, string][])("%s → '표시가 있으나 쓸 수 없음 (%s)'", async (_label, makeValue, reason) => {
    state.cookies.set("study_owner", makeValue());
    const status = textOf(section(await render(), "status"));
    expect(status).toContain(`표시가 있으나 쓸 수 없음 (${reason})`);
    expect(status).not.toContain("주인으로 표시됨");
  });

  it("열쇠가 없으면 판정할 수 없다 — '판정할 수 없음 — 열쇠 설정 없음 (no_secret)'", async () => {
    vi.stubEnv("OWNER_COOKIE_SECRET", "");
    state.cookies.set("study_owner", ownerMarkValue(FAKE_OWNER_COOKIE_SECRET, NOW - DAY));
    expect(textOf(section(await render(), "status"))).toContain("판정할 수 없음 — 열쇠 설정 없음 (no_secret)");
  });

  it("열쇠를 다듬지 않는다 — 앞뒤 공백이 낀 열쇠로 만든 표시는 그 열쇠 그대로일 때만 주인", async () => {
    const padded = ` ${FAKE_OWNER_COOKIE_SECRET} `;
    vi.stubEnv("OWNER_COOKIE_SECRET", padded);
    state.cookies.set("study_owner", ownerMarkValue(padded, NOW - DAY));
    expect(textOf(section(await render(), "status"))).toContain("주인으로 표시됨");
    state.cookies.set("study_owner", ownerMarkValue(FAKE_OWNER_COOKIE_SECRET, NOW - DAY));
    expect(textOf(section(await render(), "status"))).toContain("표시가 있으나 쓸 수 없음 (bad_signature)");
  });

  it("쿠키의 값 · 서명 · 열쇠는 HTML 에 없다", async () => {
    const value = ownerMarkValue(FAKE_OWNER_COOKIE_SECRET, NOW - DAY);
    state.cookies.set("study_owner", value);
    const html = await render();
    for (const secret of [value, value.split(".")[2], FAKE_OWNER_COOKIE_SECRET]) expect(html).not.toContain(secret);
  });
});

describe("2 설정이 쓸 수 없으면 — 단추 대신 '설정 없음'(무엇이 없는지 이름으로 · 값은 보이지 않는다)", () => {
  it.each([
    ["열쇠 없음", { OWNER_COOKIE_SECRET: "" }, ["OWNER_COOKIE_SECRET"], ["주인 표시 지우기"]],
    ["열쇠가 31바이트", { OWNER_COOKIE_SECRET: "fake-owner-secret-31-bytes-xxxx" }, ["OWNER_COOKIE_SECRET"], ["주인 표시 지우기"]],
    ["도메인 없음", { OWNER_COOKIE_DOMAIN: "" }, ["OWNER_COOKIE_DOMAIN"], []],
    ["도메인 앞의 점", { OWNER_COOKIE_DOMAIN: ".example.test" }, ["OWNER_COOKIE_DOMAIN"], []],
    ["어드민이 그 도메인 밖", { OWNER_COOKIE_DOMAIN: "other.test" }, ["ADMIN_ORIGIN", "OWNER_COOKIE_DOMAIN"], []],
  ] as [string, Record<string, string>, string[], string[]][])("%s → role=alert '설정 없음' + %j · 표시하기 단추 없음 · 남는 단추 %j", async (_label, environment, names, remainingButtons) => {
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    const actions = section(await render(), "actions");
    const [alert] = alerts(actions);
    expect(alert).toContain("설정 없음");
    for (const name of names) expect(alert).toContain(name);
    expect(forms(actions).map((form) => form.button)).toEqual(remainingButtons);
    if (environment.OWNER_COOKIE_SECRET) expect(actions).not.toContain(environment.OWNER_COOKIE_SECRET);
  });

  it("어드민이 그 도메인 밖이면 까닭을 글로 — '브라우저가 쿠키를 버립니다'", async () => {
    vi.stubEnv("OWNER_COOKIE_DOMAIN", "other.test");
    expect(alerts(section(await render(), "actions"))[0]).toContain("브라우저가 쿠키를 버립니다");
  });
});

describe("§18 ① 같은 이름의 쿠키 둘 — 날 Cookie 머리글에서 세어 backend 와 같게(둘 이상 → malformed)", () => {
  const sessionPiece = () => `${SESSION_COOKIE_NAME}=${issueSessionToken(FAKE_SIGNING_KEY, NOW - 60_000)}`;
  const good = () => ownerMarkValue(FAKE_OWNER_COOKIE_SECRET, NOW - DAY);

  it.each([
    ["맞는 값 둘", () => `study_owner=${good()}; study_owner=${good()}`],
    ["쓰레기 다음 맞는 값(Next 는 맞는 값만 준다)", () => `study_owner=junk; study_owner=${good()}`],
    ["맞는 값 다음 쓰레기", () => `study_owner=${good()}; study_owner=junk`],
    ["맞는 값 다음 빈 값(빈 값도 하나로 센다)", () => `study_owner=${good()}; study_owner=`],
  ] as [string, () => string][])("%s → '표시가 있으나 쓸 수 없음 (malformed)'", async (_label, makePieces) => {
    state.rawCookieHeader = `${sessionPiece()}; ${makePieces()}`;
    const status = textOf(section(await render(), "status"));
    expect(status).toContain("표시가 있으나 쓸 수 없음 (malformed)");
    expect(status).not.toContain("주인으로 표시됨");
  });

  it("하나면 지금 그대로 — 조각 앞뒤의 공백 · 다른 이름(xstudy_owner · study_owner2 · STUDY_OWNER)은 세지 않는다", async () => {
    state.rawCookieHeader = `xstudy_owner=junk;${sessionPiece()};   study_owner=${good()}  ; study_owner2=junk; STUDY_OWNER=junk`;
    expect(textOf(section(await render(), "status"))).toContain("주인으로 표시됨");
  });

  it("GET /api/owner-mark 도 같은 판정 — 둘이면 verdict malformed", async () => {
    state.rawCookieHeader = `${sessionPiece()}; study_owner=${good()}; study_owner=${good()}`;
    const body = await (await ownerMarkGet(new Request(new URL("/api/owner-mark", FAKE_ORIGIN)))).json() as { data: { verdict: unknown } };
    expect(body.data.verdict).toEqual({ owner: false, reason: "malformed" });
  });
});

describe("§18 ② '표시 없음'의 까닭 후보 — 표시 없음이고 설정이 맞을 때만 한 줄", () => {
  const HINT = "표시하기를 눌렀는데도 표시 없음이면";

  it("표시 없음 + 설정 ok → 한 줄(OWNER_COOKIE_DOMAIN · 공개 접미사 · 브라우저가 쿠키를 막았)", async () => {
    const status = textOf(section(await render(), "status"));
    expect(status).toContain("표시 없음");
    expect(status).toContain(HINT);
    const hint = status.slice(status.indexOf(HINT));
    for (const words of ["OWNER_COOKIE_DOMAIN", "공개 접미사", "브라우저가 쿠키를 막았"]) expect(hint).toContain(words);
  });

  it.each([
    ["주인", () => { state.cookies.set("study_owner", ownerMarkValue(FAKE_OWNER_COOKIE_SECRET, NOW - DAY)); }],
    ["쓸 수 없음(expired)", () => { state.cookies.set("study_owner", ownerMarkValue(FAKE_OWNER_COOKIE_SECRET, NOW - 31 * DAY)); }],
    ["설정 없음 — 열쇠(no_secret)", () => { vi.stubEnv("OWNER_COOKIE_SECRET", ""); }],
    ["설정 없음 — 도메인(표시는 없지만 설정이 ok 가 아님)", () => { vi.stubEnv("OWNER_COOKIE_DOMAIN", ""); }],
    ["설정 없음 — 어드민이 도메인 밖", () => { vi.stubEnv("OWNER_COOKIE_DOMAIN", "other.test"); }],
  ] as [string, () => void][])("%s → 그 줄이 없다", async (_label, arrange) => {
    arrange();
    expect(textOf(await render())).not.toContain(HINT);
  });
});

describe("세션 · 화면 데이터", () => {
  it("세션이 없으면 로그인으로", async () => {
    state.cookies.delete(SESSION_COOKIE_NAME);
    await expect(render()).rejects.toThrow("redirect:/login");
  });

  it("GET /api/owner-mark — 200 · no-store · 설정과 판정(낱말 · 시각) · 쿠키의 값 · 서명 · 열쇠 없음", async () => {
    const value = ownerMarkValue(FAKE_OWNER_COOKIE_SECRET, NOW - DAY);
    state.cookies.set("study_owner", value);
    const response = await ownerMarkGet(new Request(new URL("/api/owner-mark", FAKE_ORIGIN)));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const text = await response.text();
    for (const secret of [value, value.split(".")[2], FAKE_OWNER_COOKIE_SECRET]) expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toEqual({ success: true, data: {
      settings: { ok: true, domain: FAKE_OWNER_COOKIE_DOMAIN },
      verdict: { owner: true, createdAt: NOW - DAY, expiresAt: NOW - DAY + 30 * DAY },
    } });
  });

  it("GET /api/owner-mark — 세션이 없으면 401", async () => {
    state.cookies.delete(SESSION_COOKIE_NAME);
    expect((await ownerMarkGet(new Request(new URL("/api/owner-mark", FAKE_ORIGIN)))).status).toBe(401);
  });
});

describe("6 번들 — 열쇠 · 도메인 설정의 이름과 가짜 열쇠가 클라이언트 번들 검사의 금지 목록에 있다", () => {
  it("scripts/check-client-bundle.sh 의 FORBIDDEN_PATTERNS 에 OWNER_COOKIE_SECRET · OWNER_COOKIE_DOMAIN · fake-owner-cookie-secret-marker", () => {
    const script = readFileSync(fileURLToPath(new URL("../../../scripts/check-client-bundle.sh", import.meta.url)), "utf8");
    const patterns = /FORBIDDEN_PATTERNS='([\s\S]*?)'/.exec(script)![1].split("\n");
    for (const pattern of ["OWNER_COOKIE_SECRET", "OWNER_COOKIE_DOMAIN", "fake-owner-cookie-secret-marker"]) expect(patterns).toContain(pattern);
    expect(FAKE_OWNER_COOKIE_SECRET).toContain("fake-owner-cookie-secret-marker");
  });
});
