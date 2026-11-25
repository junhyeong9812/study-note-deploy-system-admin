/** 상태 한눈에의 "서버 자원" 카드 — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수(loadStatusScreen)와 전역 fetch(가짜 알림 · 관측 · backend · master)를 거쳐
 * 명세 §17 "기존 카드들 아래에 '서버 자원' 카드 하나 — 서버마다 한 줄의 표(서버 · CPU · 메모리 · 디스크 · 받은 때 · 임계값). 임계값 칸은 가장 심한 것 하나와 나머지 개수.
 * 서버 이름은 '서버 자원' 화면의 그 서버로 가는 링크" · §2.3 "한 구역이 실패해도 다른 구역은 보인다"를 본다. 비밀값 · 주소 · 원문 표식은 HTML 에 없다. */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import StatusPage from "@/app/status/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  MINUTE, NOW_MILLISECONDS, observeContainer, observeFiring, observeHost, observeLatestBody, observeLatestServer, observeSilentServer,
} from "@/features/resources/lib/resource-metrics-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  createRoutedFetch, expectNoForbiddenText, jsonBody, leakyErrorBody, textResponse,
} from "@/shared/lib/upstream-test-fakes";

/** 다섯 칸은 늘 정상(실제 계약 꼴) — 이 파일은 서버 자원 카드만 본다. */
const HEALTHY: Record<string, () => Response> = {
  [`${new URL(FAKE_ALERT_URL).origin}/monitors`]: () => jsonBody({ success: true, data: { monitors: [{ name: "front", status: "UP", down_since: "", reason: "" }], last_round_at: "2026-11-24T11:59:30Z", undelivered: 0 } }),
  [`${new URL(FAKE_ALERT_URL).origin}/health`]: () => jsonBody({ status: "ok", last_round_at: "2026-11-24T11:59:30Z", active: true }),
  [`${new URL(FAKE_OBSERVE_URL).origin}/health`]: () => jsonBody({ status: "ok", failure: "", lag: 0, last_stored_at: "2026-11-24T11:59:58Z" }),
  [`${new URL(FAKE_BACKEND_URL).origin}/api/health/dependencies`]: () => jsonBody({ status: "UP", components: { redis: { status: "UP" } } }),
  [`${new URL(FAKE_DEPLOY_MASTER_URL).origin}/health`]: () => jsonBody({ success: true, data: { mode: "master" } }),
};

function defaultServers(): Record<string, unknown>[] {
  return [
    observeLatestServer("158"),
    observeLatestServer("164", { containers: [observeContainer({ name: "llm-ollama", series_name: "llm-ollama" })] }),
    observeLatestServer("9", { host: observeHost({ cpu_pct: null }) }),
    observeSilentServer("spare"),
  ];
}

let latest: () => Response = () => observeLatestBody(defaultServers(), []);
const upstreamFetch = createRoutedFetch((url) => {
  const key = `${url.origin}${url.pathname}`;
  if (key === `${new URL(FAKE_OBSERVE_URL).origin}/metrics/latest`) return latest();
  const route = HEALTHY[key];
  if (!route) throw new Error(`unexpected url ${url.pathname}`);
  return route();
});

async function render(): Promise<string> {
  const element = await StatusPage();
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function textOf(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, "");
}

function resourcesCard(html: string): string {
  const match = /<section[^>]*aria-labelledby="status-card-resources"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  expect(match, "서버 자원 카드가 없다").not.toBeNull();
  return match![1];
}

