/** 서버 자원 화면 1단계 — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 관측 서버)를 거쳐
 * 서버 묶음(이름 · 받은 때 · 현재 값) · 값이 없을 때의 세 글 · 오래됨 · 수신 없음 · 울리는 임계값의 표식 + 글 · 부분 실패 · 내비게이션을 본다.
 * 비밀값 · 관측 서버 주소 · 원문 표식 · 계약 밖 칸(id · project)은 HTML 에 없고, 스크립트를 더하지 않는다. */
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

import ResourcesPage from "@/app/resources/page";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  HOUR, MINUTE, NOW_MILLISECONDS, createFakeObserveMetrics, evenlySpacedPoints, observePoint, javaInstantText, observeContainer, observeFiring, observeGpu, observeHost, observeLatestBody,
  observeLatestServer, observeSilentServer, seriesKey, type FakeObserveMetrics,
} from "@/features/resources/lib/resource-metrics-test-fakes";
import {
  FAKE_OBSERVE_SECRET, FAKE_OBSERVE_URL, createRoutedFetch, expectNoForbiddenText, leakyErrorBody, leakyNetworkError, textResponse,
} from "@/shared/lib/upstream-test-fakes";

let fake: FakeObserveMetrics;
const upstreamFetch = createRoutedFetch((url, init) => {
  if (url.origin !== new URL(FAKE_OBSERVE_URL).origin) throw new Error(`unexpected upstream ${url.hostname}`);
  return fake.handler(url, init);
});

/** 기본 네 서버: 158 값이 다 있음 · 164 GPU · 9 일부 값 없음(host 를 읽지 못한 칸 포함 아님) · spare 수신 없음. */
function defaultServers(): Record<string, unknown>[] {
  return [
    observeLatestServer("158"),
    observeLatestServer("164", { gpus: [observeGpu()], containers: [observeContainer({ name: "llm-ollama", series_name: "llm-ollama" })] }),
    observeLatestServer("9", { host: observeHost({ cpu_pct: null, net_tx_bps: null }), gpus: [], missing: [] }),
    observeSilentServer("spare"),
  ];
}

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await ResourcesPage({ searchParams: Promise.resolve(searchParams) });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function textOf(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, "");
}

/** 묶음 안의 지표 카드 하나 — aria-label("<서버> <지표>")을 단 <div> 의 여는 태그부터 짝이 맞는 </div> 까지(안의 <div> 를 세어 — 카드 밖의 것은 들지 않는다). */
function metricCard(fragment: string, server: string, title: string): string {
  const labelAt = fragment.indexOf(`aria-label="${server} ${title}"`);
  expect(labelAt, `${server} ${title} 카드가 없다`).toBeGreaterThan(0);
  const start = fragment.lastIndexOf("<div", labelAt);
  const tags = /<div\b|<\/div>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(fragment); match !== null; match = tags.exec(fragment)) {
    depth += match[0] === "</div>" ? -1 : 1;
    if (depth === 0) return fragment.slice(start, match.index + match[0].length);
  }
  throw new Error(`${server} ${title} 카드가 닫히지 않는다`);
}

/** 한 서버의 묶음(section) */
function serverSection(html: string, server: string): string {
  const match = new RegExp(`<section[^>]*aria-labelledby="resource-server-${server}"[^>]*>([\\s\\S]*?)</section>`).exec(html);
  expect(match, `${server} 묶음이 없다`).not.toBeNull();
  return match![1];
}

