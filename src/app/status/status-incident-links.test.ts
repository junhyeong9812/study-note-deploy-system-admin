/** 상태 한눈에 → 문제 화면의 링크(명세 ⑫ §7 "상태 화면의 각 문제에서 이 화면으로 가는 링크"). 기존 상태 화면의 동작은 그대로 — 링크가 더해질 뿐.
 * DOWN 인 감시 대상의 "이어 보기" 칸 · 서버 자원 카드의 임계값 칸(가장 심한 것의 글자를 그 문제로 가는 링크로 — 칸의 글은 그대로).
 * (상태 화면에는 배포 이력이 없다 — 실패한 배포의 링크는 이 화면에 둘 자리가 없다.) */
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
import { monitorIncidentId, resourceIncidentId } from "@/features/incidents/lib/incident-id";
import { incidentHref } from "@/features/incidents/lib/incidents-query";
import { observeFiring, observeLatestBody, observeLatestServer } from "@/features/resources/lib/resource-metrics-test-fakes";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL,
  createRoutedFetch, jsonBody,
} from "@/shared/lib/upstream-test-fakes";

const NO_MONITORS = () => jsonBody({ success: true, data: { monitors: [], last_round_at: "", undelivered: 0 } });
const NO_FIRING = () => observeLatestBody([observeLatestServer("158")], []);
let monitorsResponse: () => Response = NO_MONITORS;
let latestResponse: () => Response = NO_FIRING;

const ROUTES: Record<string, () => Response> = {
  [`${FAKE_ALERT_URL}/health`]: () => jsonBody({ status: "ok", last_round_at: "", active: true }),
  [`${FAKE_OBSERVE_URL}/health`]: () => jsonBody({ status: "ok", failure: "", lag: 0, last_stored_at: "" }),
  [`${FAKE_BACKEND_URL}/api/health/dependencies`]: () => jsonBody({ status: "UP", components: {} }),
  [`${FAKE_DEPLOY_MASTER_URL}/health`]: () => jsonBody({ success: true, data: { mode: "master" } }),
};

const upstreamFetch = createRoutedFetch((url) => {
  const key = `${url.origin}${url.pathname}`;
  if (key === `${FAKE_ALERT_URL}/monitors`) return monitorsResponse();
  if (key === `${FAKE_OBSERVE_URL}/metrics/latest`) return latestResponse();
  const route = ROUTES[key];
  if (!route) throw new Error(`unexpected ${url.pathname}`);
  return route();
});

async function render(): Promise<string> {
  const element = await StatusPage();
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function escapedHref(href: string): string {
  return `href="${href.replace(/&/g, "&amp;")}"`;
}

function monitorRow(html: string, name: string): string {
  const card = /<section[^>]*aria-labelledby="status-card-alertMonitors"[^>]*>([\s\S]*?)<\/section>/.exec(html)![1];
  const row = [...card.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => match[1]).find((candidate) => new RegExp(`^<td[^>]*>${name}</td>`).test(candidate));
  expect(row, `${name} 줄이 없다`).toBeDefined();
  return row!;
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
  monitorsResponse = NO_MONITORS;
  latestResponse = NO_FIRING;
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

describe("감시 대상 — DOWN 인 줄에서 그 문제로", () => {
  it("DOWN 인 대상(대응 표 밖 포함)마다 문제 화면의 그 문제로 가는 링크, UP · UNKNOWN 줄에는 없다", async () => {
    monitorsResponse = () => jsonBody({ success: true, data: { monitors: [
      { name: "front", status: "DOWN", down_since: "2026-11-25T05:40:00Z", reason: "status 502" },
      { name: "deploy-master", status: "DOWN", down_since: "2026-11-25T05:50:00Z", reason: "꺼짐" },
      { name: "backend", status: "UP", down_since: "", reason: "" },
      { name: "llm", status: "UNKNOWN", down_since: "", reason: "연결 실패" },
    ], last_round_at: "2026-11-25T05:59:30Z", undelivered: 0 } });
    const html = await render();
    expect(monitorRow(html, "front")).toContain(escapedHref(incidentHref(monitorIncidentId("front"))));
    expect(monitorRow(html, "deploy-master")).toContain(escapedHref(incidentHref(monitorIncidentId("deploy-master"))));
    expect(monitorRow(html, "front")).toContain('href="/incidents?incident=monitor%3Afront"');
    expect(monitorRow(html, "backend")).not.toContain("/incidents");
    expect(monitorRow(html, "llm")).not.toContain("/incidents");
  });

  it("기존 이어 보기 링크(로그 · 배포 이력)는 그대로", async () => {
    monitorsResponse = () => jsonBody({ success: true, data: { monitors: [{ name: "front", status: "DOWN", down_since: "2026-11-25T05:40:00Z", reason: "x" }], last_round_at: "", undelivered: 0 } });
    const row = monitorRow(await render(), "front");
    expect(row).toContain('href="/logs?service=front&amp;level=error"');
    expect(row).toContain('href="/deploys?service=front"');
  });
});

describe("서버 자원 카드 — 울리는 임계값에서 그 문제로", () => {
  it("임계값 칸의 가장 심한 것이 그 문제로 가는 링크(칸의 글은 그대로)", async () => {
    latestResponse = () => observeLatestBody([observeLatestServer("158")], [
      observeFiring({ server: "158", rule: "disk_warning", severity: "warning" }), observeFiring({ server: "158", rule: "disk_critical", severity: "critical" }),
    ]);
    const html = await render();
    const card = /<section[^>]*aria-labelledby="status-card-resources"[^>]*>([\s\S]*?)<\/section>/.exec(html)![1];
    expect(card).toContain(escapedHref(incidentHref(resourceIncidentId("158", "disk_critical", null))));
    expect(card).toContain('href="/incidents?incident=resource%3A158%3Adisk_critical"');
  });

  it("임계값 링크에 접근 가능한 이름 — `<서버> <규칙의 이름> 문제 보기`(감시 대상 줄의 '문제 보기'와 같은 낱말)", async () => {
    latestResponse = () => observeLatestBody([observeLatestServer("158")], [
      observeFiring({ server: "158", rule: "disk_warning", severity: "warning" }), observeFiring({ server: "158", rule: "disk_critical", severity: "critical" }),
    ]);
    const html = await render();
    const card = /<section[^>]*aria-labelledby="status-card-resources"[^>]*>([\s\S]*?)<\/section>/.exec(html)![1];
    const href = escapedHref(incidentHref(resourceIncidentId("158", "disk_critical", null)));
    const anchors = [...card.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]).filter((tag) => tag.includes(href));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toContain('aria-label="158 디스크 위험 문제 보기"');
  });

  it("울리는 것도 DOWN 도 없으면 문제 화면으로 가는 링크가 없다(내비게이션의 /incidents 만)", async () => {
    expect(await render()).not.toContain('href="/incidents?incident=');
  });
});
