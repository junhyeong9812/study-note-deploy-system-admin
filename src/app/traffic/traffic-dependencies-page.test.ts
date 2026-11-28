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

// ---- T9d 리뷰 R2: 의존의 그림은 통신의 원에서 떼어 "의존 연결" 절 안에 따로(두 줄 — 윗줄 서비스 셋 · 아랫줄 의존 다섯 · 선 일곱) ----

const DEPENDENCY_NAMES_IN_ORDER = ["elasticsearch", "embedding", "redis", "postgres", "ollama"];
const SERVICE_NAMES = ["backend", "llm-wrapper", "observe"];
const LINE_KEYS = ["backend→elasticsearch", "backend→embedding", "backend→redis", "backend→postgres", "llm-wrapper→ollama", "observe→redis", "observe→postgres"];
/** 두 줄 그림에서 선의 엇갈림이 가장 적은 수 — 줄의 차례 3! × 5! = 720 가지를 모두 세면 1(backend · observe 가 redis · postgres 둘을 함께 가져 K2,2 — 한 번은 반드시 엇갈린다). */
const MINIMUM_CROSSINGS = 1;

/** 의존의 그림 — "의존 연결" 절 안의 svg(data-dependency-figure). */
function dependencyFigureOf(html: string): string {
  const match = /<svg[^>]*data-dependency-figure[^>]*>[\s\S]*?<\/svg>/.exec(html);
  expect(match, "의존의 그림(svg data-dependency-figure)이 없다").not.toBeNull();
  return match![0];
}

/** 통신의 그림 — 첫 svg 가 아니라 data-dependency-figure 가 없는 svg. */
function trafficFigureOf(html: string): string {
  const figure = [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((match) => match[0]).find((svg) => !/^<svg[^>]*data-dependency-figure/.test(svg));
  expect(figure, "통신의 그림이 없다").toBeDefined();
  return figure!;
}

interface Box { name: string; kind: "service" | "dependency"; left: number; top: number; right: number; bottom: number }
interface Segment { key: string; x1: number; y1: number; x2: number; y2: number; tag: string }

const numberAttribute = (tag: string, name: string): number => {
  const value = new RegExp(`\\s${name}="([^"]+)"`).exec(tag)?.[1];
  expect(value, `${name} 가 없다: ${tag}`).toBeDefined();
  return Number(value);
};

function boxesOf(svg: string): Box[] {
  return [...svg.matchAll(/<g[^>]*data-dependency-(service|node)="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)].map((match) => {
    const rect = /<rect[^>]*>/.exec(match[3])?.[0];
    expect(rect, `${match[2]} 의 상자(rect)가 없다`).toBeDefined();
    const left = numberAttribute(rect!, "x");
    const top = numberAttribute(rect!, "y");
    return { name: match[2], kind: match[1] === "service" ? "service" : "dependency", left, top, right: left + numberAttribute(rect!, "width"), bottom: top + numberAttribute(rect!, "height") };
  });
}

function segmentsOf(svg: string): Segment[] {
  return [...svg.matchAll(/<line[^>]*data-dependency-line="([^"]+)"[^>]*>/g)].map((match) => ({
    key: decode(match[1]), tag: match[0], x1: numberAttribute(match[0], "x1"), y1: numberAttribute(match[0], "y1"), x2: numberAttribute(match[0], "x2"), y2: numberAttribute(match[0], "y2"),
  }));
}

