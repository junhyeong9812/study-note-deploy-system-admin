/** 서버 자원 화면의 화면 상태(자동 갱신 · 펼친 그래프) — 명세 §17 "끈 상태 · 고른 기간 · 펼친 그래프는 주소에 실려 새로 고침 뒤에도 그대로".
 * 틀린 값은 거절하지 않고 기본값. 링크는 기간 · 고른 컨테이너 · 끈 상태 · 펼친 그래프를 함께 보존한다. */
import { describe, expect, it } from "vitest";
import {
  RESOURCE_AUTO_REFRESH_SECONDS, RESOURCE_DEFAULT_VIEW_STATE, RESOURCE_OPEN_SERVER_LIMIT, parseResourcesQuery, parseResourcesViewState, resourcesHref,
  resourcesScreenHref, withServerOpen, type ResourcesQuery, type ResourcesViewState,
} from "@/features/resources/lib/resources-query";
import { searchParamsInputFromUrl } from "@/shared/lib/query-input";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

describe("parseResourcesViewState", () => {
  it("없으면 기본 — 자동 갱신 켜짐 · 펼친 것 없음", () => {
    expect(parseResourcesViewState({})).toEqual({ autoRefresh: true, openServers: [] });
    expect(RESOURCE_DEFAULT_VIEW_STATE).toEqual({ autoRefresh: true, openServers: [] });
  });

  it("refresh=off 만 끈다", () => {
    expect(parseResourcesViewState({ refresh: "off" }).autoRefresh).toBe(false);
  });

  it.each([["on"], ["OFF"], [" off"], ["0"], [""]])("refresh=%j → 켜짐(틀린 값은 기본)", (value) => {
    expect(parseResourcesViewState({ refresh: value }).autoRefresh).toBe(true);
  });

  it("refresh 배열 → 켜짐", () => {
    expect(parseResourcesViewState({ refresh: ["off", "off"] }).autoRefresh).toBe(true);
  });

  it("open — 쉼표로 나눈 서버 이름, 겹침 없이 글자 코드 순", () => {
    expect(parseResourcesViewState({ open: "164,158,164,9" }).openServers).toEqual(["158", "164", "9"]);
  });

  it.each([
    ["꼴이 틀린 이름 하나", "158,Bad"], ["빈 조각", "158,,164"], ["끝의 쉼표", "158,"], ["빈 값", ""], ["공백", "158, 164"],
  ])("open %s → 펼친 것 없음(반쪽만 쓰지 않는다)", (_label, value) => {
    expect(parseResourcesViewState({ open: value }).openServers).toEqual([]);
  });

  it("open 배열 → 펼친 것 없음", () => {
    expect(parseResourcesViewState({ open: ["158", "164"] }).openServers).toEqual([]);
  });

  it(`open 이 ${RESOURCE_OPEN_SERVER_LIMIT}대를 넘으면 펼친 것 없음 · 경계는 받는다`, () => {
    const names = Array.from({ length: RESOURCE_OPEN_SERVER_LIMIT + 1 }, (_, index) => `s${String(index).padStart(2, "0")}`);
    expect(parseResourcesViewState({ open: names.join(",") }).openServers).toEqual([]);
    expect(parseResourcesViewState({ open: names.slice(0, RESOURCE_OPEN_SERVER_LIMIT).join(",") }).openServers).toHaveLength(RESOURCE_OPEN_SERVER_LIMIT);
  });

  it("조회 입력과 섞이지 않는다 — 화면 상태 이름은 parseResourcesQuery 가 보지 않는다", () => {
    expect(parseResourcesQuery({ range: "7d", refresh: "off", open: "158" })).toEqual({ range: "7d", container: null });
  });
});

describe("자동 갱신 간격", () => {
  it("1시간 · 24시간 30초 · 7일 · 30일 5분", () => {
    expect(RESOURCE_AUTO_REFRESH_SECONDS).toEqual({ "1h": 30, "24h": 30, "7d": 300, "30d": 300 });
  });
});

describe("resourcesScreenHref — 세 값(기간 · 끈 상태 · 펼친 그래프)과 고른 컨테이너를 보존", () => {
  it("기본 상태면 resourcesHref 와 같다", () => {
    const query: ResourcesQuery = { range: "24h", container: null };
    expect(resourcesScreenHref(query, RESOURCE_DEFAULT_VIEW_STATE)).toBe(resourcesHref(query));
  });

  it("순서 — range · server · container · refresh · open", () => {
    expect(resourcesScreenHref({ range: "7d", container: { server: "158", container: "front-app" } }, { autoRefresh: false, openServers: ["164", "158"] }))
      .toBe("/resources?range=7d&server=158&container=front-app&refresh=off&open=158%2C164");
  });

  const cases: [ResourcesQuery, ResourcesViewState][] = [
    [{ range: "1h", container: null }, { autoRefresh: true, openServers: [] }],
    [{ range: "30d", container: null }, { autoRefresh: false, openServers: [] }],
    [{ range: "24h", container: { server: "164", container: "llm-ollama" } }, { autoRefresh: true, openServers: ["9", "a.b_c-1"] }],
    [{ range: "7d", container: null }, { autoRefresh: false, openServers: ["158"] }],
  ];

  it.each(cases.map((pair) => [JSON.stringify(pair), ...pair] as const))("왕복 — %s", (_label, query, view) => {
    const url = new URL(resourcesScreenHref(query, view), "https://admin.example.test");
    const input: SearchParamsInput = searchParamsInputFromUrl(url);
    expect(parseResourcesQuery(input)).toEqual(query);
    expect(parseResourcesViewState(input)).toEqual(view);
  });

  it("기간만 바꾼 링크도 끈 상태 · 펼친 그래프를 그대로 싣는다", () => {
    const view: ResourcesViewState = { autoRefresh: false, openServers: ["164"] };
    const url = new URL(resourcesScreenHref({ range: "30d", container: null }, view), "https://admin.example.test");
    expect(parseResourcesViewState(searchParamsInputFromUrl(url))).toEqual(view);
    expect(parseResourcesQuery(searchParamsInputFromUrl(url)).range).toBe("30d");
  });
});

describe("withServerOpen", () => {
  it("펼치기 · 접기 — 다른 서버의 펼침과 끈 상태는 그대로", () => {
    const view: ResourcesViewState = { autoRefresh: false, openServers: ["9"] };
    expect(withServerOpen(view, "158", true)).toEqual({ autoRefresh: false, openServers: ["158", "9"] });
    expect(withServerOpen({ autoRefresh: false, openServers: ["158", "9"] }, "158", false)).toEqual({ autoRefresh: false, openServers: ["9"] });
    expect(withServerOpen(view, "9", true)).toEqual(view);
  });
});
