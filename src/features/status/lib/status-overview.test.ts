/** 상태 한눈에 — 명세 ② 화면 "alert GET /monitors·GET /health, observe GET /health, backend GET /api/health/dependencies, master GET /health" ·
 * "한 곳이 죽어도 나머지는 보인다: 서버 하나가 응답하지 않으면(제한 시간 5초) 그 칸만 '닿지 않음'으로 표시하고 나머지는 그린다.
 * 다른 서버의 오류 본문을 그대로 화면에 뿌리지 않는다(상태 코드와 짧은 사유만)" · 세부 "상태 화면의 호출은 병렬, 각각 5초" · 읽기 전용 ·
 * 판정 11-22(7번) "감시 대상의 reason · 의존성의 detail 은 가린 형태(maskUpstreamReason)로 넘긴다". */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STATUS_CHECK_NAMES, collectStatusOverview, type StatusCheckName, type StatusOverview, type StatusOverviewOptions,
} from "@/features/status/lib/status-overview";
import type { FetchLike } from "@/features/auth/lib/types";
import { MASKED_ADDRESS } from "@/shared/lib/upstream-reason";
import type { UpstreamResult } from "@/shared/lib/upstream-result";
import {
  FAKE_ALERT_SECRET, FAKE_ALERT_URL, FAKE_BACKEND_URL, FAKE_DEPLOY_MASTER_URL, FAKE_OBSERVE_URL, SECRET_HEADER_NAMES,
  UPSTREAM_RAW_MARKER, createRoutedFetch, createTimerTimeoutSignal, expectFailure, expectNoForbiddenText, expectReadOnlyRequest,
  hangUntilAborted, headersOf, jsonBody, leakyErrorBody, leakyNetworkError, okValue, respondAfter, textResponse, track,
} from "@/shared/lib/upstream-test-fakes";

/** 주소 → 칸 이름. */
function cellOf(url: URL): StatusCheckName | "unknown" {
  const key = `${url.origin}${url.pathname}`;
  if (key === `${new URL(FAKE_ALERT_URL).origin}/monitors`) return "alertMonitors";
  if (key === `${new URL(FAKE_ALERT_URL).origin}/health`) return "alertHealth";
  if (key === `${new URL(FAKE_OBSERVE_URL).origin}/health`) return "observeHealth";
  if (key === `${new URL(FAKE_BACKEND_URL).origin}/api/health/dependencies`) return "backendDependencies";
  if (key === `${new URL(FAKE_DEPLOY_MASTER_URL).origin}/health`) return "deployMasterHealth";
  return "unknown";
}

/** 각 서버의 정상 응답(실제 계약 꼴 — 사유 글자에 주소 · IP · 포트 · 줄바꿈을 넣어 가려 넘기는지 본다). */
const HEALTHY_RESPONSES: Record<StatusCheckName, () => Response> = {
  alertMonitors: () => jsonBody({ success: true, data: {
    monitors: [
      { name: "front", status: "UP", down_since: "", reason: "" },
      { name: "backend-deps", status: "DOWN", down_since: "2026-11-22T09:00:00Z", reason: `정상이 아닌 구성 요소: embedding\n${FAKE_BACKEND_URL}/api/health/dependencies` },
      { name: "observe", status: "UNKNOWN", down_since: "", reason: `Connection refused ${FAKE_OBSERVE_URL} via 192.0.2.10:17000` },
    ],
    last_round_at: "2026-11-22T10:00:00Z", undelivered: 2,
  } }),
  alertHealth: () => jsonBody({ status: "ok", last_round_at: "2026-11-22T10:00:00Z", active: true }),
  observeHealth: () => jsonBody({ status: "ok", last_loop_at: "2026-11-22T10:00:00Z", failure: "", unacknowledged: 0, lag: 0, last_retention_failure: UPSTREAM_RAW_MARKER }),
  backendDependencies: () => jsonBody({ status: "DOWN", components: {
    elasticsearch: { status: "UP" },
    embedding: { status: "DOWN", detail: `Connection refused: ${FAKE_BACKEND_URL.replace("http", "HTTP")}/health` },
    redis: { status: "UP" },
  } }),
  deployMasterHealth: () => jsonBody({ success: true, data: { mode: "master" } }),
};

