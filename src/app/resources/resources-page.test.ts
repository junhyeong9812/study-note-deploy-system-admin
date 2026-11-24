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

  it("164 의 GPU — 사용률 · 메모리 · 온도", async () => {
    expect(readingText(serverSection(await render(), "164"), "GPU")).toBe("GPU 0사용률 12.0% · 메모리 0.1%9.0 MiB / 8.0 GiB · 온도 28°C");
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

  it("수신 없음 — 표식 + 글, 값은 전부 '없음'", async () => {
    const section = serverSection(await render(), "spare");
    expect(textOf(section)).toContain("✕수신 없음");
    for (const label of ["CPU", "메모리", "디스크", "네트워크 받기", "디스크 쓰기"]) expect(readingText(section, label)).toBe("없음");
    expect(section).not.toContain("측정");
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

  it("지표 끊김은 받은 때 옆에 · 재시작 반복과 모르는 규칙은 '그 밖의 알림'", async () => {
    fake.latest = () => observeLatestBody(defaultServers(), [
      observeFiring({ server: "spare", rule: "silent", severity: "warning", last_value: null }),
      observeFiring({ server: "164", rule: "restarts", target: "llm-ollama", severity: "warning", last_value: 3 }),
      observeFiring({ server: "164", rule: "brand_new_rule", severity: "info", last_value: null }),
    ]);
    const html = await render();
    expect(textOf(serverSection(html, "spare"))).toContain("!경고지표 끊김");
    const others = textOf(serverSection(html, "164"));
    expect(others).toContain("그 밖의 알림 2건");
    expect(others).toContain("!경고컨테이너 재시작 반복 · llm-ollama");
    expect(others).toContain("?infobrand_new_rule");
    expect(others).not.toContain("마지막 3");   // 재시작 횟수는 퍼센트로 보이지 않는다
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

/** 묶음 안의 <details> 앞(늘 보이는 부분)과 안 */
function splitDetails(section: string): { visible: string; folded: string; openAttribute: boolean } {
  const match = /<details([^>]*)>([\s\S]*?)<\/details>/.exec(section);
  expect(match, "그래프 더 보기가 없다").not.toBeNull();
  return { visible: section.slice(0, match!.index), folded: match![2], openAttribute: /\bopen=""/.test(match![1]) };
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

  it("늘 보이는 셋과 <details> 안의 네트워크 · 디스크 입출력 · GPU", async () => {
    const html = await renderAtFixedNow();
    const { visible, folded, openAttribute } = splitDetails(serverSection(html, "158"));
    for (const title of ["CPU", "메모리", "디스크"]) graphFigure(visible, title);
    expect(visible).not.toContain(">네트워크</figcaption>");
    graphFigure(folded, "네트워크");
    graphFigure(folded, "디스크 입출력");
    expect(textOf(folded)).toContain("GPU 그래프 — GPU 없음");
    expect(openAttribute).toBe(false);
    expect(textOf(serverSection(html, "158"))).toContain("그래프 더 보기 — 네트워크 · 디스크 입출력 · GPU");
    const gpuFolded = splitDetails(serverSection(html, "164")).folded;
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
    const html = await renderAtFixedNow();
    const section = serverSection(html, "164");
    expect(textOf(graphFigure(section, "CPU"))).toContain("확인하지 못함 — 서버 일시 장애 · HTTP 503");
    expect(textOf(graphFigure(splitDetails(section).folded, "GPU 0"))).toContain("확인하지 못함 — 서버 조회 시간 초과 · HTTP 504");
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

  it("펼친 그래프는 주소에서 — open 이면 <details open> 과 '펼쳐 두지 않기', 아니면 '새로 고쳐도 펼쳐 두기'", async () => {
    const html = await renderAtFixedNow({ open: "164", refresh: "off" });
    expect(splitDetails(serverSection(html, "164")).openAttribute).toBe(true);
    expect(splitDetails(serverSection(html, "158")).openAttribute).toBe(false);
    expect(serverSection(html, "164")).toContain('href="/resources?range=1h&amp;refresh=off">펼쳐 두지 않기');
    expect(serverSection(html, "158")).toContain('href="/resources?range=1h&amp;refresh=off&amp;open=158%2C164">새로 고쳐도 펼쳐 두기');
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
