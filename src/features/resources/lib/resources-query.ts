/** 서버 자원 화면의 주소 입력(순수) — 명세 §2.6 "기간 선택(1시간 · 24시간 · 7일 · 30일)" · "서버별 컨테이너 표 — 누르면 그 컨테이너의 그래프".
 * 이 화면은 입력이 틀려도 거절하지 않는다 — 틀린 값은 기본값으로 바꿔 화면을 띄운다(다른 화면의 invalid_input 과 다르다).
 *
 * 입력 이름(그 밖의 이름은 보지 않는다):
 * - `range`: RESOURCE_RANGES 의 글자 하나. 없음 · 빈 값 · 배열(같은 이름 여러 번) · 목록 밖(대소문자 다름 · 앞뒤 공백 포함) → RESOURCE_DEFAULT_RANGE.
 * - `server` + `container`: 둘 다 하나씩 있고 각각 RESOURCE_SERVER_NAME_PATTERN · RESOURCE_CONTAINER_NAME_PATTERN 에 맞을 때만 고른 컨테이너.
 *   하나라도 빠지거나 배열이거나 꼴이 다르면 고른 컨테이너 없음(null) — 반쪽만 쓰지 않는다.
 *
 * 기간 계산: to = now(받은 밀리초 그대로), from = to − 기간. 글자는 `new Date(ms).toISOString()`(밀리초 3자리, Z).
 * 30일은 관측 서버의 상한(31일 — observe MetricController.kt:206 MAX_RANGE)보다 짧다. */
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const RESOURCES_PATH = "/resources";

export const RESOURCE_RANGES = ["1h", "24h", "7d", "30d"] as const;
export type ResourceRange = (typeof RESOURCE_RANGES)[number];

export const RESOURCE_DEFAULT_RANGE: ResourceRange = "1h";

export const RESOURCE_RANGE_MILLISECONDS: Readonly<Record<ResourceRange, number>> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export const RESOURCE_RANGE_LABELS: Readonly<Record<ResourceRange, string>> = {
  "1h": "1시간", "24h": "24시간", "7d": "7일", "30d": "30일",
};

/** 관측 서버의 서버 이름 꼴(observe MetricEntry.kt:140 SERVER_NAME). */
export const RESOURCE_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** 관측 서버 `GET /metrics/series` 의 container name 꼴(observe MetricController.kt:213 CONTAINER_NAME) — 자리 이름을 뗀 이름. */
export const RESOURCE_CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface ContainerSelection {
  server: string;
  /** 자리 이름을 뗀 계열 이름(`front-app`) */
  container: string;
}

export interface ResourcesQuery {
  range: ResourceRange;
  container: ContainerSelection | null;
}

export interface ResourcesWindow {
  range: ResourceRange;
  label: string;
  fromMilliseconds: number;
  toMilliseconds: number;
  /** ISO 글자(밀리초 3자리, Z) */
  from: string;
  to: string;
}

function isResourceRange(value: string): value is ResourceRange {
  return (RESOURCE_RANGES as readonly string[]).includes(value);
}

/** 하나뿐인 값 — 없음 · 배열(같은 이름 여러 번)이면 null. (query-input 의 singleValue 는 배열을 "many" 글자로 돌려줘 서버 이름 "many" 와 섞이므로 쓰지 않는다.) */
function onlyValue(input: SearchParamsInput, name: string): string | null {
  const value = input[name];
  return typeof value === "string" ? value : null;
}

export function parseResourcesQuery(input: SearchParamsInput): ResourcesQuery {
  const range = onlyValue(input, "range");
  const server = onlyValue(input, "server");
  const container = onlyValue(input, "container");
  const selected = server !== null && RESOURCE_SERVER_NAME_PATTERN.test(server) && container !== null && RESOURCE_CONTAINER_NAME_PATTERN.test(container)
    ? { server, container } : null;
  return { range: range !== null && isResourceRange(range) ? range : RESOURCE_DEFAULT_RANGE, container: selected };
}

export function resourcesWindow(range: ResourceRange, nowMilliseconds: number): ResourcesWindow {
  const fromMilliseconds = nowMilliseconds - RESOURCE_RANGE_MILLISECONDS[range];
  return {
    range, label: RESOURCE_RANGE_LABELS[range], fromMilliseconds, toMilliseconds: nowMilliseconds,
    from: new Date(fromMilliseconds).toISOString(), to: new Date(nowMilliseconds).toISOString(),
  };
}

/** 화면 주소 — `/resources?range=<기간>[&server=<서버>&container=<이름>]`(이 순서, 기간은 언제나 싣는다).
 * parseResourcesQuery(이 주소의 인자) 는 받은 query 와 같다. */
export function resourcesHref(query: ResourcesQuery): string {
  const search = new URLSearchParams({ range: query.range });
  if (query.container !== null) {
    search.append("server", query.container.server);
    search.append("container", query.container.container);
  }
  return `${RESOURCES_PATH}?${search.toString()}`;
}