const EXPECTED_HEALTHY_VALUES: { [Name in StatusCheckName]: unknown } = {
  alertMonitors: {
    monitors: [
      { name: "front", status: "UP", downSince: null, reason: "" },
      { name: "backend-deps", status: "DOWN", downSince: "2026-11-22T09:00:00Z", reason: `정상이 아닌 구성 요소: embedding ${MASKED_ADDRESS}/api/health/dependencies` },
      { name: "observe", status: "UNKNOWN", downSince: null, reason: `Connection refused ${MASKED_ADDRESS} via ${MASKED_ADDRESS}` },
    ],
    lastRoundAt: "2026-11-22T10:00:00Z", undelivered: 2,
  },
  alertHealth: { status: "ok", healthy: true, failure: null },
  observeHealth: { status: "ok", healthy: true, failure: null, backlog: 0, lastLogAt: null },
  backendDependencies: { status: "DOWN", components: [
    { name: "elasticsearch", status: "UP", detail: null }, { name: "embedding", status: "DOWN", detail: `Connection refused: ${MASKED_ADDRESS}/health` },
    { name: "redis", status: "UP", detail: null },
  ] },
  deployMasterHealth: { status: "ok", healthy: true, failure: null },
};

type CellBehavior = (init: RequestInit) => Promise<Response> | Response;

function options(fetch: FetchLike, overrides: Partial<StatusOverviewOptions> = {}): StatusOverviewOptions {
  return {
    alertUrl: FAKE_ALERT_URL, alertSecret: FAKE_ALERT_SECRET, observeUrl: FAKE_OBSERVE_URL,
    backendUrl: FAKE_BACKEND_URL, deployMasterUrl: FAKE_DEPLOY_MASTER_URL, fetch, ...overrides,
  };
}

function routedFetch(overrides: Partial<Record<StatusCheckName, CellBehavior>> = {}) {
  return createRoutedFetch((url, init) => {
    const cell = cellOf(url);
    if (cell === "unknown") throw new Error(`unexpected url ${url.pathname}`);
    const behavior = overrides[cell];
    return behavior ? behavior(init) : HEALTHY_RESPONSES[cell]();
  });
}

function expectHealthyExcept(overview: StatusOverview, failedCells: StatusCheckName[]) {
  for (const name of STATUS_CHECK_NAMES) {
    if (failedCells.includes(name)) continue;
    expect(okValue(overview[name] as UpstreamResult<unknown>), name).toStrictEqual(EXPECTED_HEALTHY_VALUES[name]);
  }
}

describe("collectStatusOverview — 다섯 칸 정상", () => {
  it("각 칸은 상태 낱말 · 숫자 + 가린 사유 — reason · detail 의 주소 · IP · 포트는 (주소), 줄바꿈은 공백, 그 밖의 칸은 넘기지 않는다", async () => {
    const overview = await collectStatusOverview(options(routedFetch()));
    expect(Object.keys(overview).sort()).toEqual([...STATUS_CHECK_NAMES].sort());
    expectHealthyExcept(overview, []);
    expectNoForbiddenText(overview);
  });

  it("다섯 주소를 정확히 한 번씩, 전부 GET · 본문 없음 · redirect manual", async () => {
    const fetch = routedFetch();
    await collectStatusOverview(options(fetch));
    const cells = fetch.mock.calls.map(([input]) => cellOf(new URL(input)));
    expect(cells.sort()).toEqual([...STATUS_CHECK_NAMES].sort());
    for (const [, init] of fetch.mock.calls) {
      expectReadOnlyRequest(init);
      expect(init?.redirect).toBe("manual");
    }
  });

  it("X-Alert-Secret 은 alert /monitors 에만 — 헬스 호출에는 어떤 비밀 헤더도 싣지 않는다", async () => {
    const fetch = routedFetch();
    await collectStatusOverview(options(fetch));
    for (const [input, init] of fetch.mock.calls) {
      const cell = cellOf(new URL(input));
      const headers = headersOf(init);
      for (const name of SECRET_HEADER_NAMES) {
        if (cell === "alertMonitors" && name === "x-alert-secret") expect(headers.get(name)).toBe(FAKE_ALERT_SECRET);
        else expect(headers.get(name), `${cell} ${name}`).toBeNull();
      }
    }
  });

  it("주소 끝의 / 를 허용한다", async () => {
    const fetch = routedFetch();
    const overview = await collectStatusOverview(options(fetch, {
      alertUrl: `${FAKE_ALERT_URL}/`, observeUrl: `${FAKE_OBSERVE_URL}/`, backendUrl: `${FAKE_BACKEND_URL}/`, deployMasterUrl: `${FAKE_DEPLOY_MASTER_URL}/`,
    }));
    expectHealthyExcept(overview, []);
  });
});

