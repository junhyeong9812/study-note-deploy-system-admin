/** 통신 지도 화면 — 의존의 선(⑬ T9d "화면"). 렌더한 마크업으로 본다:
 * 의존의 노드(닫힌 표의 이름 · 같은 이름은 하나 · "(목록 밖)" 없음) · 서비스 → 의존의 선(통신의 "덜 채워짐" 점선 `6 4` 과 다른 표시 — `stroke-dasharray="2 3"` ·
 * 다른 클래스 · 연결됨 / 끊김 / 모름이 서로 다른 클래스) · 표 "의존 연결"(서비스 · 의존 · 상태 · 걸린 시간 · 까닭 · 확인한 때) · "지금의 상태"라는 글 ·
 * 첫 조회 전 · 낡음(90초 · 끊김) · 통신의 선과 표는 그대로. */
import { readFileSync } from "node:fs";
import { createElement } from "react";
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

import TrafficPage from "@/app/traffic/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import { formatKoreanLogTime } from "@/features/logs/ui/LogTable";
import type { DependencyLine } from "@/features/traffic-map/lib/dependency-lines";
import type { TrafficDependencyEvent } from "@/features/traffic-map/lib/traffic-dependency-hub";
import { initialTrafficDependencyStreamState } from "@/features/traffic-map/lib/traffic-dependency-stream";
import { initialTrafficMapStreamState, reduceTrafficMapStream, type TrafficMapStreamState } from "@/features/traffic-map/lib/traffic-map-stream-state";
import { chatMapEdges, createFakeObserveMap, fakeMapServer, trafficMapEventOf } from "@/features/traffic-map/lib/traffic-map-test-fakes";
import { defaultTrafficMapHub } from "@/features/traffic-map/server/traffic-map";
import { TrafficMapBody } from "@/features/traffic-map/ui/TrafficMapBody";
import { FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, createRoutedFetch } from "@/shared/lib/upstream-test-fakes";
import { upstreamFailure } from "@/shared/lib/upstream-result";

const CHECKED_AT = Date.UTC(2026, 10, 30, 4, 0, 0);
const ALL_LINES: DependencyLine[] = [
  { service: "backend", dependency: "elasticsearch", state: "up", tookMs: 12, reason: null },
  { service: "backend", dependency: "embedding", state: "down", tookMs: null, reason: null },
  { service: "backend", dependency: "redis", state: "up", tookMs: 1, reason: null },
  { service: "backend", dependency: "postgres", state: "down", tookMs: 41, reason: null },
  { service: "llm-wrapper", dependency: "ollama", state: "unknown", tookMs: null, reason: "timeout" },
  { service: "observe", dependency: "redis", state: "unknown", tookMs: null, reason: "unparseable" },
  { service: "observe", dependency: "postgres", state: "unknown", tookMs: null, reason: "not_configured" },
];

function dependencyEvent(lines: DependencyLine[] = ALL_LINES, checkedAt = CHECKED_AT): TrafficDependencyEvent {
  return { sequence: 1, checkedAt: new Date(checkedAt).toISOString(), lines };
}

