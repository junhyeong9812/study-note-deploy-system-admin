/** POST /api/owner-mark(이 브라우저를 주인으로 표시) · POST /api/owner-mark/clear(주인 표시 지우기) — 명세 §17 2b.
 * 실제 route · 실제 설정 읽기 · 실제 세션 검증. 다른 서버를 부르지 않는다(전역 fetch 가 불리면 실패).
 * 차례: 출처 → 세션 → 속도 제한(계정당 60초에 5번 · 심기와 지우기를 함께) → 설정 → Set-Cookie + 303 /owner-mark.
 * 쿠키의 속성은 하나씩 값으로 본다 — 빠지거나 다른 값이면 브라우저가 심지 않거나(Domain) 지우지 않는다(지우기의 Domain · Path). */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    has: (name: string) => cookieJar.has(name),
    getAll: (name?: string) => [...cookieJar].filter(([key]) => name === undefined || key === name).map(([key, value]) => ({ name: key, value })),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import { NextRequest } from "next/server";
import { POST as clearPost } from "@/app/api/owner-mark/clear/route";
import { GET as ownerMarkGet, POST as setPost } from "@/app/api/owner-mark/route";
import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MILLISECONDS, issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { OWNER_MARK_RATE_LIMIT_PER_MINUTE } from "@/features/owner-mark/server/owner-mark-change";
import { FAKE_OWNER_COOKIE_DOMAIN, FAKE_OWNER_COOKIE_SECRET, cookieParts } from "@/features/owner-mark/lib/owner-mark-test-fakes";
import { middleware } from "@/middleware";

const consoleLines: string[] = [];
let baseTime = Date.UTC(2026, 10, 28, 3, 0, 0);

function expectedValue(createdAt: number, secret = FAKE_OWNER_COOKIE_SECRET): string {
  return `ow1.${createdAt}.${createHmac("sha256", Buffer.from(secret, "utf8")).update(`study-owner\now1\n${createdAt}`).digest("base64url")}`;
}

interface OwnerRequestOptions {
  origin?: string | null;
  body?: string;
  query?: string;
  host?: string;
  method?: string;
}

function ownerRequest(path: "/api/owner-mark" | "/api/owner-mark/clear", options: OwnerRequestOptions = {}): Request {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", "x-real-ip": "198.51.100.77" });
  if (options.origin !== null) headers.set("origin", options.origin ?? FAKE_ORIGIN);
  if (options.host !== undefined) headers.set("host", options.host);
  const method = options.method ?? "POST";
  return new Request(new URL(`${path}${options.query ?? ""}`, FAKE_ORIGIN), { method, headers, body: method === "GET" ? undefined : options.body ?? "" });
}

function validSession() {
  cookieJar.set(SESSION_COOKIE_NAME, issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000));
}

function locationPath(response: Response): string {
  const location = response.headers.get("location") ?? "";
  return location.startsWith(FAKE_ORIGIN) ? location.slice(FAKE_ORIGIN.length) : location;
}

const ownerLines = () => consoleLines.filter((line) => line.includes(":owner-mark:"));

function expectNothingSecret(text: string, value?: string) {
  for (const secret of [FAKE_OWNER_COOKIE_SECRET, FAKE_SIGNING_KEY, ...(value === undefined ? [] : [value, value.split(".")[2]])]) {
    expect(text, `${secret.slice(0, 12)}… 가 들어 있다`).not.toContain(secret);
  }
}