describe("collectStatusOverview — 헬스의 503 은 실패가 아니라 상태 낱말", () => {
  it("observe 503 + {status:failing, failure:예외 종류 이름} → failing · healthy:false · failure 는 가린 값(주소가 아니면 그대로)", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: "failing", failure: "database SQLException", last_retention_failure: UPSTREAM_RAW_MARKER }, 503),
    })));
    expect(okValue(overview.observeHealth)).toStrictEqual({ status: "failing", healthy: false, failure: "database SQLException", backlog: null, lastLogAt: null });
    expectNoForbiddenText(overview);
  });

  it("observe failure 에 주소가 섞여도 가려서 넘긴다", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: "unreachable", failure: `redis RedisConnectionFailureException ${FAKE_OBSERVE_URL}\n198.51.100.20:6379` }, 503),
    })));
    expect(okValue(overview.observeHealth)).toStrictEqual({
      status: "unreachable", healthy: false, failure: `redis RedisConnectionFailureException ${MASKED_ADDRESS} ${MASKED_ADDRESS}`, backlog: null, lastLogAt: null,
    });
    expectNoForbiddenText(overview);
    expect(JSON.stringify(overview)).not.toContain("198.51.100.20");
  });

  it("감시 사유 · 의존성 detail 이 길면 120자로, 빈 사유는 빈 글자", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      alertMonitors: () => jsonBody({ success: true, data: { monitors: [{ name: "llm", status: "DOWN", down_since: "2026-11-22T09:00:00Z", reason: "가".repeat(500) }], last_round_at: "", undelivered: 0 } }),
      backendDependencies: () => jsonBody({ status: "DOWN", components: { embedding: { status: "DOWN", detail: "나".repeat(500) } } }),
    })));
    expect(okValue(overview.alertMonitors).monitors[0].reason).toBe("가".repeat(120));
    expect(okValue(overview.backendDependencies).components[0].detail).toBe("나".repeat(120));
  });

  it.each(["unreachable", "starting", "stalled"])("observe 503 %s → healthy:false", async (status) => {
    const overview = await collectStatusOverview(options(routedFetch({ observeHealth: () => jsonBody({ status }, 503) })));
    expect(okValue(overview.observeHealth)).toStrictEqual({ status, healthy: false, failure: null, backlog: null, lastLogAt: null });
  });

  it("alert 503 stalled → healthy:false · 200 standby · starting → healthy:false", async () => {
    let overview = await collectStatusOverview(options(routedFetch({ alertHealth: () => jsonBody({ status: "stalled", last_round_at: "", active: true }, 503) })));
    expect(okValue(overview.alertHealth)).toStrictEqual({ status: "stalled", healthy: false, failure: null });
    overview = await collectStatusOverview(options(routedFetch({ alertHealth: () => jsonBody({ status: "standby", last_round_at: "", active: false }) })));
    expect(okValue(overview.alertHealth)).toStrictEqual({ status: "standby", healthy: false, failure: null });
    overview = await collectStatusOverview(options(routedFetch({ alertHealth: () => jsonBody({ status: "starting", last_round_at: "", active: true }) })));
    expect(okValue(overview.alertHealth)).toStrictEqual({ status: "starting", healthy: false, failure: null });
  });

  it("503 인데 본문이 계약 꼴이 아니면 unavailable(503)", async () => {
    const overview = await collectStatusOverview(options(routedFetch({ observeHealth: () => textResponse(leakyErrorBody(), 503) })));
    expectFailure(overview.observeHealth, "unavailable", 503);
  });

  it("상태 낱말이 열거 밖이면 unparseable", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: UPSTREAM_RAW_MARKER }),
      alertHealth: () => jsonBody({ status: "OK" }),
    })));
    expectFailure(overview.observeHealth, "unparseable");
    expectFailure(overview.alertHealth, "unparseable");
    expectHealthyExcept(overview, ["observeHealth", "alertHealth"]);
  });

  it("master 의 200 이 봉투가 아니면 unparseable", async () => {
    const overview = await collectStatusOverview(options(routedFetch({ deployMasterHealth: () => jsonBody({ status: "ok" }) })));
    expectFailure(overview.deployMasterHealth, "unparseable");
  });
});

