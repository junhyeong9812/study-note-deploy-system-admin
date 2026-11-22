/** 상태 한눈에 화면 — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 알림 · 관측 · backend · master)를 거쳐
 * 한 줄 요약(문제 · 확인 못 함 · 확인 중의 구분과 건수) · 칸마다 카드 · 한 칸 실패 시 나머지 · 감시 대상 정렬과 링크 · 글자 그대로 ·
 * 세션 없음 · 임시 제한 표시 · 내비게이션을 본다. 비밀값 · 다른 서버 주소 · 원문은 HTML 에 없다. */
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

import StatusPage from "@/app/status/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import type { StatusCheckName } from "@/features/status/lib/status-overview";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_URL,
  UPSTREAM_RAW_MARKER, createRoutedFetch, expectNoForbiddenText, jsonBody, leakyErrorBody, leakyNetworkError, textResponse,
} from "@/shared/lib/upstream-test-fakes";

type Monitor = { name: string; status: "UP" | "DOWN" | "UNKNOWN"; down_since: string; reason: string };

/** 감시 대상 — alert monitors.yml 의 실제 이름들. 기본은 전부 정상. */
const HEALTHY_MONITORS: Monitor[] = ["front", "backend", "backend-deps", "llm", "deploy-master", "deploy-agent-front", "observe"]
  .map((name) => ({ name, status: "UP", down_since: "", reason: "" }));

function monitorsBody(monitors: Monitor[] = HEALTHY_MONITORS, undelivered = 0) {
  return jsonBody({ success: true, data: { monitors, last_round_at: "2026-11-22T10:00:00Z", undelivered } });
}

/** 칸 → 정상 응답(실제 계약 꼴). */
const HEALTHY: Record<StatusCheckName, () => Response> = {
  alertMonitors: () => monitorsBody(),
  alertHealth: () => jsonBody({ status: "ok", last_round_at: "2026-11-22T10:00:00Z", active: true }),
  observeHealth: () => jsonBody({ status: "ok", last_loop_at: "2026-11-22T10:00:00Z", last_stored_at: "2026-11-22T09:59:58Z", failure: "", unacknowledged: 0, lag: 0 }),
  backendDependencies: () => jsonBody({ status: "UP", components: { elasticsearch: { status: "UP" }, embedding: { status: "UP" }, redis: { status: "UP" } } }),
  deployMasterHealth: () => jsonBody({ success: true, data: { mode: "master" } }),
};

const CELL_NAMES = Object.keys(HEALTHY) as StatusCheckName[];

function cellOf(url: URL): StatusCheckName {
  const key = `${url.origin}${url.pathname}`;
  if (key === `${new URL(FAKE_ALERT_URL).origin}/monitors`) return "alertMonitors";
  if (key === `${new URL(FAKE_ALERT_URL).origin}/health`) return "alertHealth";
  if (key === `${new URL(FAKE_OBSERVE_URL).origin}/health`) return "observeHealth";
  if (key === `${new URL(FAKE_BACKEND_URL).origin}/api/health/dependencies`) return "backendDependencies";
  if (key === `${new URL(FAKE_DEPLOY_MASTER_URL).origin}/health`) return "deployMasterHealth";
  throw new Error(`unexpected url ${url.pathname}`);
}

let overrides: Partial<Record<StatusCheckName, () => Promise<Response> | Response>> = {};
const upstreamFetch = createRoutedFetch((url) => {
  const cell = cellOf(url);
  return (overrides[cell] ?? HEALTHY[cell])();
});

async function render(): Promise<string> {
  const element = await StatusPage();
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

/** 한 줄 요약(role="status" 인 div) — 임시 제한 표시(p)와 가른다. */
function summaryOf(html: string): string {
  const match = /<div[^>]*role="status"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  expect(match, "요약이 없다").not.toBeNull();
  return match![1].replace(/<[^>]+>/g, "");
}

function cardOf(html: string, name: StatusCheckName): string {
  const match = new RegExp(`<section[^>]*aria-labelledby="status-card-${name}"[^>]*>([\\s\\S]*?)</section>`).exec(html);
  expect(match, `${name} 카드가 없다`).not.toBeNull();
  return match![1];
}

function textOf(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, "");
}

/** 감시 대상 표의 줄 순서(대상 이름). */
function monitorRowNames(html: string): string[] {
  const card = cardOf(html, "alertMonitors");
  return [...card.matchAll(/<tr[^>]*><td[^>]*>([^<]*)<\/td>/g)].map((match) => match[1]);
}