beforeEach(() => {
  baseTime += 3_600_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(baseTime);
  cookieJar.clear();
  consoleLines.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_USER", FAKE_ADMIN_ID);
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("LOG_REDIS_URL", "");
  vi.stubEnv("OWNER_COOKIE_SECRET", FAKE_OWNER_COOKIE_SECRET);
  vi.stubEnv("OWNER_COOKIE_DOMAIN", FAKE_OWNER_COOKIE_DOMAIN);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("주인 표시는 다른 서버를 부르지 않는다"); }));
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("3 표시하기 — 성공", () => {
  it("303 /owner-mark · no-store · Set-Cookie 의 값은 서버의 시계로 만든 ow1 값 · 속성은 정확히 여섯(Domain · Path=/ · Max-Age=2592000 · Secure · HttpOnly · SameSite=Lax)", async () => {
    validSession();
    const response = await setPost(ownerRequest("/api/owner-mark"));
    expect(response.status).toBe(303);
    expect(locationPath(response)).toBe("/owner-mark");
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const { pair, attributes } = cookieParts(response.headers.get("set-cookie"));
    expect(pair).toBe(`study_owner=${expectedValue(Date.now())}`);
    expect(new Set(attributes)).toEqual(new Set([`Domain=${FAKE_OWNER_COOKIE_DOMAIN}`, "Path=/", "Max-Age=2592000", "Secure", "HttpOnly", "SameSite=Lax"]));
    expect(attributes).toHaveLength(6);
    expect(await response.text()).toBe("");
  });

  it("세션 쿠키는 건드리지 않는다 — Set-Cookie 는 study_owner 한 줄", async () => {
    validSession();
    const response = await setPost(ownerRequest("/api/owner-mark"));
    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0].startsWith("study_owner=")).toBe(true);
  });

  it("열쇠를 다듬지 않는다 — 앞뒤 공백이 낀 열쇠면 그 바이트 그대로 서명한 값", async () => {
    const padded = `  ${FAKE_OWNER_COOKIE_SECRET} `;
    vi.stubEnv("OWNER_COOKIE_SECRET", padded);
    validSession();
    const response = await setPost(ownerRequest("/api/owner-mark"));
    expect(response.status).toBe(303);
    expect(cookieParts(response.headers.get("set-cookie")).pair).toBe(`study_owner=${expectedValue(Date.now(), padded)}`);
  });

  it("요청의 몸 · 질의 · Host 의 글자가 도메인 · 시각 · 값을 바꾸지 못한다", async () => {
    validSession();
    const response = await setPost(ownerRequest("/api/owner-mark", {
      body: "domain=evil.test&created_at=1&value=ow1.1.AAAA&max_age=99999999",
      query: "?domain=evil.test&created_at=1",
      host: "evil.test",
    }));
    expect(response.status).toBe(303);
    const { pair, attributes } = cookieParts(response.headers.get("set-cookie"));
    expect(pair).toBe(`study_owner=${expectedValue(Date.now())}`);
    expect(attributes).toContain(`Domain=${FAKE_OWNER_COOKIE_DOMAIN}`);
    expect(attributes).toContain("Max-Age=2592000");
    expect(response.headers.get("set-cookie")).not.toContain("evil.test");
  });

  it("로그 — 한 줄 `owner-mark:set action=set account=<계정>` · 쿠키의 값 · 서명 · 열쇠 없음", async () => {
    validSession();
    const response = await setPost(ownerRequest("/api/owner-mark"));
    const value = cookieParts(response.headers.get("set-cookie")).pair.slice("study_owner=".length);
    expect(ownerLines()).toHaveLength(1);
    expect(ownerLines()[0]).toMatch(/:owner-mark:set action=set account=fake-admin-id-zq\b/);
    expectNothingSecret(consoleLines.join("\n"), value);
  });
});