/** 관측 서버 헬스의 밀린 건수(lag)와 최근 로그 시각(last_stored_at) — observe collect/CollectorHealth.kt:57-71(상태 낱말과 무관하게 늘 본문에 있다),
 * README "헬스" 표: lag 는 읽지 못하면 -1 · last_stored_at 은 없거나 닿지 못하면 "". 두 칸은 판정에 쓰지 않는다. */
describe("collectStatusOverview — 관측 서버의 밀린 건수 · 최근 로그 시각", () => {
  const OBSERVE_LAST_STORED_AT = "2026-11-22T09:59:58.123Z";

  it("200 ok + lag · last_stored_at → backlog · lastLogAt 그대로(시각은 받은 글자 그대로), 나머지 칸은 정상", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: "ok", last_loop_at: "2026-11-22T10:00:00Z", last_stored_at: OBSERVE_LAST_STORED_AT, failure: "", unacknowledged: 3, lag: 9_000 }),
    })));
    expect(okValue(overview.observeHealth)).toStrictEqual({ status: "ok", healthy: true, failure: null, backlog: 9_000, lastLogAt: OBSERVE_LAST_STORED_AT });
    expectHealthyExcept(overview, ["observeHealth"]);
  });

  it("503 의 상태 낱말에서도 두 칸을 넘긴다(failing · lag 12)", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: "failing", failure: "database SQLException", last_stored_at: OBSERVE_LAST_STORED_AT, lag: 12 }, 503),
    })));
    expect(okValue(overview.observeHealth)).toStrictEqual({
      status: "failing", healthy: false, failure: "database SQLException", backlog: 12, lastLogAt: OBSERVE_LAST_STORED_AT,
    });
  });

  it.each(["starting", "stalled", "unreachable"])("503 %s 에서도 두 칸을 넘긴다", async (status) => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status, failure: "", last_stored_at: OBSERVE_LAST_STORED_AT, lag: 7 }, 503),
    })));
    expect(okValue(overview.observeHealth)).toMatchObject({ status, healthy: false, backlog: 7, lastLogAt: OBSERVE_LAST_STORED_AT });
  });

  it("lag 0 은 실제 값 0(null 이 아니다)", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: "ok", failure: "", last_stored_at: OBSERVE_LAST_STORED_AT, lag: 0 }),
    })));
    expect(okValue(overview.observeHealth).backlog).toBe(0);
  });

  it("관측 서버의 '모름' 표시(lag -1 · last_stored_at \"\") → 둘 다 null, 칸은 정상", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: "ok", failure: "", last_stored_at: "", lag: -1 }),
    })));
    expect(okValue(overview.observeHealth)).toStrictEqual({ status: "ok", healthy: true, failure: null, backlog: null, lastLogAt: null });
  });

  it("두 칸이 없으면(구버전 관측 서버 · {status} 만) → 둘 다 null, 칸은 정상", async () => {
    const overview = await collectStatusOverview(options(routedFetch({ observeHealth: () => jsonBody({ status: "ok" }) })));
    expect(okValue(overview.observeHealth)).toStrictEqual({ status: "ok", healthy: true, failure: null, backlog: null, lastLogAt: null });
  });

  const wrongBacklogs: [string, unknown][] = [
    ["-2", -2], ["소수 1.5", 1.5], ["글자 \"12\"", "12"], ["null", null], ["true", true], ["NaN 글자", "NaN"],
  ];
  it.each(wrongBacklogs)("lag 가 %s 이면 200 → unparseable(나머지 칸은 정상)", async (_label, lag) => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: "ok", failure: "", last_stored_at: OBSERVE_LAST_STORED_AT, lag }),
    })));
    expectFailure(overview.observeHealth, "unparseable");
    expectHealthyExcept(overview, ["observeHealth"]);
  });
  it.each(wrongBacklogs)("lag 가 %s 이면 503 → unavailable(503)", async (_label, lag) => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: "failing", failure: "database SQLException", last_stored_at: OBSERVE_LAST_STORED_AT, lag }, 503),
    })));
    expectFailure(overview.observeHealth, "unavailable", 503);
  });

  const wrongLastStoredAts: [string, unknown][] = [
    ["숫자", 1_763_805_598_123], ["시각 꼴이 아닌 글자", "어제쯤"], ["null", null], ["true", true], ["객체", { at: OBSERVE_LAST_STORED_AT }],
  ];
  it.each(wrongLastStoredAts)("last_stored_at 이 %s 이면 200 → unparseable(나머지 칸은 정상)", async (_label, lastStoredAt) => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: "ok", failure: "", last_stored_at: lastStoredAt, lag: 0 }),
    })));
    expectFailure(overview.observeHealth, "unparseable");
    expectHealthyExcept(overview, ["observeHealth"]);
  });
  it.each(wrongLastStoredAts)("last_stored_at 이 %s 이면 503 → unavailable(503)", async (_label, lastStoredAt) => {
    const overview = await collectStatusOverview(options(routedFetch({
      observeHealth: () => jsonBody({ status: "stalled", failure: "", last_stored_at: lastStoredAt, lag: 0 }, 503),
    })));
    expectFailure(overview.observeHealth, "unavailable", 503);
  });

  it("알림 서버 · 배포 서버 헬스 칸에는 두 칸이 생기지 않는다", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      alertHealth: () => jsonBody({ status: "ok", last_round_at: "2026-11-22T10:00:00Z", active: true, lag: 5, last_stored_at: OBSERVE_LAST_STORED_AT }),
    })));
    expect(okValue(overview.alertHealth)).toStrictEqual({ status: "ok", healthy: true, failure: null });
    expect(okValue(overview.deployMasterHealth)).toStrictEqual({ status: "ok", healthy: true, failure: null });
  });
});