/** 표의 줄 — 서버 이름 링크로 찾아 칸 글(td 마다) */
function rowCells(card: string, server: string): string[] {
  const match = new RegExp(`<tr[^>]*><td[^>]*><a[^>]*>${server}</a></td>([\\s\\S]*?)</tr>`).exec(card);
  expect(match, `${server} 줄이 없다`).not.toBeNull();
  return [server, ...[...match![1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => textOf(cell[1]))];
}

function summaryOf(html: string): string {
  return textOf(/<div[^>]*role="status"[^>]*>([\s\S]*?)<\/div>/.exec(html)![1]);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("ALERT_URL", FAKE_ALERT_URL);
  vi.stubEnv("ALERT_SECRET", FAKE_ALERT_SECRET);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("BACKEND_URL", FAKE_BACKEND_URL);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  latest = () => observeLatestBody(defaultServers(), []);
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

describe("서버 자원 카드 — 기존 카드들 아래, 서버마다 한 줄", () => {
  it("기존 다섯 카드 다음에 오고, 관측 서버 latest 를 한 번 부른다(계열 조회 없음)", async () => {
    const html = await render();
    expect(html.indexOf('aria-labelledby="status-card-resources"')).toBeGreaterThan(html.indexOf('aria-labelledby="status-card-deployMasterHealth"'));
    const paths = upstreamFetch.mock.calls.map(([input]) => new URL(input).pathname);
    expect(paths.filter((path) => path === "/metrics/latest")).toHaveLength(1);
    expect(paths.filter((path) => path === "/metrics/series")).toHaveLength(0);
    expect(paths).toHaveLength(6);
  });

  it("열 — 서버 · CPU · 메모리 · 디스크 · 받은 때 · 임계값, 서버 이름순, 이름은 서버 자원 화면의 그 서버로", async () => {
    const card = resourcesCard(await render());
    expect([...card.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((match) => match[1])).toEqual(["서버", "CPU", "메모리", "디스크", "받은 때", "임계값"]);
    expect([...card.matchAll(/<tr[^>]*><td[^>]*><a href="([^"]*)">([^<]*)<\/a>/g)].map((match) => [match[2], match[1]])).toEqual([
      ["158", "/resources?range=1h#resource-server-158"], ["164", "/resources?range=1h#resource-server-164"],
      ["9", "/resources?range=1h#resource-server-9"], ["spare", "/resources?range=1h#resource-server-spare"],
    ]);
    const cells = rowCells(card, "158");
    expect(cells.slice(0, 4)).toEqual(["158", "3.4%", "13.1%", "16.1%"]);
    expect(cells[4]).toMatch(/^1분 안마지막 수신 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(cells[5]).toBe("없음");
  });

  it("카드 끝의 '서버 자원 화면으로' 링크", async () => {
    expect(resourcesCard(await render())).toMatch(/<a[^>]*href="\/resources\?range=1h"[^>]*>서버 자원 화면으로<\/a>/);
  });
});

describe("값 없음 · 오래됨 · 수신 없음", () => {
  it("값이 null 이면 '없음' · missing 에 host 면 '읽지 못함'(0 으로 보이지 않는다)", async () => {
    latest = () => observeLatestBody([observeLatestServer("158", { host: null, missing: ["host"] }), observeLatestServer("9", { host: observeHost({ cpu_pct: null }) })], []);
    const card = resourcesCard(await render());
    expect(rowCells(card, "158").slice(1, 4)).toEqual(["읽지 못함", "읽지 못함", "읽지 못함"]);
    expect(rowCells(card, "9")[1]).toBe("없음");
  });

  it("오래된 값은 '! N분 전 값', 수신 없음은 '✕ 수신 없음' — 표식 + 글", async () => {
    latest = () => observeLatestBody([observeLatestServer("158", { stale: true, age_ms: 12 * MINUTE + 30_000 }), observeSilentServer("spare")], []);
    const card = resourcesCard(await render());
    expect(rowCells(card, "158")[4]).toMatch(/^! 12분 전 값마지막 수신/);
    expect(rowCells(card, "spare")[4]).toBe("✕ 수신 없음");
    expect(rowCells(card, "spare").slice(1, 4)).toEqual(["없음", "없음", "없음"]);
  });
});

describe("임계값 칸 — 가장 심한 것 하나 + 나머지 개수", () => {
  const since = new Date(NOW_MILLISECONDS - 30 * MINUTE).toISOString();

  it("둘이 울리면 '! <규칙>(<심각도>) 외 1건', 위험이 있으면 그것('‼'), 없으면 '없음'", async () => {
    latest = () => observeLatestBody(defaultServers(), [
      observeFiring({ server: "9", rule: "disk_warning", severity: "warning", since }),
      observeFiring({ server: "9", rule: "memory", severity: "warning", since }),
      observeFiring({ server: "164", rule: "restarts", target: "llm-ollama", severity: "warning", since }),
      observeFiring({ server: "164", rule: "disk_critical", severity: "critical", since }),
    ]);
    const card = resourcesCard(await render());
    expect(rowCells(card, "9")[5]).toBe("! 디스크 경고(경고) 외 1건");
    expect(rowCells(card, "164")[5]).toBe("‼ 디스크 위험(위험) 외 1건");
    expect(rowCells(card, "158")[5]).toBe("없음");
  });

  it("하나면 '외' 없이 · 재시작은 대상 이름까지", async () => {
    latest = () => observeLatestBody(defaultServers(), [observeFiring({ server: "164", rule: "restarts", target: "llm-ollama", severity: "warning", since })]);
    expect(rowCells(resourcesCard(await render()), "164")[5]).toBe("! 컨테이너 재시작 반복 llm-ollama(경고)");
  });

  it("맨 위 요약 줄에 그 알림이 더해진다", async () => {
    latest = () => observeLatestBody(defaultServers(), [observeFiring({ server: "9", rule: "disk_warning", severity: "warning", since })]);
    const summary = summaryOf(await render());
    expect(summary).toContain("문제 1건 — 서버 9 디스크 경고(경고)");
    expect(summary).not.toContain("전부 정상");
  });

  it("firing 칸이 없으면 칸마다 '확인하지 못함' · 카드에 '임계값: 확인하지 못함' · 요약에 확인 못 함", async () => {
    latest = () => observeLatestBody(defaultServers(), undefined);
    const html = await render();
    const card = resourcesCard(html);
    expect(rowCells(card, "158")[5]).toBe("확인하지 못함");
    expect(textOf(card)).toContain("임계값: 확인하지 못함");
    // §18 — 기본 서버의 spare 는 수신 없음이라 그 줄도 확인 못 함에 더해진다
    expect(summaryOf(html)).toContain("확인 못 함 2건 — 서버 자원 임계값 · 서버 spare 수신 없음");
  });

  it("표 밖 서버의 알림 수와 숨긴 서버 수를 적는다", async () => {
    const names = Array.from({ length: 12 }, (_, index) => `s${String(index).padStart(2, "0")}`);
    latest = () => observeLatestBody(names.map((name) => observeLatestServer(name)), [observeFiring({ server: "77", rule: "silent", severity: "warning", since })]);
    const card = textOf(resourcesCard(await render()));
    expect(card).toContain("표 밖 서버의 알림 1건");
    expect(card).toContain("서버 2대는 표에 보이지 않습니다(앞 10대만)");
  });

  it("다 정상이면 요약은 '전부 정상' 그대로", async () => {
    latest = () => observeLatestBody(defaultServers().filter((row) => row.server !== "spare"), []);   // §18 — 수신 없음 서버가 있으면 정상이 아니다
    expect(summaryOf(await render())).toContain("전부 정상");
  });
});

describe("§18 — 오래된 값 · 수신 없음이면 정상이 아니다 · 이름을 읽지 못한 서버", () => {
  function badgeOf(card: string): string {
    const match = /<div[^>]*><h2[^>]*>서버 자원<\/h2>([\s\S]*?)<\/div>/.exec(card);
    expect(match, "카드 머리가 없다").not.toBeNull();
    return textOf(match![1]);
  }

  it("다 정상(알림 없음 · 모두 받음)이면 카드 배지는 '정상'", async () => {
    latest = () => observeLatestBody([observeLatestServer("158"), observeLatestServer("164")], []);
    expect(badgeOf(resourcesCard(await render()))).toBe("✓정상");
  });

  it("알림이 아직 울리지 않았어도 오래된 값 줄이 있으면 카드 배지는 '정상'이 아니고('확인 못 함'), 맨 위 요약도 '전부 정상'이 아니다", async () => {
    latest = () => observeLatestBody([observeLatestServer("158", { stale: true, age_ms: 4 * MINUTE }), observeLatestServer("164")], []);
    const html = await render();
    const badge = badgeOf(resourcesCard(html));
    expect(badge).not.toContain("정상");
    expect(badge).toBe("?확인 못 함");
    expect(summaryOf(html)).not.toContain("전부 정상");
    expect(summaryOf(html)).toContain("확인 못 함 1건 — 서버 158 4분 전 값");
  });

  it("수신 없음 줄이 있어도 같다", async () => {
    latest = () => observeLatestBody([observeLatestServer("158"), observeSilentServer("spare")], []);
    const html = await render();
    expect(badgeOf(resourcesCard(html))).toBe("?확인 못 함");
    expect(summaryOf(html)).toContain("확인 못 함 1건 — 서버 spare 수신 없음");
  });

  it("울리는 알림이 있으면 지금처럼 '문제'", async () => {
    latest = () => observeLatestBody([observeLatestServer("158", { stale: true, age_ms: 4 * MINUTE })], [observeFiring({ server: "158", rule: "cpu", severity: "warning" })]);
    expect(badgeOf(resourcesCard(await render()))).toBe("✕문제");
  });

  it("이름을 읽지 못한 서버 줄이 있어도 카드는 나머지 줄을 그린다 — '이름을 읽지 못한 서버 N대'", async () => {
    latest = () => observeLatestBody([observeLatestServer("158"), observeSilentServer("CI-Agent-9")], []);
    const card = resourcesCard(await render());
    expect(rowCells(card, "158").slice(0, 2)).toEqual(["158", "3.4%"]);
    expect(textOf(card)).toContain("이름을 읽지 못한 서버 1대");
    expect(textOf(card)).not.toContain("확인하지 못함 — ");
    expect(card).not.toContain("CI-Agent-9");
  });
});

describe("요약 조회가 실패하면 이 카드만", () => {
  it("latest 503 → '확인하지 못함 — 서버 일시 장애 · HTTP 503', 기존 카드는 그대로, 요약에 '확인 못 함 — 서버 자원'", async () => {
    latest = () => textResponse(leakyErrorBody(), 503);
    const html = await render();
    expect(textOf(resourcesCard(html))).toContain("확인하지 못함 — 서버 일시 장애 · HTTP 503");
    expect(textOf(resourcesCard(html))).toContain("서버 자원 화면으로");
    for (const name of ["alertMonitors", "alertHealth", "observeHealth", "backendDependencies", "deployMasterHealth"]) {
      expect(html).toContain(`aria-labelledby="status-card-${name}"`);
    }
    expect(summaryOf(html)).toContain("확인 못 함 1건 — 서버 자원");
    expectNoForbiddenText(html);
  });

  it("관측 서버 비밀값이 없으면(부르지 않음) 카드에 '설정 없음', 요약 줄에는 더하지 않는다", async () => {
    vi.stubEnv("OBSERVE_SECRET", "");
    const html = await render();
    expect(textOf(resourcesCard(html))).toContain("확인하지 못함 — 설정 없음");
    expect(summaryOf(html)).toContain("전부 정상");
    expect(upstreamFetch.mock.calls.map(([input]) => new URL(input).pathname)).not.toContain("/metrics/latest");
  });
});

describe("HTML 에 없는 것", () => {
  it("스크립트 · 비밀값 · 주소 · 원문 표식 · 계약 밖 칸(id · project)이 없다", async () => {
    latest = () => observeLatestBody(defaultServers(), [observeFiring({ server: "9", rule: "<img src=x onerror=1>", severity: "warning" })]);
    const html = await render();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<img src=x");
    expectNoForbiddenText(html);
    expect(html).not.toContain("0123456789ab");
  });
});