describe("3 · 4 출처 · 세션 — 거절하면 Set-Cookie 가 없다", () => {
  for (const [label, post, path] of [["표시하기", setPost, "/api/owner-mark"], ["지우기", clearPost, "/api/owner-mark/clear"]] as const) {
    it.each([
      ["Origin 없음", null], ["다른 출처", "https://evil.example.test"], ["끝에 / 가 붙은 같은 출처", `${FAKE_ORIGIN}/`],
    ] as const)(`${label} · %s → 403 JSON origin_rejected · Set-Cookie 없음`, async (_label, origin) => {
      validSession();
      const response = await post(ownerRequest(path, { origin }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: { code: "origin_rejected" } });
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it.each([
      ["세션 없음", (): string | undefined => undefined],
      ["다른 키의 세션", (): string | undefined => issueSessionToken("fake-other-signing-key-for-tests-0000000000", Date.now())],
      ["만료된 세션", (): string | undefined => issueSessionToken(FAKE_SIGNING_KEY, Date.now() - SESSION_LIFETIME_MILLISECONDS - 1_000)],
    ] as [string, () => string | undefined][])(`${label} · %s → 401 JSON · Set-Cookie 없음`, async (_label, makeToken) => {
      const token = makeToken();
      if (token !== undefined) cookieJar.set(SESSION_COOKIE_NAME, token);
      const response = await post(ownerRequest(path));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ success: false, error: { code: "unauthorized" } });
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  }

  it("배포된 서버의 차례 — 세션이 없으면 middleware 가 먼저 401 · route 에 닿지 않는다", async () => {
    const request = ownerRequest("/api/owner-mark");
    const gate = await middleware(new NextRequest(request.url, { method: "POST", headers: request.headers }));
    expect(gate.headers.get("x-middleware-next")).not.toBe("1");
    expect(gate.status).toBe(401);
  });

  it("GET 으로는 심지 않는다 — GET /api/owner-mark 는 화면 데이터(JSON)만 · Set-Cookie 없음 · 지우기 경로는 GET 을 내보내지 않는다", async () => {
    validSession();
    const response = await ownerMarkGet(ownerRequest("/api/owner-mark", { method: "GET" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const clearModule = await import("@/app/api/owner-mark/clear/route");
    expect((clearModule as Record<string, unknown>).GET).toBeUndefined();
  });
});

describe("3 · 4 속도 제한 — 계정당 60초에 5번(심기와 지우기를 함께 센다)", () => {
  it(`${OWNER_MARK_RATE_LIMIT_PER_MINUTE}번 뒤의 요청은 429 · Set-Cookie 없음 · 로그 rate_limited — 60초 뒤 다시 받는다`, async () => {
    expect(OWNER_MARK_RATE_LIMIT_PER_MINUTE).toBe(5);
    validSession();
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await setPost(ownerRequest("/api/owner-mark"))).status).toBe(303);
    for (let attempt = 0; attempt < 2; attempt += 1) expect((await clearPost(ownerRequest("/api/owner-mark/clear"))).status).toBe(303);
    const limited = await setPost(ownerRequest("/api/owner-mark"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("content-type") ?? "").toContain("text/html");
    expect(limited.headers.get("set-cookie")).toBeNull();
    expect(ownerLines().at(-1)).toMatch(/:owner-mark:rate_limited action=set account=fake-admin-id-zq\b/);
    vi.setSystemTime(Date.now() + 60_001);
    expect((await setPost(ownerRequest("/api/owner-mark"))).status).toBe(303);
  });
});

describe("2 설정이 쓸 수 없으면 — 심지 않는다(503 HTML '설정 없음' + 문제의 이름 · 값은 보이지 않는다)", () => {
  const cases: [string, Record<string, string>, string[], boolean][] = [
    ["열쇠 없음", { OWNER_COOKIE_SECRET: "" }, ["OWNER_COOKIE_SECRET"], true],
    ["열쇠가 공백뿐", { OWNER_COOKIE_SECRET: " ".repeat(40) }, ["OWNER_COOKIE_SECRET"], true],
    ["열쇠가 31바이트", { OWNER_COOKIE_SECRET: "fake-owner-secret-31-bytes-xxxx" }, ["OWNER_COOKIE_SECRET"], true],
    ["도메인 없음", { OWNER_COOKIE_DOMAIN: "" }, ["OWNER_COOKIE_DOMAIN"], false],
    ["도메인이 한 조각(com)", { OWNER_COOKIE_DOMAIN: "com" }, ["OWNER_COOKIE_DOMAIN"], false],
    ["도메인이 IP", { OWNER_COOKIE_DOMAIN: "192.168.0.10" }, ["OWNER_COOKIE_DOMAIN"], false],
    ["도메인에 포트", { OWNER_COOKIE_DOMAIN: "example.test:443" }, ["OWNER_COOKIE_DOMAIN"], false],
    ["어드민이 그 도메인 밖", { OWNER_COOKIE_DOMAIN: "other.test" }, ["ADMIN_ORIGIN", "OWNER_COOKIE_DOMAIN"], false],
  ];
  for (const [label, environment, names, clearable] of cases) {
    it(`${label} → 표시하기 503 · Set-Cookie 없음 · 화면 글에 ${names.join(" · ")} · 로그 not_configured / 지우기는 ${clearable ? "된다(도메인을 안다)" : "503(도메인을 모른다)"}`, async () => {
      for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
      validSession();
      const response = await setPost(ownerRequest("/api/owner-mark"));
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type") ?? "").toContain("text/html");
      expect(response.headers.get("cache-control") ?? "").toContain("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      const html = await response.text();
      expect(html).toContain("설정 없음");
      for (const name of names) expect(html).toContain(name);
      expect(html).toContain('href="/owner-mark"');
      expectNothingSecret(html);
      if (environment.OWNER_COOKIE_SECRET) expect(html).not.toContain(environment.OWNER_COOKIE_SECRET.trim() || "\u0000");
      expect(ownerLines().at(-1)).toMatch(/:owner-mark:not_configured action=set account=fake-admin-id-zq problems=/);

      const cleared = await clearPost(ownerRequest("/api/owner-mark/clear"));
      if (clearable) {
        expect(cleared.status).toBe(303);
        expect(cookieParts(cleared.headers.get("set-cookie")).attributes).toContain(`Domain=${FAKE_OWNER_COOKIE_DOMAIN}`);
      } else {
        expect(cleared.status).toBe(503);
        expect(cleared.headers.get("set-cookie")).toBeNull();
      }
    });
  }

  it("로그의 문제 낱말 — 열쇠와 도메인이 둘 다 없으면 problems=secret_unusable,domain_invalid", async () => {
    vi.stubEnv("OWNER_COOKIE_SECRET", "");
    vi.stubEnv("OWNER_COOKIE_DOMAIN", "");
    validSession();
    await setPost(ownerRequest("/api/owner-mark"));
    expect(ownerLines().at(-1)).toMatch(/problems=secret_unusable,domain_invalid$/);
  });
});

describe("4 지우기 — 같은 이름 · 같은 Domain · Path 에 Max-Age=0", () => {
  it("303 /owner-mark · no-store · `study_owner=` · 속성 여섯(Domain · Path=/ · Max-Age=0 · Secure · HttpOnly · SameSite=Lax) · 로그 cleared", async () => {
    validSession();
    cookieJar.set("study_owner", expectedValue(Date.now() - 1_000));
    const response = await clearPost(ownerRequest("/api/owner-mark/clear"));
    expect(response.status).toBe(303);
    expect(locationPath(response)).toBe("/owner-mark");
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const { pair, attributes } = cookieParts(response.headers.get("set-cookie"));
    expect(pair).toBe("study_owner=");
    expect(new Set(attributes)).toEqual(new Set([`Domain=${FAKE_OWNER_COOKIE_DOMAIN}`, "Path=/", "Max-Age=0", "Secure", "HttpOnly", "SameSite=Lax"]));
    expect(attributes).toHaveLength(6);
    expect(ownerLines()).toHaveLength(1);
    expect(ownerLines()[0]).toMatch(/:owner-mark:cleared action=clear account=fake-admin-id-zq\b/);
  });

  it("지우기의 Domain 도 요청의 글자로 바뀌지 않는다", async () => {
    validSession();
    const response = await clearPost(ownerRequest("/api/owner-mark/clear", { body: "domain=evil.test", query: "?domain=evil.test", host: "evil.test" }));
    expect(cookieParts(response.headers.get("set-cookie")).attributes).toContain(`Domain=${FAKE_OWNER_COOKIE_DOMAIN}`);
    expect(response.headers.get("set-cookie")).not.toContain("evil.test");
  });
});
