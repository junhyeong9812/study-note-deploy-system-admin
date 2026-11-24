/** 서버 자원 화면의 주소 입력 — 명세 §2.6 "기간 선택(1시간 · 24시간 · 7일 · 30일)" · "서버별 컨테이너 표 — 누르면 그 컨테이너의 그래프" ·
 * §2.3 "조회는 상한을 둔다: 기간 최대 31일". 틀린 값은 거절하지 않고 기본값(화면은 언제나 뜬다). */
import { describe, expect, it } from "vitest";
import {
  RESOURCES_PATH, RESOURCE_DEFAULT_RANGE, RESOURCE_RANGES, RESOURCE_RANGE_LABELS, RESOURCE_RANGE_MILLISECONDS,
  parseResourcesQuery, resourcesHref, resourcesWindow, type ResourcesQuery,
} from "@/features/resources/lib/resources-query";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OBSERVE_MAXIMUM_RANGE = 31 * DAY;   // observe MetricController.kt:206

describe("기간 목록", () => {
  it("네 기간 — 1시간 · 24시간 · 7일 · 30일, 기본 1시간(관측 서버의 기본과 같다)", () => {
    expect([...RESOURCE_RANGES]).toEqual(["1h", "24h", "7d", "30d"]);
    expect(RESOURCE_DEFAULT_RANGE).toBe("1h");
    expect(RESOURCE_RANGE_MILLISECONDS).toEqual({ "1h": HOUR, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY });
    expect(RESOURCE_RANGE_LABELS).toEqual({ "1h": "1시간", "24h": "24시간", "7d": "7일", "30d": "30일" });
  });

  it("가장 긴 기간도 관측 서버의 상한(31일) 안", () => {
    for (const range of RESOURCE_RANGES) expect(RESOURCE_RANGE_MILLISECONDS[range]).toBeLessThanOrEqual(OBSERVE_MAXIMUM_RANGE);
  });
});

describe("parseResourcesQuery — range", () => {
  it.each(RESOURCE_RANGES.map((range) => [range]))("%s 는 그대로", (range) => {
    expect(parseResourcesQuery({ range })).toEqual({ range, container: null });
  });

  it.each([
    ["없음", {}],
    ["빈 값", { range: "" }],
    ["목록 밖", { range: "2h" }],
    ["대문자", { range: "24H" }],
    ["앞뒤 공백", { range: " 7d" }],
    ["숫자만", { range: "3600000" }],
    ["배열(같은 이름 여러 번)", { range: ["7d", "30d"] }],
  ] as [string, SearchParamsInput][])("%s → 기본값 1h(거절하지 않는다)", (_label, input) => {
    expect(parseResourcesQuery(input)).toEqual({ range: "1h", container: null });
  });

  it("모르는 이름은 보지 않는다", () => {
    expect(parseResourcesQuery({ range: "7d", q: "x", limit: "9" })).toEqual({ range: "7d", container: null });
  });
});

describe("parseResourcesQuery — 고른 컨테이너(server + container)", () => {
  it("둘 다 꼴이 맞으면 고른 컨테이너", () => {
    expect(parseResourcesQuery({ range: "24h", server: "158", container: "front-app" }))
      .toEqual({ range: "24h", container: { server: "158", container: "front-app" } });
  });

  it("자리 이름이 붙은 이름도 꼴은 맞다(관측 서버가 답을 정한다)", () => {
    expect(parseResourcesQuery({ server: "home-9", container: "llm_ollama.1" }).container).toEqual({ server: "home-9", container: "llm_ollama.1" });
  });

  it.each([
    ["server 만", { server: "158" }],
    ["container 만", { container: "front-app" }],
    ["server 대문자", { server: "Home", container: "front-app" }],
    ["server 가 - 로 시작", { server: "-158", container: "front-app" }],
    ["server 64자", { server: "a".repeat(64), container: "front-app" }],
    ["container 가 . 로 시작", { server: "158", container: ".front" }],
    ["container 에 / ", { server: "158", container: "front/app" }],
    ["container 129자", { server: "158", container: "a".repeat(129) }],
    ["server 배열", { server: ["158", "164"], container: "front-app" }],
    ["container 배열", { server: "158", container: ["front-app", "llm"] }],
    ["빈 container", { server: "158", container: "" }],
  ] as [string, SearchParamsInput][])("%s → 고른 컨테이너 없음(반쪽만 쓰지 않는다), range 는 그대로", (_label, input) => {
    expect(parseResourcesQuery({ range: "7d", ...input })).toEqual({ range: "7d", container: null });
  });

  it("경계 — server 63자 · container 128자는 받는다", () => {
    const query = parseResourcesQuery({ server: "a".repeat(63), container: "b".repeat(128) });
    expect(query.container).toEqual({ server: "a".repeat(63), container: "b".repeat(128) });
  });
});

describe("resourcesWindow — from/to 계산", () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0, 250);

  it.each(RESOURCE_RANGES.map((range) => [range]))("%s — to = now, from = now − 기간, 글자는 toISOString", (range) => {
    const window = resourcesWindow(range, now);
    expect(window).toEqual({
      range, label: RESOURCE_RANGE_LABELS[range],
      fromMilliseconds: now - RESOURCE_RANGE_MILLISECONDS[range], toMilliseconds: now,
      from: new Date(now - RESOURCE_RANGE_MILLISECONDS[range]).toISOString(), to: new Date(now).toISOString(),
    });
  });

  it("글자는 밀리초 3자리와 Z", () => {
    expect(resourcesWindow("1h", Date.UTC(2026, 10, 24, 12, 0, 0, 0))).toMatchObject({ from: "2026-11-24T11:00:00.000Z", to: "2026-11-24T12:00:00.000Z" });
  });
});

describe("resourcesHref — 주소 글자와 왕복", () => {
  it("기간만", () => {
    expect(resourcesHref({ range: "24h", container: null })).toBe(`${RESOURCES_PATH}?range=24h`);
  });

  it("기본 기간도 싣는다", () => {
    expect(resourcesHref({ range: "1h", container: null })).toBe("/resources?range=1h");
  });

  it("고른 컨테이너 — range · server · container 순서", () => {
    expect(resourcesHref({ range: "7d", container: { server: "158", container: "front-app" } })).toBe("/resources?range=7d&server=158&container=front-app");
  });

  const queries: ResourcesQuery[] = [
    { range: "1h", container: null },
    { range: "30d", container: { server: "164", container: "llm-ollama" } },
    { range: "24h", container: { server: "a.b_c-9", container: "X_y.z-1" } },
  ];

  it.each(queries.map((query) => [JSON.stringify(query), query]))("parse(href(q)) = q — %s", (_label, query) => {
    const url = new URL(resourcesHref(query), "https://admin.example.test");
    expect(url.pathname).toBe(RESOURCES_PATH);
    expect(parseResourcesQuery(searchParamsInputFromUrl(url))).toEqual(query);
  });
});