/** 선분이 상자의 안쪽(가장자리에서 0.5 안으로 들인 것)을 지나는가 — Liang–Barsky 자르기. */
function segmentEntersBox(segment: Segment, box: Box): boolean {
  const inset = 0.5;
  const [left, right, top, bottom] = [box.left + inset, box.right - inset, box.top + inset, box.bottom - inset];
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  let low = 0;
  let high = 1;
  for (const [p, q] of [[-dx, segment.x1 - left], [dx, right - segment.x1], [-dy, segment.y1 - top], [dy, bottom - segment.y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) low = Math.max(low, t); else high = Math.min(high, t);
    if (low > high) return false;
  }
  return high - low > 1e-9;
}

/** 두 선분이 끝점이 아닌 곳에서 엇갈리는가(같은 끝점을 나누는 선은 세지 않는다). */
function segmentsCross(first: Segment, second: Segment): boolean {
  const orientation = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  const d1 = orientation(first.x1, first.y1, first.x2, first.y2, second.x1, second.y1);
  const d2 = orientation(first.x1, first.y1, first.x2, first.y2, second.x2, second.y2);
  const d3 = orientation(second.x1, second.y1, second.x2, second.y2, first.x1, first.y1);
  const d4 = orientation(second.x1, second.y1, second.x2, second.y2, first.x2, first.y2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

const endpointsOf = (key: string) => key.split("→");

describe("R2 통신의 그림에는 의존이 없다(앞 판 22200cc 의 꼴)", () => {
  it("통신의 svg 에 의존의 노드 · 선 · 클래스 · 2 3 · 의존의 이름이 0 · viewBox 는 의존 때문에 늘지 않는다(0 0 480 480)", async () => {
    const svg = trafficFigureOf(await renderBody());
    expect(svg).not.toMatch(/data-dependency/);
    expect(svg).not.toMatch(/_dependency/);
    expect(svg).not.toContain('stroke-dasharray="2 3"');
    for (const name of DEPENDENCY_NAMES_IN_ORDER) expect(svg).not.toContain(`>${name}</text>`);
    expect(/viewBox="([^"]+)"/.exec(svg)?.[1]).toBe("0 0 480 480");
    expect(trafficFigureOf(await renderBody({ dependencies: null }))).toBe(svg);   // 의존이 있든 없든 같은 그림
  });

  it("통신의 선은 지금과 같다 — data-edge 다섯 · 덜 채워진 것만 6 4", async () => {
    const svg = trafficFigureOf(await renderBody());
    const edges = [...svg.matchAll(/<[a-z]+[^>]*data-edge="([^"]+)"[^>]*>/g)];
    expect(edges.map((match) => decode(match[1])).sort()).toEqual([
      "front→backend:request", "edge→front:request", "backend→llm-wrapper:request", "backend→llm-wrapper:stream", "alert→observe:health",
    ].sort());
    expect(edges.find((match) => decode(match[1]) === "edge→front:request")![0]).not.toContain("stroke-dasharray");
    expect(edges.find((match) => decode(match[1]) === "front→backend:request")![0]).toContain('stroke-dasharray="6 4"');
  });
});

describe("R2 의존의 그림 — '의존 연결' 절 안 · 두 줄", () => {
  it("자리 — 제목 '의존 연결' 뒤 · 표 앞 · aria-hidden(표가 같은 값을 준다)", async () => {
    const html = await renderBody();
    const figure = dependencyFigureOf(html);
    const headingAt = html.search(/<h2[^>]*>의존 연결<\/h2>/);
    const figureAt = html.indexOf(figure);
    const tableAt = html.indexOf('aria-label="의존 연결"');
    expect(headingAt).toBeGreaterThan(-1);
    expect(headingAt).toBeLessThan(figureAt);
    expect(figureAt).toBeLessThan(tableAt);
    expect(figure).toMatch(/^<svg[^>]*aria-hidden="true"/);
    expect([...html.matchAll(/data-dependency-figure/g)]).toHaveLength(1);
  });

  it("윗줄 = 서비스 셋 · 아랫줄 = 의존 다섯(이름마다 하나 · '(목록 밖)' 없음) · 선 일곱(서비스 → 의존)", async () => {
    const figure = dependencyFigureOf(await renderBody());
    const boxes = boxesOf(figure);
    expect(boxes.filter((box) => box.kind === "service").map((box) => box.name).sort()).toEqual([...SERVICE_NAMES].sort());
    expect(boxes.filter((box) => box.kind === "dependency").map((box) => box.name).sort()).toEqual([...DEPENDENCY_NAMES_IN_ORDER].sort());
    for (const name of [...SERVICE_NAMES, ...DEPENDENCY_NAMES_IN_ORDER]) expect(figure).toContain(`>${name}</text>`);
    expect(textOf(figure)).not.toContain("목록 밖");
    expect(segmentsOf(figure).map((segment) => segment.key).sort()).toEqual([...LINE_KEYS].sort());
    const serviceBottom = Math.max(...boxes.filter((box) => box.kind === "service").map((box) => box.bottom));
    const dependencyTop = Math.min(...boxes.filter((box) => box.kind === "dependency").map((box) => box.top));
    expect(serviceBottom, "서비스는 윗줄 · 의존은 아랫줄").toBeLessThan(dependencyTop);
  });

  it.each([
    ["통신의 선이 0 인 지도", () => [{ type: "map" as const, data: JSON.stringify(trafficMapEventOf(2, [])) }].reduce(reduceTrafficMapStream, initialTrafficMapStreamState(null))],
    ["통신의 지도를 읽지 못함", () => [{ type: "map" as const, data: JSON.stringify({ sequence: 1, fetchedAt: new Date(CHECKED_AT).toISOString(), range: "5m", map: upstreamFailure("unreachable") }) }].reduce(reduceTrafficMapStream, initialTrafficMapStreamState(null))],
    ["통신의 지도가 아직 없음", () => initialTrafficMapStreamState(null)],
  ] as [string, () => TrafficMapStreamState][])("%s 에서도 서비스 셋 · 선 일곱이 늘 그려진다(그 기간의 통신과 무관)", async (_label, makeMap) => {
    const figure = dependencyFigureOf(await renderBody({ map: makeMap() }));
    expect(boxesOf(figure).filter((box) => box.kind === "service").map((box) => box.name).sort()).toEqual([...SERVICE_NAMES].sort());
    expect(segmentsOf(figure)).toHaveLength(7);
  });

  it("선의 표시 — stroke-dasharray=\"2 3\" · dependencyLine + 상태의 클래스 · data-dependency-state · 통신의 클래스 없음", async () => {
    const segments = segmentsOf(dependencyFigureOf(await renderBody()));
    for (const { key, tag } of segments) {
      expect(tag, key).toMatch(/stroke-dasharray="2 3"/);
      expect(tag, key).toMatch(/class="[^"]*_dependencyLine_/);
      expect(tag, key).not.toMatch(/_edge_|_edgeIncomplete_|data-edge=/);
    }
    const stateOf = (key: string) => {
      const tag = segments.find((segment) => segment.key === key)!.tag;
      return { up: /_dependencyLineUp_/.test(tag), down: /_dependencyLineDown_/.test(tag), unknown: /_dependencyLineUnknown_/.test(tag), state: /data-dependency-state="([^"]+)"/.exec(tag)?.[1] };
    };
    expect(stateOf("backend→elasticsearch")).toEqual({ up: true, down: false, unknown: false, state: "up" });
    expect(stateOf("backend→embedding")).toEqual({ up: false, down: true, unknown: false, state: "down" });
    expect(stateOf("llm-wrapper→ollama")).toEqual({ up: false, down: false, unknown: true, state: "unknown" });
    expect(stateOf("observe→postgres")).toEqual({ up: false, down: false, unknown: true, state: "unknown" });
  });

  it("모두 설정 없음(not_configured)이어도 그림은 그대로 — 선 일곱 모두 모름의 클래스", async () => {
    const lines: DependencyLine[] = ALL_LINES.map((line) => ({ ...line, state: "unknown", tookMs: null, reason: "not_configured" }));
    const segments = segmentsOf(dependencyFigureOf(await renderBody({ dependencies: dependencyEvent(lines) })));
    expect(segments).toHaveLength(7);
    expect(segments.every((segment) => /_dependencyLineUnknown_/.test(segment.tag) && !/_dependencyLineUp_|_dependencyLineDown_/.test(segment.tag))).toBe(true);
  });

  it("의존의 사건이 아직 없으면 의존의 그림이 없다('아직 확인하지 않았습니다')", async () => {
    const html = await renderBody({ dependencies: null });
    expect(html).not.toMatch(/data-dependency-figure/);
    expect(textOf(html)).toContain(NO_DATA_TEXT);
  });
});