/** 묶음 안의 한 값 칸(dt 이름 → dd 글) */
function readingText(section: string, label: string): string {
  const match = new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>([\\s\\S]*?)</dd>`).exec(section);
  expect(match, `${label} 칸이 없다`).not.toBeNull();
  return textOf(match![1]);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  fake = createFakeObserveMetrics(() => observeLatestBody(defaultServers(), []));
  upstreamFetch.mockClear();
  vi.stubGlobal("fetch", upstreamFetch);
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

describe("서버마다 한 묶음 — 이름 · 받은 때 · 현재 값", () => {
  it("서버 이름순으로 묶음 넷, 제목 · 새로 고침 링크", async () => {
    const html = await render();
    expect([...html.matchAll(/aria-labelledby="resource-server-([^"]+)"/g)].map((match) => match[1])).toEqual(["158", "164", "9", "spare"]);
    expect(html).toContain(">서버 자원</h1>");
    expect(html).toMatch(/href="\/resources\?range=1h"[^>]*>지금 새로 고침</);
  });

  it("158 의 현재 값 — 단위 글자와 사용/전체", async () => {
    const section = serverSection(await render(), "158");
    expect(readingText(section, "CPU")).toBe("3.4%");
    expect(readingText(section, "메모리")).toBe("13.1%2.0 GiB / 14.9 GiB");
    expect(readingText(section, "디스크")).toBe("16.1%75.0 GiB / 465.9 GiB");
    expect(readingText(section, "네트워크 받기")).toBe("1.2 KiB/s");
    expect(readingText(section, "네트워크 보내기")).toBe("3.3 KiB/s");
    expect(readingText(section, "디스크 읽기")).toBe("0 B/s");   // 0 은 실제 값
    expect(readingText(section, "디스크 쓰기")).toBe("50.8 KiB/s");
    expect(readingText(section, "GPU")).toBe("GPU 없음");
    expect(textOf(section)).toContain("받은 때 1분 안");
  });

  it("164 의 GPU — GPU 마다 카드 하나(사용률 · 메모리 · 온도)", async () => {
    const card = metricCard(serverSection(await render(), "164"), "164", "GPU 0");
    expect(readingText(card, "사용률")).toBe("12.0%");
    expect(readingText(card, "메모리")).toBe("0.1%9.0 MiB / 8.0 GiB");
    expect(readingText(card, "온도")).toBe("28°C");
  });
});

describe("값이 없을 때의 세 글 — 0 으로 보이지 않는다", () => {
  it("없음 — 값이 null 인 칸만", async () => {
    const section = serverSection(await render(), "9");
    expect(readingText(section, "CPU")).toBe("없음");
    expect(readingText(section, "네트워크 보내기")).toBe("없음");
    expect(readingText(section, "네트워크 받기")).toBe("1.2 KiB/s");
  });

  it("읽지 못함 — missing 에 host · GPU 값 없음 — missing 에 gpus", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158", { host: null, missing: ["host", "gpus"] })], []);
    const section = serverSection(await render(), "158");
    for (const label of ["CPU", "메모리", "디스크", "네트워크 받기", "네트워크 보내기", "디스크 읽기", "디스크 쓰기"]) expect(readingText(section, label)).toBe("읽지 못함");
    expect(readingText(section, "GPU")).toBe("GPU 값 없음");
  });

  it("확인하지 못함 — GPU 칸 없음 · stale 칸 없음 · firing 칸 없음", async () => {
    const row = observeLatestServer("158");
    delete row.gpus;
    delete row.stale;
    fake.latest = () => observeLatestBody([row], undefined);
    const html = await render();
    const section = serverSection(html, "158");
    expect(readingText(section, "GPU")).toBe("확인하지 못함");
    expect(textOf(section)).toContain("확인하지 못함");
    expect(textOf(html)).toContain("울리는 임계값: 확인하지 못함");
  });
});

describe("오래됨 · 수신 없음", () => {
  it("오래된 값 — 'N분 전 값' 표시와 지금 값이 아니라는 글, 값은 그대로", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158", { stale: true, age_ms: 12 * MINUTE + 30_000 })], []);
    const section = serverSection(await render(), "158");
    expect(textOf(section)).toContain("12분 전 값");
    expect(textOf(section)).toContain("아래 값은 12분 전 값입니다");
    expect(readingText(section, "CPU")).toBe("3.4%");
  });

  it("수신 없음 + 그 기간에 점 없음 → 카드 없이 한 줄(표식 + 글 · '이 기간에 값이 없습니다', 컨테이너 표 없음)", async () => {
    const section = serverSection(await render(), "spare");
    expect(textOf(section)).toContain("spare✕수신 없음이 기간에 값이 없습니다");
    expect(section).not.toContain('role="group"');
    expect(section).not.toContain("<table");
    expect(section).not.toContain("<svg");
    expect(section).not.toContain("측정");
    expect(textOf(section)).not.toContain("컨테이너");
  });
});

describe("§18 — 이름을 읽지 못한 서버 · 끊긴 지 오래된 서버", () => {
  it("이름을 읽지 못한 서버 줄이 있어도 나머지 서버는 그대로 — '이름을 읽지 못한 서버 N대'", async () => {
    fake.latest = () => observeLatestBody([observeLatestServer("158"), observeSilentServer("CI-Agent-9"), observeSilentServer("Home")], []);
    const html = await render();
    expect(readingText(serverSection(html, "158"), "CPU")).toBe("3.4%");
    expect(textOf(html)).toContain("이름을 읽지 못한 서버 2대");
    expect(textOf(html)).not.toContain("서버 값: 확인하지 못함");
    expect(html).not.toContain("CI-Agent-9");
  });

  it("다 읽으면 그 글이 없다", async () => {
    expect(textOf(await render())).not.toContain("이름을 읽지 못한");
  });

  it("24시간 넘게 끊긴 서버(at 없음 · 마지막 수신 이틀 전) → '수신 없음 · 마지막 수신 2일 전' — 한 번도 안 보낸 서버와 구분된다", async () => {
    fake.latest = () => observeLatestBody([
      observeLatestServer("158"),
      observeSilentServer("164", { received_at: javaInstantText(NOW_MILLISECONDS - 2 * 24 * HOUR - 5 * MINUTE), age_ms: 2 * 24 * HOUR + 5 * MINUTE }),
      observeSilentServer("spare"),
    ], []);
    const html = await render();
    expect(textOf(serverSection(html, "164"))).toContain("수신 없음 · 마지막 수신 2일 전");
    expect(textOf(serverSection(html, "spare"))).toContain("수신 없음");
    expect(textOf(serverSection(html, "spare"))).not.toContain("마지막 수신");
  });

  it("마지막 수신이 몇 시간 전이면 그 단위로('수신 없음 · 마지막 수신 3시간 전')", async () => {
    fake.latest = () => observeLatestBody([observeSilentServer("164", { received_at: javaInstantText(NOW_MILLISECONDS - 3 * HOUR), age_ms: 3 * HOUR + 10 * MINUTE })], []);
    expect(textOf(serverSection(await render(), "164"))).toContain("수신 없음 · 마지막 수신 3시간 전");
  });

  it("CPU 카드의 최댓값 — 점에 최댓값이 없으면 그 점의 평균이 후보(점 A 평균 90 · 최댓값 없음, 점 B 평균 10 · 최댓값 11 → 90.0%)", async () => {
    fake.series.set(seriesKey("158", "host", null), { points: [
      observePoint("host", RANGE_START + 30_000, { cpu_pct: [90, null] }), observePoint("host", RANGE_START + 60_000, { cpu_pct: [10, 11] }),
    ] });
    const card = metricCard(serverSection(await renderAtFixedNow(), "158"), "158", "CPU");
    expect(textOf(card)).toContain("CPU 1시간: 평균 최근 10.0% · 최댓값 90.0%");
  });
});

describe("지금 울리는 임계값 — 그 값 자리에 표식 + 글(심각도 · 규칙 · 언제부터)", () => {
  const since = javaInstantText(NOW_MILLISECONDS - 30 * MINUTE);

  it("디스크 경고는 디스크 칸에 '!' + 경고 · 디스크 경고 · KST 시각 부터 · 마지막 값", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), [observeFiring({ server: "9", rule: "disk_warning", severity: "warning", last_value: 86.2 })]);
    const section = serverSection(await render(), "9");
    const disk = readingText(section, "디스크");
    expect(disk).toContain("!경고디스크 경고");
    expect(disk).toContain("2026-11-24 20:30:00 부터 · 마지막 86.2%");   // since = 11:30 UTC → KST 20:30
    expect(section).toContain(`dateTime="${since}"`);
    expect(readingText(section, "CPU")).not.toContain("경고");
    expect(readingText(serverSection(await render(), "158"), "디스크")).not.toContain("경고");
  });

  it("위험은 '‼' + 위험 — CPU · 메모리 자리", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), [
      observeFiring({ server: "158", rule: "disk_critical", severity: "critical", last_value: 96 }),
      observeFiring({ server: "158", rule: "cpu", severity: "warning", last_value: 93.5 }),
      observeFiring({ server: "158", rule: "memory", severity: "warning", last_value: 91 }),
    ]);
    const section = serverSection(await render(), "158");
    expect(readingText(section, "디스크")).toContain("‼위험디스크 위험");
    expect(readingText(section, "CPU")).toContain("!경고CPU");
    expect(readingText(section, "메모리")).toContain("!경고메모리");
  });

  it("지표 끊김은 받은 때 옆에 · 재시작 반복은 컨테이너 줄에 · 모르는 규칙은 '그 밖의 알림'", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), [
      observeFiring({ server: "spare", rule: "silent", severity: "warning", last_value: null }),
      observeFiring({ server: "164", rule: "restarts", target: "llm-ollama", severity: "warning", last_value: 3 }),
      observeFiring({ server: "164", rule: "brand_new_rule", severity: "info", last_value: null }),
    ]);
    const html = await render();
    expect(textOf(serverSection(html, "spare"))).toContain("!경고지표 끊김");
    const section = serverSection(html, "164");
    const others = textOf(section.slice(section.indexOf("그 밖의 알림")));
    expect(others).toContain("그 밖의 알림 1건");
    expect(others).toContain("?infobrand_new_rule");
    expect(textOf(othersBlock(section))).not.toContain("재시작 반복");
    expect(textOf(containerRow(section, "llm-ollama"))).toContain("!경고컨테이너 재시작 반복 · llm-ollama");
    expect(textOf(section)).not.toContain("마지막 3");   // 재시작 횟수는 퍼센트로 보이지 않는다
  });

  it("목록 밖 서버의 알림은 맨 위에 한 줄", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), [observeFiring({ server: "77", rule: "silent", severity: "warning", last_value: null })]);
    const html = await render();
    const top = html.slice(0, html.indexOf("resource-server-158"));
    expect(textOf(top)).toContain("목록 밖 서버의 알림 1건");
    expect(textOf(top)).toContain("77 · 지표 끊김");
  });
});

describe("일부가 실패해도 화면은 뜬다 — 고정 글자와 HTTP 상태만", () => {
  it("latest 503 → 서버 값만 확인하지 못함, 화면 틀은 그대로", async () => {
    fake.latest = () => textResponse(leakyErrorBody(), 503);
    const html = await render();
    expect(textOf(html)).toContain("서버 값: 확인하지 못함 — 관측 서버: 서버 일시 장애 · HTTP 503");
    expect(html).toContain(">서버 자원</h1>");
    expect(html).not.toContain("resource-server-");
    expectNoForbiddenText(html);
  });

  it("host 계열이 실패해도 1단계 화면(현재 값)은 그대로", async () => {
    fake.series.set(seriesKey("158", "host", null), { response: () => textResponse(leakyErrorBody(), 500) });
    const section = serverSection(await render(), "158");
    expect(readingText(section, "CPU")).toBe("3.4%");
  });

  it("전부 닿지 않음 → 화면은 뜨고 닿지 않음만", async () => {
    fake.handler = () => Promise.reject(leakyNetworkError());
    const html = await render({ range: "24h", server: "158", container: "front-app" });
    expect(textOf(html)).toContain("서버 값: 확인하지 못함 — 관측 서버: 닿지 않음");
    expectNoForbiddenText(html);
  });
});

describe("HTML 에 없는 것 · 내비게이션", () => {
  it("비밀값 · 주소 · 원문 표식 · 계약 밖 칸(id · project)이 없고, 스크립트를 더하지 않는다", async () => {
    const html = await render();
    expectNoForbiddenText(html);
    expect(html).not.toContain("0123456789ab");
    expect(html).not.toContain("study-note-deploy-system-front");
    expect(html).not.toMatch(/<script/i);
  });

  it("다른 서버의 글자는 HTML 로 해석되지 않는다(서버 이름 · 규칙 낱말)", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), [observeFiring({ server: "9", rule: "<img src=x onerror=1>", severity: "<b>x</b>" })]);
    const html = await render();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
  });

  it("내비게이션의 '서버 자원'에 aria-current", async () => {
    expect(await render()).toMatch(/href="\/resources" aria-current="page"[^>]*>서버 자원</);
  });

  it("세션이 없으면 /login(관측 서버를 부르지 않는다)", async () => {
    state.cookieValue = undefined;
    await expect(render()).rejects.toThrow("redirect:/login");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

// ── 2단계(명세 §17): 그래프 · 기간 고르기 · 자동 갱신 ──

const RANGE_START = NOW_MILLISECONDS - HOUR;

/** 화면의 "지금"(진입 함수의 Date.now)을 NOW_MILLISECONDS 로 고정한다 — 타이머는 그대로, Date 만. 세션도 그 시각으로 다시 낸다. */
async function renderAtFixedNow(searchParams: Record<string, string> = {}): Promise<string> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(NOW_MILLISECONDS);
    state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, NOW_MILLISECONDS - 60_000);
    return await render(searchParams);
  } finally {
    vi.useRealTimers();
  }
}

/** 한 그래프(figure) — 제목으로 찾는다. */
function graphFigure(fragment: string, title: string): string {
  const match = new RegExp(`<figure[^>]*><figcaption[^>]*>${title}</figcaption>([\\s\\S]*?)</figure>`).exec(fragment);
  expect(match, `${title} 그래프가 없다`).not.toBeNull();
  return match![1];
}

/** 묶음 안 — 늘 그래프까지 보이는 카드 셋(visible)과, 네트워크 · 디스크 입출력 · GPU 카드 묶음(more). folded 는 펼쳐 둔 경우만(그래프가 있을 때) more, 아니면 null. */
function splitMore(section: string): { visible: string; more: string; folded: string | null } {
  const containersAt = section.indexOf(">컨테이너");
  expect(containersAt, "컨테이너 표 자리가 없다").toBeGreaterThan(0);
  const moreAt = section.indexOf('네트워크 · 디스크 입출력 · GPU"');
  expect(moreAt, "네트워크 · 디스크 입출력 · GPU 묶음이 없다").toBeGreaterThan(0);
  const more = section.slice(moreAt, containersAt);
  return { visible: section.slice(0, moreAt), more, folded: more.includes(">접기</a>") ? more : null };   // 펼침 = 접기 링크가 있음
}

/** "그 밖의 알림" 묶음(없으면 빈 글) */
function othersBlock(section: string): string {
  const start = section.indexOf("그 밖의 알림");
  if (start < 0) return "";
  const end = section.indexOf("</ul>", start);
  return section.slice(start, end);
}

/** 컨테이너 표의 한 줄(계열 이름 링크로 찾는다) */
function containerRow(section: string, seriesName: string): string {
  const match = new RegExp(`<tr[^>]*><td[^>]*><a[^>]*>${seriesName}</a>([\\s\\S]*?)</tr>`).exec(section);
  expect(match, `${seriesName} 줄이 없다`).not.toBeNull();
  return match![0];
}

/** 줄의 칸 글(td 마다) */
function rowCells(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => textOf(match[1]));
}

function hostPointsWithGap(): Record<string, unknown>[] {
  const points = evenlySpacedPoints("host", RANGE_START + 30_000, 30_000, 6, (index) => ({
    cpu_pct: [10 + index, 20 + index], mem_used: [4e9, 5e9], mem_total: [16e9, 16e9], disk_used: [100, 110], disk_total: [1000, 1000],
    net_rx_bps: [1000, 2000], net_tx_bps: [500, 900], io_read_bps: [0, 0], io_write_bps: [10, 30],
  }));
  // 빈 구간 하나(10분 뒤) + 혼자 남은 점
  points.push(observePoint("host", RANGE_START + 20 * MINUTE, { cpu_pct: [50, 60], mem_used: [8e9, 8e9], mem_total: [16e9, 16e9] }));
  return points;
}

describe("그래프 — CPU · 메모리 · 디스크는 늘, 나머지는 접어 둔다", () => {
  beforeEach(() => {
    fake.series.set(seriesKey("158", "host", null), { points: hostPointsWithGap() });
  });

  it("늘 보이는 셋 — 안 펼친 서버는 접힌 지표의 수치만, 그래프는 '그래프 더 보기' 링크뿐(SVG 를 그리지 않는다)", async () => {
    const section = serverSection(await renderAtFixedNow(), "158");
    const { visible, folded, more } = splitMore(section);
    expect(readingText(more, "네트워크 받기")).toBe(readingText(section, "네트워크 받기"));
    expect(readingText(more, "디스크 쓰기")).not.toBe("");
    for (const title of ["CPU", "메모리", "디스크"]) graphFigure(visible, title);
    expect(folded).toBeNull();
    expect(section).not.toContain(">네트워크</figcaption>");
    expect(section).not.toContain(">디스크 입출력</figcaption>");
    expect(section).not.toContain("<details");
    expect(section).toContain('href="/resources?range=1h&amp;open=158">그래프 더 보기 — 네트워크 · 디스크 입출력 · GPU</a>');
    expect(section.match(/<svg[^>]*role="img"/g)).toHaveLength(3);
  });

  it("펼쳐 둔 서버(open)는 네트워크 · 디스크 입출력 · GPU 를 그리고 '접기' 링크", async () => {
    const html = await renderAtFixedNow({ open: "158,164" });
    const folded = splitMore(serverSection(html, "158")).folded!;
    graphFigure(folded, "네트워크");
    graphFigure(folded, "디스크 입출력");
    expect(readingText(metricCard(folded, "158", "GPU"), "GPU")).toBe("GPU 없음");
    expect(folded).toContain('href="/resources?range=1h&amp;open=164">접기</a>');
    const gpuFolded = splitMore(serverSection(html, "164")).folded!;
    graphFigure(gpuFolded, "GPU 0 사용률");
    graphFigure(gpuFolded, "GPU 0 메모리");
  });

  it("SVG — role=img 와 모델의 글 요약을 이름으로, 같은 요약을 그래프 아래 글로", async () => {
    const cpu = graphFigure(serverSection(await renderAtFixedNow(), "158"), "CPU");
    expect(cpu).toMatch(/<svg[^>]*role="img"[^>]*aria-label="CPU 1시간: 평균 최근 50\.0% · 최댓값 60\.0%"/);   // 마지막 값은 10분 뒤 혼자 남은 점
    expect(textOf(cpu)).toContain("CPU 1시간: 평균 최근 50.0% · 최댓값 60.0%");
  });

  it("선 둘(평균 · 최댓값)과 범례 글 — 빈 구간은 끊기고 혼자 남은 점은 표식", async () => {
    const cpu = graphFigure(serverSection(await renderAtFixedNow(), "158"), "CPU");
    const paths = [...cpu.matchAll(/<path class="([^"]*)" d="([^"]*)"/g)];
    expect(paths).toHaveLength(2);
    expect(paths[0][1]).not.toBe(paths[1][1]);   // 모양이 다르다(굵기 · 무늬)
    for (const [, , d] of paths) expect(d.match(/M/g)).toHaveLength(1);   // 6점 조각 하나 — 10분 뒤 점은 선에 잇지 않는다
    expect(cpu.match(/<circle /g)).toHaveLength(2);   // 혼자 남은 점(평균 · 최댓값)
    expect(textOf(cpu)).toMatch(/평균.*최댓값/);
    expect(cpu).toMatch(/<ul[^>]*aria-label="선"/);
  });

  it("축 눈금 — 값(퍼센트)과 KST 시:분", async () => {
    const cpu = graphFigure(serverSection(await renderAtFixedNow(), "158"), "CPU");
    const ticks = [...cpu.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
    expect(ticks).toEqual(["0.0%", "50.0%", "100.0%", "20:00", "20:30", "21:00"]);   // NOW 12:00:00.250 UTC → KST 21:00
  });

  it("7일 · 30일은 월/일 눈금과 '한 점 = N분 평균'", async () => {
    fake.series.set(seriesKey("158", "host", null), { source: "rollup", stepMilliseconds: 5_190_000, points: [
      observePoint("host", NOW_MILLISECONDS - 10 * 24 * HOUR, { cpu_pct: [5, 9] }), observePoint("host", NOW_MILLISECONDS - 10 * 24 * HOUR + 5_190_000, { cpu_pct: [6, 8] }),
    ] });
    const cpu = graphFigure(serverSection(await renderAtFixedNow({ range: "30d" }), "158"), "CPU");
    expect(textOf(cpu)).toContain("한 점 = 86.5분 평균");
    const ticks = [...cpu.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]).slice(3);
    expect(ticks).toEqual(["10/25", "11/09", "11/24"]);
  });

  it("1시간 원본(30초)에는 '한 점' 글이 없다", async () => {
    expect(textOf(serverSection(await renderAtFixedNow(), "158"))).not.toContain("한 점 =");
  });

  it("점이 없는 계열 — '이 기간에 값이 없습니다', SVG 없음", async () => {
    const cpu = graphFigure(serverSection(await renderAtFixedNow(), "9"), "CPU");
    expect(textOf(cpu)).toContain("이 기간에 값이 없습니다");
    expect(cpu).not.toContain("<svg");
  });

  it("계열 조회가 실패하면 그 서버의 그래프만 '확인하지 못함 — <고정 글>', 현재 값과 다른 서버는 그대로", async () => {
    fake.series.set(seriesKey("164", "host", null), { response: () => textResponse(leakyErrorBody(), 503) });
    fake.series.set(seriesKey("164", "gpu", "0"), { response: () => textResponse(leakyErrorBody(), 504) });
    const html = await renderAtFixedNow({ open: "164" });
    const section = serverSection(html, "164");
    expect(textOf(graphFigure(section, "CPU"))).toContain("확인하지 못함 — 서버 일시 장애 · HTTP 503");
    expect(textOf(graphFigure(splitMore(section).folded!, "GPU 0"))).toContain("확인하지 못함 — 서버 조회 시간 초과 · HTTP 504");
    expect(readingText(section, "CPU")).toBe("3.4%");
    expect(graphFigure(serverSection(html, "158"), "CPU")).toContain("<svg");
    expectNoForbiddenText(html);
  });
});

describe("기간 고르기", () => {
  it("네 기간 링크 — 고른 것은 aria-current 와 글('고름'), 나머지 값은 보존", async () => {
    const html = await renderAtFixedNow({ range: "7d", refresh: "off", open: "158" });
    const nav = /<nav aria-label="기간">([\s\S]*?)<\/nav>/.exec(html)![1];
    const links = [...nav.matchAll(/<a[^>]*href="([^"]*)"([^>]*)>([^<]*)/g)].map((match) => [match[1].replace(/&amp;/g, "&"), /aria-current="page"/.test(match[0]), match[3]]);
    expect(links).toEqual([
      ["/resources?range=1h&refresh=off&open=158", false, "1시간"], ["/resources?range=24h&refresh=off&open=158", false, "24시간"],
      ["/resources?range=7d&refresh=off&open=158", true, "7일"], ["/resources?range=30d&refresh=off&open=158", false, "30일"],
    ]);
    expect(textOf(nav)).toContain("7일 (고름)");
  });
});

describe("자동 갱신 — 스크립트 없이 meta refresh", () => {
  it("기본은 켜짐 — 1시간은 30초, 끄기 링크", async () => {
    const html = await renderAtFixedNow();
    expect(html).toContain('<meta http-equiv="refresh" content="30"/>');
    expect(textOf(html)).toContain("30초마다 자동 갱신 중 · 끄기");
    expect(html).toContain('href="/resources?range=1h&amp;refresh=off"');
  });

  it("7일 · 30일은 5분", async () => {
    for (const range of ["7d", "30d"]) {
      const html = await renderAtFixedNow({ range });
      expect(html).toContain('<meta http-equiv="refresh" content="300"/>');
      expect(textOf(html)).toContain("5분마다 자동 갱신 중");
    }
  });

  it("refresh=off — meta 없음, '자동 갱신 꺼짐 · 켜기'", async () => {
    const html = await renderAtFixedNow({ refresh: "off", range: "24h" });
    expect(html).not.toContain("http-equiv");
    expect(textOf(html)).toContain("자동 갱신 꺼짐 · 켜기");
    expect(html).toContain('href="/resources?range=24h"');
  });

  it("펼친 그래프는 주소에서 — 펼치기 · 접기 링크가 끈 상태와 다른 서버의 펼침을 보존", async () => {
    const html = await renderAtFixedNow({ open: "164", refresh: "off" });
    expect(splitMore(serverSection(html, "164")).folded).not.toBeNull();
    expect(splitMore(serverSection(html, "158")).folded).toBeNull();
    expect(serverSection(html, "164")).toContain('href="/resources?range=1h&amp;refresh=off">접기</a>');
    expect(serverSection(html, "158")).toContain('href="/resources?range=1h&amp;refresh=off&amp;open=158%2C164">그래프 더 보기');
  });

  it("그래프가 더해져도 스크립트 · 표식 글자 없음", async () => {
    fake.series.set(seriesKey("158", "host", null), { points: hostPointsWithGap() });
    const html = await renderAtFixedNow({ open: "158,164" });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expectNoForbiddenText(html);
    expect(html).not.toContain("0123456789ab");
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});

// ── 3단계: 컨테이너 표 · 재시작 알림의 자리 · 고른 컨테이너의 그래프 ──

function containerServers(): Record<string, unknown>[] {
  return [
    observeLatestServer("158", { containers: [
      observeContainer({ name: "front-app-green", series_name: "front-app", cpu_pct: 250, mem_used: 119_000_000, restarts: 2, state: "running" }),
      observeContainer({ name: "front-app-blue", series_name: "front-app", cpu_pct: null, mem_used: null, restarts: null, state: null }),
      observeContainer({ name: "claude-bridge-relay", series_name: "claude-bridge-relay", cpu_pct: 0, restarts: 0, state: "exited" }),
    ] }),
    observeLatestServer("164", { gpus: [observeGpu()], containers: [observeContainer({ name: "llm-ollama", series_name: "llm-ollama", restarts: 7, state: "restarting" })] }),
    observeLatestServer("9", { containers: [], missing: ["containers"] }),
    observeSilentServer("spare"),
  ];
}

describe("컨테이너 표", () => {
  beforeEach(() => {
    fake.latest = () => observeLatestBody(containerServers(), []);
  });

  it("열 — 이름(계열 이름 링크 + 실제 이름) · 상태 · CPU · 메모리 · 재시작 수, 모델의 순서 그대로", async () => {
    const section = serverSection(await renderAtFixedNow(), "158");
    const headers = [...section.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((match) => match[1]);
    expect(headers).toEqual(["이름", "상태", "CPU(코어 하나 = 100%)", "메모리", "재시작 수"]);
    const names = [...section.matchAll(/<tr[^>]*><td[^>]*><a[^>]*>([^<]*)<\/a>/g)].map((match) => match[1]);
    expect(names).toEqual(["claude-bridge-relay", "front-app", "front-app"]);   // 계열 이름 다음 실제 이름의 글자 코드 순(모델)
    const rows = [...section.matchAll(/<tr[^>]*><td[^>]*><a[\s\S]*?<\/tr>/g)].map((match) => rowCells(match[0]));
    expect(rows).toEqual([
      ["claude-bridge-relay", "exited", "0.0%", "113.5 MiB", "0"],
      ["front-appfront-app-blue", "없음", "없음", "없음", "없음"],
      ["front-appfront-app-green", "running", "250.0%", "113.5 MiB", "2"],
    ]);
    expect(textOf(section)).toContain("컨테이너 3개");
  });

  it("값 없음의 글 — 컨테이너 없음 · 읽지 못함 · 확인하지 못함 · 일부만 표시", async () => {
    const unknownRow = observeLatestServer("164");
    delete unknownRow.containers;
    fake.latest = () => observeLatestBody([
      observeLatestServer("158", { containers: [] }), unknownRow,
      observeLatestServer("9", { containers: [], missing: ["containers"] }),
      observeLatestServer("77", { missing: ["containers_truncated"] }),
    ], []);
    const html = await renderAtFixedNow();
    expect(textOf(serverSection(html, "158"))).toContain("컨테이너 0개컨테이너 없음");
    expect(textOf(serverSection(html, "164"))).toContain("컨테이너확인하지 못함");
    expect(textOf(serverSection(html, "9"))).toContain("컨테이너읽지 못함");
    expect(textOf(serverSection(html, "77"))).toContain("컨테이너 1개 · 일부만 표시");
    expect(serverSection(html, "9")).not.toContain("<table");
  });

  it("재시작 반복은 그 줄에 표식 + 글 — '그 밖의 알림'에서 빠지고, 남는 것이 없으면 그 칸이 없다", async () => {
    fake.latest = () => observeLatestBody(containerServers(), [
      observeFiring({ server: "164", rule: "restarts", target: "llm-ollama", severity: "warning", last_value: 3 }),
    ]);
    const section = serverSection(await renderAtFixedNow(), "164");
    const row = containerRow(section, "llm-ollama");
    expect(rowCells(row)[4]).toContain("7 !경고컨테이너 재시작 반복 · llm-ollama");
    expect(row).toMatch(/<tr class="[^"]+">/);   // 줄 표시(테두리) — 글과 함께
    expect(section).not.toContain("그 밖의 알림");
  });

  it("알림의 대상 컨테이너가 표에 없으면(사라짐) '그 밖의 알림'에 남는다", async () => {
    fake.latest = () => observeLatestBody(containerServers(), [
      observeFiring({ server: "164", rule: "restarts", target: "llm-ollama-blue", severity: "warning" }),
    ]);
    const section = serverSection(await renderAtFixedNow(), "164");
    expect(textOf(othersBlock(section))).toContain("그 밖의 알림 1건");
    expect(textOf(othersBlock(section))).toContain("컨테이너 재시작 반복 · llm-ollama-blue");
    expect(textOf(containerRow(section, "llm-ollama"))).not.toContain("재시작 반복");
  });

  it("이름 링크는 고른 컨테이너를 더하고 기간 · 끈 상태 · 펼친 그래프를 보존", async () => {
    const section = serverSection(await renderAtFixedNow({ range: "24h", refresh: "off", open: "164" }), "158");
    expect(section).toContain('href="/resources?range=24h&amp;server=158&amp;container=front-app&amp;refresh=off&amp;open=164">front-app</a>');
  });
});

describe("고른 컨테이너의 그래프", () => {
  beforeEach(() => {
    fake.latest = () => observeLatestBody(containerServers(), []);
    fake.series.set(seriesKey("158", "container", "front-app"), { points: evenlySpacedPoints("container", RANGE_START + 30_000, 30_000, 4, (index) => ({
      cpu_pct: [100 + index * 10, 150 + index * 10], mem_used: [119_000_000, 121_000_000],
    })) });
  });

  it("그 서버 묶음의 표 바로 아래에 CPU · 메모리 그래프와 닫기 링크, 고른 줄은 aria-current 와 글", async () => {
    const html = await renderAtFixedNow({ server: "158", container: "front-app", open: "164" });
    const section = serverSection(html, "158");
    const tableEnd = section.indexOf("</table>");
    const selectedAt = section.indexOf("컨테이너 front-app(158) 그래프");
    expect(tableEnd).toBeGreaterThan(0);
    expect(selectedAt).toBeGreaterThan(tableEnd);
    const after = section.slice(tableEnd);
    graphFigure(after, "front-app CPU");
    graphFigure(after, "front-app 메모리");
    expect(after).toContain('href="/resources?range=1h&amp;open=164">닫기</a>');
    const selectedLinks = [...section.matchAll(/<a[^>]*aria-current="true"[^>]*>([^<]*)<\/a>/g)].map((match) => match[1]);
    expect(selectedLinks).toEqual(["front-app", "front-app"]);   // 두 자리(blue · green)가 같은 계열 — 둘 다 고른 줄
    expect(textOf(containerRow(section, "front-app"))).toContain("(보는 중)");
    expect(textOf(containerRow(section, "claude-bridge-relay"))).not.toContain("(보는 중)");
    expect(serverSection(html, "164")).not.toContain("컨테이너 front-app");
  });

  it("고른 컨테이너의 계열 조회가 실패하면 그 자리에 '확인하지 못함 — <고정 글>'", async () => {
    fake.series.set(seriesKey("158", "container", "front-app"), { response: () => textResponse(leakyErrorBody(), 503) });
    const html = await renderAtFixedNow({ server: "158", container: "front-app" });
    expect(textOf(serverSection(html, "158"))).toContain("확인하지 못함 — 서버 일시 장애 · HTTP 503");
    expectNoForbiddenText(html);
  });

  it("고른 서버가 화면에 없으면(서버 목록 실패) 묶음 밖에 따로 그래프", async () => {
    fake.latest = () => textResponse(leakyErrorBody(), 503);
    const html = await renderAtFixedNow({ server: "158", container: "front-app" });
    expect(textOf(html)).toContain("서버 값: 확인하지 못함");
    expect(textOf(html)).toContain("컨테이너 front-app(158) 그래프");
    expect(html).toContain(">front-app CPU</figcaption>");
  });

  it("자동 갱신 · 기간 링크가 고른 컨테이너를 보존(새로 고침 뒤에도 그대로)", async () => {
    const html = await renderAtFixedNow({ server: "158", container: "front-app" });
    expect(html).toContain('<meta http-equiv="refresh" content="30"/>');   // content 에 주소가 없다 — 지금 주소(고른 컨테이너 포함)를 다시 부른다
    expect(html).toContain('href="/resources?range=7d&amp;server=158&amp;container=front-app">7일</a>');
    expect(html).toContain('href="/resources?range=1h&amp;server=158&amp;container=front-app&amp;refresh=off">끄기</a>');
  });

  it("스크립트 · 표식 글자 없음", async () => {
    const html = await renderAtFixedNow({ server: "158", container: "front-app", open: "158,164" });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expectNoForbiddenText(html);
    expect(html).not.toContain("0123456789ab");
    expect(html).not.toContain("study-note-deploy-system-front");
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});

// ── 카드 배치(명세 §17 끝 줄): 지표마다 카드 하나 — 이름 → 수치 → 그래프 ──

describe("지표마다 카드 하나 — 수치와 그래프가 같은 카드 안", () => {
  beforeEach(() => {
    fake.series.set(seriesKey("158", "host", null), { points: hostPointsWithGap() });
  });

  it("CPU · 메모리 · 디스크 카드 — 카드 이름 → 수치 → 그래프(SVG 와 요약 글)", async () => {
    const section = serverSection(await renderAtFixedNow(), "158");
    for (const [title, value] of [["CPU", "3.4%"], ["메모리", "13.1%2.0 GiB / 14.9 GiB"], ["디스크", "16.1%75.0 GiB / 465.9 GiB"]] as const) {
      const card = metricCard(section, "158", title);
      expect(readingText(card, title)).toBe(value);
      const readingAt = card.indexOf("<dl");
      const graphAt = card.indexOf("<svg");
      expect(readingAt, `${title} 카드에 수치가 없다`).toBeGreaterThan(0);
      expect(graphAt, `${title} 카드에 그래프가 없다`).toBeGreaterThan(readingAt);   // 수치 다음 그래프
      expect(textOf(card)).toContain(`${title} 1시간:`);
    }
  });

  it("네트워크 · 디스크 입출력 — 수치 둘이 한 카드, 펼치면 그 카드 안에 선 넷짜리 그래프 하나", async () => {
    const closed = serverSection(await renderAtFixedNow(), "158");
    const network = metricCard(closed, "158", "네트워크");
    expect(readingText(network, "네트워크 받기")).toBe("1.2 KiB/s");
    expect(readingText(network, "네트워크 보내기")).toBe("3.3 KiB/s");
    expect(network).not.toContain("<svg");
    const diskIo = metricCard(closed, "158", "디스크 입출력");
    expect(readingText(diskIo, "디스크 읽기")).toBe("0 B/s");
    expect(readingText(diskIo, "디스크 쓰기")).toBe("50.8 KiB/s");
    expect(diskIo).not.toContain("<svg");

    const opened = serverSection(await renderAtFixedNow({ open: "158" }), "158");
    const openNetwork = metricCard(opened, "158", "네트워크");
    expect(openNetwork.match(/<svg[^>]*role="img"/g)).toHaveLength(1);
    expect(openNetwork.match(/<path class=/g)).toHaveLength(4);
    expect(readingText(openNetwork, "네트워크 받기")).toBe("1.2 KiB/s");
    expect(metricCard(opened, "158", "디스크 입출력").match(/<svg[^>]*role="img"/g)).toHaveLength(1);
  });

  it("GPU 카드 — 안 펼치면 수치만, 펼치면 그 카드 안에 사용률 · 메모리 그래프", async () => {
    expect(metricCard(serverSection(await renderAtFixedNow(), "164"), "164", "GPU 0")).not.toContain("<svg");
    const opened = metricCard(serverSection(await renderAtFixedNow({ open: "164" }), "164"), "164", "GPU 0");
    expect(readingText(opened, "사용률")).toBe("12.0%");
    graphFigure(opened, "GPU 0 사용률");
    graphFigure(opened, "GPU 0 메모리");
  });

  it("GPU 가 없으면 그 글로 카드 하나", async () => {
    expect(readingText(metricCard(serverSection(await renderAtFixedNow(), "158"), "158", "GPU"), "GPU")).toBe("GPU 없음");
  });

  it("임계값 알림은 그 지표의 카드에 — 글 + 표식, 카드 테두리(다른 카드는 아니다)", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), [observeFiring({ server: "158", rule: "disk_warning", severity: "warning", last_value: 86.2 })]);
    const section = serverSection(await renderAtFixedNow(), "158");
    const disk = metricCard(section, "158", "디스크");
    expect(textOf(disk)).toContain("!경고디스크 경고");
    const cardClass = (card: string) => /^<div class="([^"]*)"/.exec(card)?.[1] ?? "";
    expect(cardClass(disk).trim().split(/\s+/)).toHaveLength(2);   // 카드 + 울림 테두리
    expect(cardClass(metricCard(section, "158", "CPU")).trim().split(/\s+/)).toHaveLength(1);
    expect(textOf(metricCard(section, "158", "CPU"))).not.toContain("경고");
  });

  it("값 없음의 글 — 수신 없음이어도 그 기간에 점이 있으면(끊긴 지 얼마 안 됨) 카드를 그대로: 수치는 '없음', 그래프는 남은 점", async () => {
    fake.series.set(seriesKey("spare", "host", null), { points: [observePoint("host", RANGE_START + 5 * MINUTE, { cpu_pct: [40, 45] }), observePoint("host", RANGE_START + 5 * MINUTE + 30_000, { cpu_pct: [41, 44] })] });
    const section = serverSection(await renderAtFixedNow(), "spare");
    const cpu = metricCard(section, "spare", "CPU");
    expect(readingText(cpu, "CPU")).toBe("없음");
    expect(cpu).toContain("<svg");
    const memory = metricCard(section, "spare", "메모리");
    expect(readingText(memory, "메모리")).toBe("없음");
    expect(textOf(memory)).toContain("메모리 1시간: 평균 최근 없음 · 최댓값 없음");   // 점은 있지만 그 값이 없다(모델의 점 수는 점의 수)
    expect(readingText(metricCard(section, "spare", "네트워크"), "네트워크 받기")).toBe("없음");
  });

  it("수신 없음인데 서버 계열 조회가 실패하면(점 수를 알 수 없음) 카드를 그대로", async () => {
    fake.series.set(seriesKey("spare", "host", null), { response: () => textResponse(leakyErrorBody(), 503) });
    const section = serverSection(await renderAtFixedNow(), "spare");
    expect(textOf(metricCard(section, "spare", "CPU"))).toContain("확인하지 못함 — 서버 일시 장애 · HTTP 503");
  });

  it("한 줄로 줄인 서버에 컨테이너가 있으면 그 수만 · 지표 끊김 알림은 글 + 표식", async () => {
    fake.latest = () => observeLatestBody([...defaultServers().slice(0, 3), observeSilentServer("spare", { containers: [observeContainer(), observeContainer({ name: "front-app-blue" })] })],
      [observeFiring({ server: "spare", rule: "silent", severity: "warning", last_value: null })]);
    const section = serverSection(await renderAtFixedNow(), "spare");
    expect(textOf(section)).toContain("컨테이너 2개");
    expect(textOf(section)).toContain("!경고지표 끊김");
    expect(section).not.toContain("<table");
  });

  it("스크립트 · 표식 글자 없음", async () => {
    const html = await renderAtFixedNow({ open: "158,164" });
    expect(html).not.toMatch(/<script/i);
    expectNoForbiddenText(html);
    expect(html).not.toContain("0123456789ab");
  });
});