const CARD_TITLES: Record<StatusCheckName, string> = {
  alertMonitors: "감시 대상", alertHealth: "알림 서버", observeHealth: "관측 서버", backendDependencies: "backend 의존성", deployMasterHealth: "배포 서버(master)",
};
const CARD_SOURCES: Record<StatusCheckName, string> = {
  alertMonitors: "알림 서버", alertHealth: "알림 서버", observeHealth: "관측 서버", backendDependencies: "backend", deployMasterHealth: "배포 서버",
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("ALERT_URL", FAKE_ALERT_URL);
  vi.stubEnv("ALERT_SECRET", FAKE_ALERT_SECRET);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("BACKEND_URL", FAKE_BACKEND_URL);
  vi.stubEnv("DEPLOY_MASTER_URL", FAKE_DEPLOY_MASTER_URL);
  vi.stubEnv("DEPLOY_SECRET", FAKE_DEPLOY_SECRET);
  state.restricted = false;
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  overrides = {};
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("상태 한눈에 — 전부 정상", () => {
  it("요약 '전부 정상' · 다섯 칸 각각 제목이 있는 카드 · 조회 시각(KST) · 새로 고침 링크", async () => {
    const html = await render();
    expect(summaryOf(html)).toContain("전부 정상");
    expect(summaryOf(html)).not.toMatch(/문제|확인 못 함|확인 중/);
    for (const name of CELL_NAMES) {
      expect(html).toMatch(new RegExp(`<h2 id="status-card-${name}"[^>]*>${CARD_TITLES[name].replace(/[()]/g, "\\$&")}</h2>`));
      expect(textOf(cardOf(html, name))).toContain("정상");
    }
    expect(summaryOf(html)).toMatch(/조회 시각\(KST\) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(html).toMatch(/<a[^>]*href="\/status"[^>]*>새로 고침</);
    expect(upstreamFetch).toHaveBeenCalledTimes(5);
  });

  it("자동 새로 고침 · 스크립트 · innerHTML 이 없다", async () => {
    const html = await render();
    expect(html).not.toMatch(/<meta[^>]*refresh/i);
    expect(html).not.toContain("<script");
    expectNoForbiddenText(html);
  });

  it("헬스 낱말은 한국어 설명과 함께 · 감시 마지막 바퀴는 KST · 의존성 이름과 설명", async () => {
    const html = await render();
    expect(textOf(cardOf(html, "alertHealth"))).toContain("ok 정상 — 활성 자리이고 마지막 감시 바퀴가 2분 안에 돌았음");
    expect(textOf(cardOf(html, "observeHealth"))).toContain("ok 정상 — 마지막으로 성공한 수집 바퀴가 60초 안");
    expect(textOf(cardOf(html, "alertMonitors"))).toContain("마지막 감시 바퀴(KST) 2026-11-22 19:00:00");
    expect(textOf(cardOf(html, "alertMonitors"))).toContain("대상 7개");
    expect(textOf(cardOf(html, "alertMonitors"))).toContain("못 보낸 알림 없음");
    for (const name of ["elasticsearch", "embedding", "redis"]) expect(textOf(cardOf(html, "backendDependencies"))).toContain(name);
  });
});

describe("상태 한눈에 — 감시 대상", () => {
  it("하나가 DOWN → 요약 '문제 1건 — 감시 대상 backend', 그 줄이 맨 위 · 문제 시작 시각(KST) · 가린 사유", async () => {
    overrides.alertMonitors = () => monitorsBody(HEALTHY_MONITORS.map((monitor) => (monitor.name === "backend"
      ? { ...monitor, status: "DOWN", down_since: "2026-11-22T09:00:00Z", reason: `연결 실패 ${FAKE_BACKEND_URL}/actuator/health` } : monitor)));
    const html = await render();
    const summary = summaryOf(html);
    expect(summary).toContain("문제 1건 — 감시 대상 backend");
    expect(summary).not.toContain("확인 못 함");
    expect(summary).not.toContain("전부 정상");
    expect(monitorRowNames(html)[0]).toBe("backend");
    const card = textOf(cardOf(html, "alertMonitors"));
    expect(card).toContain("2026-11-22 18:00:00");
    expect(card).toContain("연결 실패 (주소)/actuator/health");
    expect(card).toContain("중 문제 1개");
    expectNoForbiddenText(html);
  });

  it("정렬 — 문제 → 확인 중 → 최근 실패(정상) → 정상, 같은 갈래는 받은 순서", async () => {
    overrides.alertMonitors = () => monitorsBody([
      { name: "front", status: "UP", down_since: "", reason: "" },
      { name: "llm", status: "UNKNOWN", down_since: "", reason: "" },
      { name: "observe", status: "UP", down_since: "", reason: "응답 느림" },
      { name: "backend", status: "DOWN", down_since: "2026-11-22T09:00:00Z", reason: "꺼짐" },
      { name: "deploy-master", status: "UP", down_since: "", reason: "" },
      { name: "backend-deps", status: "DOWN", down_since: "2026-11-22T09:30:00Z", reason: "embedding" },
    ]);
    const html = await render();
    expect(monitorRowNames(html)).toEqual(["backend", "backend-deps", "llm", "observe", "front", "deploy-master"]);
    const summary = summaryOf(html);
    expect(summary).toContain("문제 2건 — 감시 대상 backend · 감시 대상 backend-deps");
    expect(summary).toContain("확인 중 1건 — 감시 대상 llm");
    const card = textOf(cardOf(html, "alertMonitors"));
    expect(card).toContain("정상(최근 실패)");
    expect(card).toContain("확인 중");
  });

  it("이름이 배포 서비스와 같은 대상에만 '로그 보기'(오류만) · '배포 이력' 링크", async () => {
    const html = await render();
    const card = cardOf(html, "alertMonitors");
    for (const service of ["front", "backend", "llm", "observe"]) {
      expect(card).toContain(`href="/logs?service=${service}&amp;level=error"`);
      expect(card).toContain(`href="/deploys?service=${service}"`);
    }
  });

  it("이름 대응이 없는 대상(backend-deps · deploy-master · deploy-agent-front · 모르는 이름)엔 링크가 없다", async () => {
    overrides.alertMonitors = () => monitorsBody([...HEALTHY_MONITORS, { name: "mystery", status: "UP", down_since: "", reason: "" }]);
    const html = await render();
    const card = cardOf(html, "alertMonitors");
    for (const name of ["backend-deps", "deploy-master", "deploy-agent-front", "mystery"]) {
      expect(card).not.toContain(`service=${name}`);
      expect(card).not.toContain(`${name} 의 오류 로그 보기`);
    }
  });

  it("감시 대상 0개 → 빈 안내(표 없음)", async () => {
    overrides.alertMonitors = () => monitorsBody([]);
    const html = await render();
    const card = cardOf(html, "alertMonitors");
    expect(textOf(card)).toContain("감시 대상이 없습니다.");
    expect(card).not.toContain("<table");
    expect(summaryOf(html)).toContain("전부 정상");
  });

  it("<script> 가 든 대상 이름 · 사유는 글자로 보인다", async () => {
    overrides.alertMonitors = () => monitorsBody([{ name: "<script>alert('x')</script>", status: "DOWN", down_since: "2026-11-22T09:00:00Z", reason: "<b>굵게</b>" }]);
    const html = await render();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;굵게&lt;/b&gt;");
  });

  it("못 보낸 알림이 있으면 문제로 센다", async () => {
    overrides.alertMonitors = () => monitorsBody(HEALTHY_MONITORS, 3);
    const html = await render();
    expect(summaryOf(html)).toContain("문제 1건 — 못 보낸 알림 3건");
    expect(textOf(cardOf(html, "alertMonitors"))).toContain("못 보낸 알림 3건");
  });
});

describe("상태 한눈에 — 한 칸이 실패해도 나머지는 보인다", () => {
  it.each(CELL_NAMES)("%s 만 닿지 않음 → 그 카드에만 '<출처>: 닿지 않음', 요약 '확인 못 함 1건', 나머지 카드는 값", async (failed) => {
    overrides[failed] = () => Promise.reject(leakyNetworkError());
    const html = await render();
    expect(textOf(cardOf(html, failed))).toContain(`${CARD_SOURCES[failed]}: 닿지 않음`);
    expect(textOf(cardOf(html, failed))).toContain("확인 못 함");
    for (const other of CELL_NAMES.filter((name) => name !== failed)) {
      expect(textOf(cardOf(html, other))).not.toContain("닿지 않음");
      expect(textOf(cardOf(html, other))).toContain("정상");
    }
    const summary = summaryOf(html);
    expect(summary).toContain(`확인 못 함 1건 — ${CARD_TITLES[failed]}`);
    expect(summary).toContain("문제 없음");
    expect(summary).not.toContain("전부 정상");
    expectNoForbiddenText(html);
  });

  it("전부 실패 → 확인 못 함 5건, 카드 다섯 모두 가린 이유만(원문 · 주소 · 비밀값 없음)", async () => {
    overrides = {
      alertMonitors: () => textResponse(leakyErrorBody(), 401),
      alertHealth: () => Promise.reject(leakyNetworkError()),
      observeHealth: () => textResponse(leakyErrorBody(), 503),
      backendDependencies: () => textResponse(`<html>${UPSTREAM_RAW_MARKER}</html>`, 200, "text/html"),
      deployMasterHealth: () => textResponse(leakyErrorBody(), 500),
    };
    const html = await render();
    expect(summaryOf(html)).toContain("확인 못 함 5건 — 감시 대상 · 알림 서버 · 관측 서버 · backend 의존성 · 배포 서버(master)");
    expect(textOf(cardOf(html, "alertMonitors"))).toContain("알림 서버: 비밀값 거절됨 · HTTP 401");
    expect(textOf(cardOf(html, "alertHealth"))).toContain("알림 서버: 닿지 않음");
    expect(textOf(cardOf(html, "observeHealth"))).toContain("관측 서버: 서버 일시 장애 · HTTP 503");
    expect(textOf(cardOf(html, "backendDependencies"))).toContain("backend: 해석 불가");
    expect(textOf(cardOf(html, "deployMasterHealth"))).toContain("배포 서버: 예상하지 못한 응답 · HTTP 500");
    expectNoForbiddenText(html);
  });
});

describe("상태 한눈에 — '문제'(비정상이라고 답함)와 '확인 못 함'(닿지 못함)을 가른다", () => {
  it("관측 서버가 503 + unreachable 로 답함 = 문제 · backend 에 닿지 못함 = 확인 못 함 · 의존성 DOWN = 문제", async () => {
    overrides.observeHealth = () => jsonBody({ status: "unreachable", failure: "database SQLException", last_loop_at: "" }, 503);
    overrides.backendDependencies = () => Promise.reject(leakyNetworkError());
    overrides.alertMonitors = () => monitorsBody(HEALTHY_MONITORS.map((monitor) => (monitor.name === "llm"
      ? { ...monitor, status: "DOWN", down_since: "2026-11-22T09:00:00Z", reason: "status 502" } : monitor)));
    const html = await render();
    const summary = summaryOf(html);
    expect(summary).toContain("문제 2건 — 감시 대상 llm · 관측 서버(저장소에 닿지 못함)");
    expect(summary).toContain("확인 못 함 1건 — backend 의존성");
    const observe = textOf(cardOf(html, "observeHealth"));
    expect(observe).toContain("unreachable 저장소에 닿지 못함 — 관측 서버가 지금 Redis 나 DB 에 닿지 못함");
    expect(observe).toContain("사유: database SQLException");
    expect(observe).not.toContain("관측 서버: ");
  });

  it("backend 의존성 하나 DOWN → 문제(그 이름) · 가린 사유", async () => {
    overrides.backendDependencies = () => jsonBody({ status: "DOWN", components: {
      elasticsearch: { status: "UP" }, embedding: { status: "DOWN", detail: `Connection refused ${FAKE_BACKEND_URL}/health` }, redis: { status: "UP" },
    } });
    const html = await render();
    expect(summaryOf(html)).toContain("문제 1건 — backend 의존성 embedding");
    expect(textOf(cardOf(html, "backendDependencies"))).toContain("사유: Connection refused (주소)/health");
    expectNoForbiddenText(html);
  });

  it("알림 서버 stalled(503) = 문제 '멈춤' · 관측 서버 starting = 확인 중", async () => {
    overrides.alertHealth = () => jsonBody({ status: "stalled", last_round_at: "2026-11-22T09:00:00Z", active: true }, 503);
    overrides.observeHealth = () => jsonBody({ status: "starting", failure: "" }, 503);
    const html = await render();
    const summary = summaryOf(html);
    expect(summary).toContain("문제 1건 — 알림 서버(멈춤)");
    expect(summary).toContain("확인 중 1건 — 관측 서버(시작 중)");
    expect(summary).not.toContain("확인 못 함");
    expect(textOf(cardOf(html, "alertHealth"))).toContain("stalled 멈춤 — 활성인데 2분 넘게 감시 바퀴가 돌지 않음");
  });
});

describe("상태 한눈에 — 세션 · 공통 틀", () => {
  it("세션이 없으면 로그인으로 — 다른 서버를 부르지 않는다", async () => {
    state.cookieValue = undefined;
    await expect(render()).rejects.toThrow(/^redirect:.*\/login$/);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("내비게이션 — 상태 한눈에가 현재 화면, 배포 이력 · 로그 조회는 링크", async () => {
    const html = await render();
    expect(html).toMatch(/href="\/status" aria-current="page"[^>]*>상태 한눈에</);
    expect(html).toMatch(/href="\/deploys"[^>]*>배포 이력</);
    expect(html).toMatch(/href="\/logs"[^>]*>로그 조회</);
  });

  it("임시 제한 중이면 상태 한눈에 화면에도 표시", async () => {
    state.restricted = true;
    expect(await render()).toContain("임시 제한 중");
    state.restricted = false;
    expect(await render()).not.toContain("임시 제한 중");
  });
});