describe("R2 읽힘을 수로 — 좌표를 뽑아 센다", () => {
  it("① 어느 선도 자기 두 끝이 아닌 노드의 상자를 지나지 않는다", async () => {
    const figure = dependencyFigureOf(await renderBody());
    const boxes = boxesOf(figure);
    for (const segment of segmentsOf(figure)) {
      const [service, dependency] = endpointsOf(segment.key);
      for (const box of boxes) {
        if ((box.kind === "service" && box.name === service) || (box.kind === "dependency" && box.name === dependency)) continue;
        expect(segmentEntersBox(segment, box), `${segment.key} 가 ${box.name} 를 지난다`).toBe(false);
      }
    }
  });

  it("선의 두 끝은 제 노드의 상자에 닿는다(서비스의 상자 아래 · 의존의 상자 위 — 가장자리에서 2 안)", async () => {
    const figure = dependencyFigureOf(await renderBody());
    const boxes = boxesOf(figure);
    for (const segment of segmentsOf(figure)) {
      const [service, dependency] = endpointsOf(segment.key);
      const from = boxes.find((box) => box.kind === "service" && box.name === service)!;
      const to = boxes.find((box) => box.kind === "dependency" && box.name === dependency)!;
      expect(segment.x1 >= from.left - 2 && segment.x1 <= from.right + 2 && Math.abs(segment.y1 - from.bottom) <= 2, `${segment.key} 의 시작`).toBe(true);
      expect(segment.x2 >= to.left - 2 && segment.x2 <= to.right + 2 && Math.abs(segment.y2 - to.top) <= 2, `${segment.key} 의 끝`).toBe(true);
    }
  });

  it("② 노드의 상자끼리 겹치지 않는다", async () => {
    const boxes = boxesOf(dependencyFigureOf(await renderBody()));
    expect(boxes).toHaveLength(8);
    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        const [a, b] = [boxes[first], boxes[second]];
        const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        expect(overlaps, `${a.name} 와 ${b.name} 가 겹친다`).toBe(false);
      }
    }
  });

  it(`③ 선끼리의 엇갈림은 ${MINIMUM_CROSSINGS}번 이하(가능한 가장 적은 수)`, async () => {
    const segments = segmentsOf(dependencyFigureOf(await renderBody()));
    let crossings = 0;
    for (let first = 0; first < segments.length; first += 1) {
      for (let second = first + 1; second < segments.length; second += 1) {
        const [a, b] = [endpointsOf(segments[first].key), endpointsOf(segments[second].key)];
        if (a[0] === b[0] || a[1] === b[1]) continue;
        if (segmentsCross(segments[first], segments[second])) crossings += 1;
      }
    }
    expect(crossings).toBeLessThanOrEqual(MINIMUM_CROSSINGS);
  });

  it("④ 모바일 폭(390px)에서 넘치지 않는다 — viewBox 가 있고 px 너비를 박지 않는다 · 모든 상자와 선이 viewBox 안 · css 가 너비 100% · 높이 auto", async () => {
    const figure = dependencyFigureOf(await renderBody());
    const viewBox = /viewBox="([^"]+)"/.exec(figure)?.[1]?.split(/\s+/).map(Number);
    expect(viewBox, "viewBox 가 없다").toHaveLength(4);
    const [minX, minY, width, height] = viewBox!;
    expect(/^<svg[^>]*\swidth="\d+(px)?"/.test(figure), "px 너비를 박았다").toBe(false);
    for (const box of boxesOf(figure)) {
      expect(box.left >= minX && box.top >= minY && box.right <= minX + width && box.bottom <= minY + height, `${box.name} 가 viewBox 밖`).toBe(true);
    }
    for (const segment of segmentsOf(figure)) {
      for (const [x, y] of [[segment.x1, segment.y1], [segment.x2, segment.y2]]) expect(x >= minX && x <= minX + width && y >= minY && y <= minY + height, segment.key).toBe(true);
    }
    const css = readFileSync(new URL("../../features/traffic-map/ui/TrafficMap.module.css", import.meta.url), "utf8");
    const rule = new RegExp(`\\.dependencyFigure\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/height:\s*auto/);
    expect(figure).toMatch(/class="[^"]*_dependencyFigure_/);
  });

  it("스타일 — 의존의 선은 가는 짧은 점선 · 끊김은 위험색 · 모름은 옅게(TrafficMap.module.css 의 규칙)", () => {
    const css = readFileSync(new URL("../../features/traffic-map/ui/TrafficMap.module.css", import.meta.url), "utf8");
    const rule = (name: string) => new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule("dependencyLine")).toMatch(/stroke-width:\s*1(\.\d+)?\b/);
    expect(rule("dependencyLineDown")).toContain("var(--danger)");
    expect(rule("dependencyLineUnknown")).toMatch(/opacity:\s*0?\.\d+/);
    expect(rule("dependencyLineUp")).not.toBe("");
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