describe("collectStatusOverview — 병렬 · 각각 5초(가짜 타이머)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("다섯 호출을 기다리지 않고 한꺼번에 시작한다", async () => {
    const fetch = createRoutedFetch((url, init) => {
      const cell = cellOf(url) as StatusCheckName;
      return respondAfter(4_000, HEALTHY_RESPONSES[cell], init);
    });
    const pending = track(collectStatusOverview(options(fetch)));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(pending.settled).toBe(false);
  });

  it("각 4초 걸리는 다섯 호출 → 전체 4초에 끝난다(직렬이면 20초)", async () => {
    const fetch = createRoutedFetch((url, init) => respondAfter(4_000, HEALTHY_RESPONSES[cellOf(url) as StatusCheckName], init));
    const pending = track(collectStatusOverview(options(fetch)));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pending.settled).toBe(true);
    expectHealthyExcept(pending.value!, []);
  });

  it("호출마다 5000ms 신호를 따로 만든다", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = routedFetch();
    await collectStatusOverview({ ...options(fetch), timeoutSignal: timeout.factory });
    expect(timeout.requestedMilliseconds).toEqual([5_000, 5_000, 5_000, 5_000, 5_000]);
    const signals = new Set(fetch.mock.calls.map(([, init]) => init?.signal));
    expect(signals.size).toBe(5);
  });

  it.each([...STATUS_CHECK_NAMES])("%s 가 멈추면 5초에 그 칸만 timeout, 나머지 넷은 정상 · 전체는 5초에 묶인다", async (stuckCell) => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((url, init) => {
      const cell = cellOf(url) as StatusCheckName;
      return cell === stuckCell ? hangUntilAborted(init) : respondAfter(1_000, HEALTHY_RESPONSES[cell], init);
    });
    const pending = track(collectStatusOverview({ ...options(fetch), timeoutSignal: timeout.factory }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toBe(true);
    expect(pending.error).toBeUndefined();
    expectFailure(pending.value![stuckCell], "timeout");
    expectHealthyExcept(pending.value!, [stuckCell]);
  });

  it("다섯이 전부 멈춰도 5초에 끝나고 다섯 칸 모두 timeout(거부하지 않는다)", async () => {
    const timeout = createTimerTimeoutSignal();
    const fetch = createRoutedFetch((_url, init) => hangUntilAborted(init));
    const pending = track(collectStatusOverview({ ...options(fetch), timeoutSignal: timeout.factory }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pending.settled).toBe(true);
    for (const name of STATUS_CHECK_NAMES) expectFailure(pending.value![name], "timeout");
  });
});