async function markup(element: unknown): Promise<string> {
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function decode(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function textOf(fragment: string): string {
  return decode(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function tableByLabel(html: string, label: string): string {
  const labelAt = html.indexOf(`aria-label="${label}"`);
  expect(labelAt, `aria-label="${label}" 가 없다`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<table", labelAt), html.indexOf("</table>", labelAt) + "</table>".length);
}

function rowsOf(html: string, label: string): string[][] {
  const body = /<tbody[\s>][\s\S]*?<\/tbody>/.exec(tableByLabel(html, label))?.[0] ?? "";
  return (body.match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? []).map((row) => [...row.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/g)].map((match) => textOf(match[2])));
}

function headerOf(html: string, label: string): string[] {
  const head = /<thead[\s>][\s\S]*?<\/thead>/.exec(tableByLabel(html, label))?.[0] ?? "";
  return [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((match) => textOf(match[1]));
}

function svgOf(html: string): string {
  const match = /<svg[\s\S]*?<\/svg>/.exec(html);
  expect(match, "그림(svg)이 없다").not.toBeNull();
  return match![0];
}

function liveMapState(): TrafficMapStreamState {
  return [{ type: "open" as const }, { type: "map" as const, data: JSON.stringify(trafficMapEventOf(2, chatMapEdges())) }]
    .reduce(reduceTrafficMapStream, initialTrafficMapStreamState(trafficMapEventOf(1, chatMapEdges())));
}

async function renderBody(options: { map?: TrafficMapStreamState; dependencies?: TrafficDependencyEvent | null; now?: number; range?: "5m" | "1h" | "24h" } = {}) {
  return markup(createElement(TrafficMapBody, {
    range: options.range ?? "5m", state: options.map ?? liveMapState(),
    dependencies: initialTrafficDependencyStreamState(options.dependencies === undefined ? dependencyEvent() : options.dependencies),
    now: options.now ?? CHECKED_AT + 10_000,
  }));
}

const NO_DATA_TEXT = "의존 연결은 아직 확인하지 않았습니다";
const CURRENT_TEXT = "의존 연결은 지금의 상태입니다 — 고른 기간과 무관합니다";
const staleText = (checkedAt: number) => `의존 연결은 ${formatKoreanLogTime(new Date(checkedAt).toISOString())} 에 확인한 값입니다 — 지금 값이 아닐 수 있습니다`;

describe("5 그림 — 의존의 노드와 선", () => {
  it("의존의 노드는 닫힌 표의 이름 · 같은 이름(redis · postgres)은 하나 · '(목록 밖)' 이 붙지 않는다", async () => {
    const svg = svgOf(await renderBody());
    const nodes = [...svg.matchAll(/data-dependency-node="([^"]+)"/g)].map((match) => match[1]);
    expect(nodes).toEqual(["elasticsearch", "embedding", "redis", "postgres", "ollama"]);
    for (const name of nodes) expect(svg).toContain(`>${name}</text>`);
    expect(textOf(svg)).not.toContain("목록 밖");
  });

  it("선은 서비스마다 따로 — 일곱 · 서비스 → 의존", async () => {
    const svg = svgOf(await renderBody());
    expect([...svg.matchAll(/data-dependency-line="([^"]+)"/g)].map((match) => decode(match[1]))).toEqual([
      "backend→elasticsearch", "backend→embedding", "backend→redis", "backend→postgres", "llm-wrapper→ollama", "observe→redis", "observe→postgres",
    ]);
  });

  it("'덜 채워짐'의 점선(6 4 · edgeIncomplete)과 다른 표시 — stroke-dasharray=\"2 3\" · dependencyLine 클래스 · 상태마다 다른 클래스", async () => {
    const svg = svgOf(await renderBody());
    const lines = [...svg.matchAll(/<[a-z]+[^>]*data-dependency-line="([^"]+)"[^>]*>/g)].map((match) => ({ key: decode(match[1]), tag: match[0] }));
    expect(lines).toHaveLength(7);
    for (const { key, tag } of lines) {
      expect(tag, key).toMatch(/stroke-dasharray="2 3"/);
      expect(tag, key).not.toMatch(/stroke-dasharray="6 4"/);
      expect(tag, key).toMatch(/class="[^"]*_dependencyLine_/);
      expect(tag, key).not.toMatch(/_edge_|_edgeIncomplete_/);
      expect(tag, key).not.toMatch(/data-edge=/);
    }
    const stateClass = (key: string) => {
      const tag = lines.find((line) => line.key === key)!.tag;
      return { up: /_dependencyLineUp_/.test(tag), down: /_dependencyLineDown_/.test(tag), unknown: /_dependencyLineUnknown_/.test(tag), state: /data-dependency-state="([^"]+)"/.exec(tag)?.[1] };
    };
    expect(stateClass("backend→elasticsearch")).toEqual({ up: true, down: false, unknown: false, state: "up" });
    expect(stateClass("backend→embedding")).toEqual({ up: false, down: true, unknown: false, state: "down" });
    expect(stateClass("llm-wrapper→ollama")).toEqual({ up: false, down: false, unknown: true, state: "unknown" });
  });

  it("스타일 — 의존의 선은 가는 짧은 점선 · 끊김은 위험색 · 모름은 옅게(TrafficMap.module.css 의 규칙)", () => {
    const css = readFileSync(new URL("../../features/traffic-map/ui/TrafficMap.module.css", import.meta.url), "utf8");
    const rule = (name: string) => new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule("dependencyLine")).toMatch(/stroke-width:\s*1(\.\d+)?\b/);
    expect(rule("dependencyLineDown")).toContain("var(--danger)");
    expect(rule("dependencyLineUnknown")).toMatch(/opacity:\s*0?\.\d+/);
    expect(rule("dependencyLineUp")).not.toBe("");
  });

  it("통신의 선은 지금과 같다 — data-edge 다섯 · 덜 채워진 것만 6 4", async () => {
    const svg = svgOf(await renderBody());
    const edges = [...svg.matchAll(/<[a-z]+[^>]*data-edge="([^"]+)"[^>]*>/g)];
    expect(edges.map((match) => decode(match[1])).sort()).toEqual([
      "front→backend:request", "edge→front:request", "backend→llm-wrapper:request", "backend→llm-wrapper:stream", "alert→observe:health",
    ].sort());
    expect(edges.find((match) => decode(match[1]) === "edge→front:request")![0]).not.toContain("stroke-dasharray");
    expect(edges.find((match) => decode(match[1]) === "front→backend:request")![0]).toContain('stroke-dasharray="6 4"');
  });
});

describe("5 표 '의존 연결'", () => {
  it("머리 · 줄마다 서비스 · 의존 · 상태의 글 · 걸린 시간 · 까닭 · 확인한 때", async () => {
    const html = await renderBody();
    expect(headerOf(html, "의존 연결")).toEqual(["서비스", "의존", "상태", "걸린 시간", "까닭", "확인한 때"]);
    const at = formatKoreanLogTime(new Date(CHECKED_AT).toISOString());
    expect(rowsOf(html, "의존 연결")).toEqual([
      ["backend", "elasticsearch", "연결됨", "12ms", "—", at],
      ["backend", "embedding", "끊김", "—", "—", at],
      ["backend", "redis", "연결됨", "1ms", "—", at],
      ["backend", "postgres", "끊김", "41ms", "—", at],
      ["llm-wrapper", "ollama", "모름", "—", "닿지 않음(4초 초과)", at],
      ["observe", "redis", "모름", "—", "읽을 수 없는 답(옛 판일 수 있음)", at],
      ["observe", "postgres", "모름", "—", "설정 없음", at],
    ]);
  });

  it("까닭의 글 — 닿지 않음 · 알리지 않음", async () => {
    const html = await renderBody({ dependencies: dependencyEvent([
      { service: "llm-wrapper", dependency: "ollama", state: "unknown", tookMs: null, reason: "unreachable" },
      { service: "observe", dependency: "redis", state: "unknown", tookMs: null, reason: "not_reported" },
    ]) });
    expect(rowsOf(html, "의존 연결").map((row) => row[4])).toEqual(["닿지 않음", "알리지 않음"]);
  });

  it("제목 '의존 연결' · '지금의 상태'라는 글 — 어느 기간을 골라도", async () => {
    for (const range of ["5m", "1h", "24h"] as const) {
      const html = await renderBody({ range });
      expect(html).toMatch(/<h2[^>]*>의존 연결<\/h2>/);
      expect(textOf(html)).toContain(CURRENT_TEXT);
    }
  });

  it("통신의 지도를 읽지 못했거나 아직 없어도 의존 연결의 표는 보인다", async () => {
    const failed = [{ type: "map" as const, data: JSON.stringify({ sequence: 1, fetchedAt: new Date(CHECKED_AT).toISOString(), range: "5m", map: upstreamFailure("unreachable") }) }]
      .reduce(reduceTrafficMapStream, initialTrafficMapStreamState(null));
    expect(rowsOf(await renderBody({ map: failed }), "의존 연결")).toHaveLength(7);
    expect(rowsOf(await renderBody({ map: initialTrafficMapStreamState(null) }), "의존 연결")).toHaveLength(7);
  });
});

describe("5 첫 조회 전 · 낡음", () => {
  it("의존의 값이 아직 없으면 — '의존 연결은 아직 확인하지 않았습니다' · 표 · 의존의 선 없음 · 통신의 그림은 그대로", async () => {
    const html = await renderBody({ dependencies: null });
    expect(textOf(html)).toContain(NO_DATA_TEXT);
    expect(html).not.toContain('aria-label="의존 연결"');
    const svg = svgOf(html);
    expect(svg).not.toContain("data-dependency-line");
    expect(svg).toContain("data-edge");
  });

  it("마지막 확인이 90초 안이면 낡음 표시가 없고, 넘으면 '<시각> 에 확인한 값입니다'", async () => {
    expect(textOf(await renderBody({ now: CHECKED_AT + 90_000 }))).not.toContain("에 확인한 값입니다");
    expect(textOf(await renderBody({ now: CHECKED_AT + 90_001 }))).toContain(staleText(CHECKED_AT));
  });

  it("끊기면(다시 붙는 중) 시각과 상관없이 낡음 표시", async () => {
    const broken = reduceTrafficMapStream(liveMapState(), { type: "error" });
    expect(textOf(await renderBody({ map: broken, now: CHECKED_AT + 1_000 }))).toContain(staleText(CHECKED_AT));
  });

  it("값이 있으면 '아직 확인하지 않았습니다'가 없다", async () => {
    expect(textOf(await renderBody())).not.toContain(NO_DATA_TEXT);
  });
});

describe("화면(쪽)의 첫 그림 — 의존을 기다리지 않는다", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
    vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
    vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
    vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
    vi.stubEnv("LOG_REDIS_URL", "");
    state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
    const observe = createFakeObserveMap({ edges: chatMapEdges(), servers: [fakeMapServer()] });
    vi.stubGlobal("fetch", createRoutedFetch((url, init) => {
      if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected host ${url.hostname}`);
      return observe.handler(url, init);
    }));
    defaultTrafficMapHub().clear();
    for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  it("처음 연 쪽 — 통신 지도는 그려지고 의존은 '아직 확인하지 않았습니다' · '지금의 상태'의 글은 표가 생길 때", async () => {
    const html = await markup(await TrafficPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('aria-label="통신 선"');
    expect(textOf(html)).toContain(NO_DATA_TEXT);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