describe("collectStatusOverview — 한 칸의 오류는 그 칸만(나머지 넷은 정상, 원문 없음)", () => {
  const failures: [string, CellBehavior, string, number | undefined][] = [
    ["오류 본문(500, 비밀값 · 주소 · 표식 포함)", () => textResponse(leakyErrorBody(), 500), "bad_status", 500],
    ["깨진 JSON(200)", () => textResponse(`{"status": "ok", ${UPSTREAM_RAW_MARKER}`), "unparseable", undefined],
    ["HTML(200)", () => textResponse(`<html>${UPSTREAM_RAW_MARKER}</html>`, 200, "text/html"), "unparseable", undefined],
    ["계약과 다른 꼴(200, 배열)", () => jsonBody([UPSTREAM_RAW_MARKER]), "unparseable", undefined],
    ["연결 실패(예외 문구에 주소 · 비밀값)", () => Promise.reject(leakyNetworkError()), "unreachable", undefined],
    ["fetch 가 동기로 던짐", () => { throw leakyNetworkError(); }, "unreachable", undefined],
    ["리다이렉트(302)", () => new Response(null, { status: 302, headers: { Location: `${FAKE_ALERT_URL}/elsewhere` } }), "bad_status", 302],
    ["401", () => textResponse(leakyErrorBody(), 401), "unauthorized", 401],
  ];

  for (const cell of STATUS_CHECK_NAMES) {
    for (const [label, behavior, reason, status] of failures) {
      it(`${cell} · ${label} → ${reason}`, async () => {
        const overview = await collectStatusOverview(options(routedFetch({ [cell]: behavior })));
        expectFailure(overview[cell], reason, status);
        expectHealthyExcept(overview, [cell]);
        expectNoForbiddenText(overview);
      });
    }
  }

  it("alert /monitors 의 reason 이 글자가 아니면 unparseable", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      alertMonitors: () => jsonBody({ success: true, data: { monitors: [{ name: "x", status: "UP", down_since: "", reason: 3 }], last_round_at: "", undelivered: 0 } }),
    })));
    expectFailure(overview.alertMonitors, "unparseable");
  });

  it("alert /monitors 의 항목 꼴이 다르면(status 열거 밖) unparseable", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      alertMonitors: () => jsonBody({ success: true, data: { monitors: [{ name: "x", status: "SIDEWAYS", down_since: "", reason: "" }], last_round_at: "", undelivered: 0 } }),
    })));
    expectFailure(overview.alertMonitors, "unparseable");
  });

  it("backend components 의 status 가 열거 밖이면 unparseable", async () => {
    const overview = await collectStatusOverview(options(routedFetch({
      backendDependencies: () => jsonBody({ status: "UP", components: { redis: { status: "MAYBE" } } }),
    })));
    expectFailure(overview.backendDependencies, "unparseable");
  });
});

/** 판정 11-22(15번): 필수 설정이라 정상 구동에서는 닿지 않는다 — 실행 중 방어. */
describe("collectStatusOverview — 설정이 빈 칸만 '설정 없음'(호출하지 않는다)", () => {
  const cases: [string, Partial<StatusOverviewOptions>, StatusCheckName[]][] = [
    ["ALERT_URL 없음", { alertUrl: "" }, ["alertMonitors", "alertHealth"]],
    ["ALERT_SECRET 없음 — /monitors 만", { alertSecret: "" }, ["alertMonitors"]],
    ["OBSERVE_URL 없음", { observeUrl: "" }, ["observeHealth"]],
    ["BACKEND_URL 없음", { backendUrl: "" }, ["backendDependencies"]],
    ["DEPLOY_MASTER_URL 없음", { deployMasterUrl: "" }, ["deployMasterHealth"]],
    ["BACKEND_URL 이 주소가 아님", { backendUrl: "backend.example.test" }, ["backendDependencies"]],
    ["DEPLOY_MASTER_URL 이 http(s) 가 아님", { deployMasterUrl: "ftp://deploy-master.example.test" }, ["deployMasterHealth"]],
    ["전부 없음", { alertUrl: "", alertSecret: "", observeUrl: "", backendUrl: "", deployMasterUrl: "" }, [...STATUS_CHECK_NAMES]],
  ];

  it.each(cases)("%s", async (_label, overrides, notConfigured) => {
    const fetch = routedFetch();
    const overview = await collectStatusOverview(options(fetch, overrides));
    for (const name of notConfigured) expectFailure(overview[name], "not_configured");
    expectHealthyExcept(overview, notConfigured);
    const calledCells = fetch.mock.calls.map(([input]) => cellOf(new URL(input)));
    for (const name of notConfigured) expect(calledCells).not.toContain(name);
    expect(calledCells.length).toBe(STATUS_CHECK_NAMES.length - notConfigured.length);
  });
});
