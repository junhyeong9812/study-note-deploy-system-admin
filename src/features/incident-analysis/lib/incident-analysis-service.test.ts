/** 분석의 시작 · 진행 중 · 저장(명세 ⑫ §19 — 비동기 · Redis). 가짜 Redis(analysis-test-fakes — ioredis 의 명령 꼴 · 명령마다 양보)와 주입한 실행 자리로.
 * 계약:
 * - 키(incidentAnalysisKeys): `incident-analysis:v1:<base64url(문제 식별자)>:lock` · `…:history` · `…:attempt:<요청 ID>` — 식별자의 `:` 가 키의 마디와 섞이지 않는다.
 * - start: 잠금을 SET NX PX 5분(값 = 요청 ID)으로 잡는다(원자적 — 두 탭 · 두 자리(blue/green)에서도 한 번) → 시도 기록(running · 보낸 글 그대로 · 30일)을 남기고
 *   history 목록의 앞에 요청 ID(최근 5건만 — 밀려난 시도의 키는 지운다 · 목록도 30일) → 곧바로 started. 실행 자리는 뒤에서 부른다.
 *   잠금이 있으면 부르지 않고 already_running(그 요청 ID). Redis 에 닿지 못하면 부르지 않고 store_unavailable.
 * - 끝나면 시도 기록을 succeeded(다섯 칸) · failed(까닭)로 바꾸고 걸린 시간(이 서비스의 시계)을 적고 잠금을 푼다(자기 것일 때만).
 *   기록을 쓰지 못하면(부른 뒤 Redis 가 죽음) 로그 `incident-analysis:result_not_stored …` — 기록은 running 으로 남아 5분 뒤 interrupted 로 보인다.
 * - history: 최근 것부터 · running 이 5분을 넘으면 interrupted(그 뒤엔 다시 시작할 수 있다) · 읽을 수 없는 기록은 unreadable(다른 것은 보인다) ·
 *   보낼 때의 since 가 지금 열린 문제의 since 와 다르면 fromEarlierOpening. Redis 에 닿지 못하면 { ok: false }.
 * - 로그: 한 번에 한 줄 `incident-analysis:<결과> key=value…`(요청 ID 는 로그의 요청 ID 자리) — 보낸 글 · 답의 내용은 싣지 않는다. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_HISTORY_LIMIT, ANALYSIS_RETENTION_MILLISECONDS, ANALYSIS_RUNNING_LIMIT_MILLISECONDS, ANALYSIS_USED_PREVIEW_MILLISECONDS, createIncidentAnalysisService,
  incidentAnalysisKeys, usedPreviewKey,
  type AnalysisStartRequest, type IncidentAnalysisService, type StoredAnalysisAttempt,
} from "@/features/incident-analysis/lib/incident-analysis-service";
import type { AnalysisRunResult } from "@/features/incident-analysis/lib/analysis-runner-client";
import { FakeRedis, createFakeRedisState, everythingStored, type FakeRedisState } from "@/features/incident-analysis/lib/analysis-test-fakes";

const START = Date.UTC(2026, 10, 27, 6, 0, 0);
const PROMPT_MARK = "보낸-글-표식-P7";
const ANSWER_MARK = "답-내용-표식-A9";
const ANSWER = { cause: `원인 ${ANSWER_MARK}`, evidence: ["근거 하나"], confidence: "high", remedy: "되돌린다", recommendedAction: "rollback" } as const;

interface Harness {
  service: IncidentAnalysisService;
  state: FakeRedisState;
  calls: { prompt: string; requestId: string }[];
  logs: { requestId: string; message: string; level: string }[];
  clock: { now: number };
  /** 실행 자리의 답을 풀어 준다(부른 차례대로) */
  answer: (result: AnalysisRunResult) => void;
}

function harness(options: { state?: FakeRedisState; clock?: { now: number }; idPrefix?: string } = {}): Harness {
  const clock = options.clock ?? { now: START };
  const state = options.state ?? createFakeRedisState(() => clock.now);
  const calls: Harness["calls"] = [];
  const logs: Harness["logs"] = [];
  const waiting: ((result: AnalysisRunResult) => void)[] = [];
  let sequence = 0;
  const service = createIncidentAnalysisService({
    redis: new FakeRedis(state),
    runAnalysis: (prompt, requestId) => {
      calls.push({ prompt, requestId });
      return new Promise((resolve) => waiting.push(resolve));
    },
    clock: () => clock.now,
    newRequestId: () => `${options.idPrefix ?? "adm-a"}-${++sequence}`,
    log: (requestId, message, level) => { logs.push({ requestId, message, level }); },
  });
  return { service, state, calls, logs, clock, answer: (result) => waiting.shift()!(result) };
}

function request(overrides: Partial<AnalysisStartRequest> = {}): AnalysisStartRequest {
  return { incidentId: "monitor:front", incidentSince: "2026-11-25T05:40:00.000Z", prompt: `자료 ${PROMPT_MARK}`, account: "admin:jun", ...overrides };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function storedAttempt(state: FakeRedisState, incidentId: string, requestId: string): StoredAnalysisAttempt {
  const raw = state.strings.get(incidentAnalysisKeys(incidentId).attempt(requestId))?.value;
  expect(raw, "시도 기록이 없다").toBeDefined();
  return JSON.parse(raw!) as StoredAnalysisAttempt;
}

describe("키 — 식별자를 base64url 로", () => {
  it("잠금 · 목록 · 시도의 키", () => {
    const encoded = Buffer.from("resource:s:restarts:front-app-green", "utf8").toString("base64url");
    const keys = incidentAnalysisKeys("resource:s:restarts:front-app-green");
    expect(keys.lock).toBe(`incident-analysis:v1:${encoded}:lock`);
    expect(keys.history).toBe(`incident-analysis:v1:${encoded}:history`);
    expect(keys.attempt("adm-1")).toBe(`incident-analysis:v1:${encoded}:attempt:adm-1`);
  });

  it("식별자 안의 `:lock` · `:history` 가 다른 문제의 키가 되지 않는다", async () => {
    const { service, calls } = harness();
    expect((await service.start(request({ incidentId: "resource:s:cpu" }))).kind).toBe("started");
    expect((await service.start(request({ incidentId: "resource:s:cpu:lock" }))).kind).toBe("started");
    expect((await service.start(request({ incidentId: "resource:s:cpu:history" }))).kind).toBe("started");
    expect(calls).toHaveLength(3);
  });
});

describe("시작 — 곧바로 진행 중, 실행 자리는 뒤에서", () => {
  it("잠금(5분 · 값 = 요청 ID) · 시도 기록(running · 보낸 글 그대로) · 목록 — 실행 자리가 답하기 전에 started", async () => {
    const { service, state, calls } = harness();
    const result = await service.start(request());
    expect(result).toEqual({ kind: "started", requestId: "adm-a-1" });
    await settle();
    expect(calls).toEqual([{ prompt: `자료 ${PROMPT_MARK}`, requestId: "adm-a-1" }]);
    const keys = incidentAnalysisKeys("monitor:front");
    expect(state.strings.get(keys.lock)).toEqual({ value: "adm-a-1", expiresAt: START + ANALYSIS_RUNNING_LIMIT_MILLISECONDS });
    expect(state.lists.get(keys.history)?.items).toEqual(["adm-a-1"]);
    expect(storedAttempt(state, "monitor:front", "adm-a-1")).toEqual({
      version: 1, requestId: "adm-a-1", incidentId: "monitor:front", incidentSince: "2026-11-25T05:40:00.000Z", account: "admin:jun",
      startedAt: new Date(START).toISOString(), prompt: `자료 ${PROMPT_MARK}`, promptBytes: new TextEncoder().encode(`자료 ${PROMPT_MARK}`).length,
      state: "running", finishedAt: null, durationMilliseconds: null, answer: null, failureReason: null,
    });
    expect(service.runningCount()).toBe(1);
  });

  it("끝나면 succeeded — 다섯 칸 · 끝난 시각 · 걸린 시간 · 잠금을 푼다", async () => {
    const { service, state, answer, clock } = harness();
    await service.start(request());
    await settle();
    clock.now = START + 41_000;
    answer({ kind: "answered", answer: { ...ANSWER, evidence: [...ANSWER.evidence] } });
    await service.whenIdle();
    const attempt = storedAttempt(state, "monitor:front", "adm-a-1");
    expect(attempt).toMatchObject({ state: "succeeded", finishedAt: new Date(START + 41_000).toISOString(), durationMilliseconds: 41_000, failureReason: null });
    expect(attempt.answer).toEqual(ANSWER);
    expect(state.strings.has(incidentAnalysisKeys("monitor:front").lock)).toBe(false);
    expect(service.runningCount()).toBe(0);
  });

  it("실패면 failed — 까닭 · 잠금을 푼다(다시 요청할 수 있다)", async () => {
    const { service, state, answer, calls } = harness();
    await service.start(request());
    await settle();
    answer({ kind: "failed", reason: "busy" });
    await service.whenIdle();
    expect(storedAttempt(state, "monitor:front", "adm-a-1")).toMatchObject({ state: "failed", failureReason: "busy", answer: null });
    expect((await service.start(request())).kind).toBe("started");
    await settle();
    expect(calls).toHaveLength(2);
  });
});

describe("같은 문제에 진행 중이면 새로 부르지 않는다", () => {
  it("두 번 누름 · 두 탭 — 한 번만 부르고 둘째는 already_running(그 요청 ID)", async () => {
    const { service, calls } = harness();
    const [first, second] = await Promise.all([service.start(request()), service.start(request())]);
    await settle();
    expect([first.kind, second.kind].sort()).toEqual(["already_running", "started"]);
    const started = [first, second].find((result) => result.kind === "started")!;
    expect([first, second].find((result) => result.kind === "already_running")).toEqual({ kind: "already_running", requestId: (started as { requestId: string }).requestId });
    expect(calls).toHaveLength(1);
  });

  it("두 자리(blue · green — 서로 다른 프로세스가 같은 Redis) — 원자적으로 한 번", async () => {
    const clock = { now: START };
    const state = createFakeRedisState(() => clock.now);
    const blue = harness({ state, clock, idPrefix: "adm-blue" });
    const green = harness({ state, clock, idPrefix: "adm-green" });
    const results = await Promise.all([blue.service.start(request()), green.service.start(request()), blue.service.start(request()), green.service.start(request())]);
    await settle();
    expect(results.filter((result) => result.kind === "started")).toHaveLength(1);
    expect(blue.calls.length + green.calls.length).toBe(1);
  });

  it("다른 문제는 막지 않는다", async () => {
    const { service, calls } = harness();
    await service.start(request());
    expect((await service.start(request({ incidentId: "monitor:backend" }))).kind).toBe("started");
    await settle();
    expect(calls).toHaveLength(2);
  });
});

describe("Redis 에 닿지 못하면 분석을 시작하지 않는다", () => {
  it("처음부터 닿지 못함 → store_unavailable · 실행 자리를 부르지 않는다", async () => {
    const { service, state, calls, logs } = harness();
    state.down = true;
    expect(await service.start(request())).toEqual({ kind: "store_unavailable" });
    await settle();
    expect(calls).toEqual([]);
    expect(logs.map((entry) => entry.message)).toContain("incident-analysis:store_unavailable incident=monitor:front");
  });

  it("잠금은 잡았는데 기록을 쓰다 죽음 → store_unavailable · 부르지 않는다", async () => {
    const { service, state, calls } = harness();
    state.downAfterCommands = 1;
    expect(await service.start(request())).toEqual({ kind: "store_unavailable" });
    await settle();
    expect(calls).toEqual([]);
  });

  it("부른 뒤 Redis 가 죽음 → 결과를 저장하지 못했다고 로그에 · Redis 가 돌아오면 5분 뒤 interrupted", async () => {
    const { service, state, answer, logs, clock } = harness();
    await service.start(request());
    await settle();
    state.down = true;
    answer({ kind: "answered", answer: { ...ANSWER, evidence: [...ANSWER.evidence] } });
    await service.whenIdle();
    const line = logs.find((entry) => entry.message.startsWith("incident-analysis:result_not_stored"));
    expect(line?.message).toBe("incident-analysis:result_not_stored incident=monitor:front");
    expect(line?.requestId).toBe("adm-a-1");
    expect(line?.level).toBe("error");
    state.down = false;
    clock.now = START + ANALYSIS_RUNNING_LIMIT_MILLISECONDS;
    const history = await service.history("monitor:front");
    expect(history.ok && history.entries.map((entry) => entry.kind === "attempt" && entry.status)).toEqual(["interrupted"]);
  });

  it("목록을 읽지 못하면 { ok: false }", async () => {
    const { service, state } = harness();
    state.down = true;
    expect(await service.history("monitor:front")).toEqual({ ok: false });
  });
});

describe("5분 넘은 진행 중 — 끊김(결과를 모름) · 다시 요청할 수 있다", () => {
  it(`running 이 ${ANALYSIS_RUNNING_LIMIT_MILLISECONDS / 60_000}분 안이면 running, 넘으면 interrupted · 새 시작은 started`, async () => {
    const { service, clock, calls } = harness();
    await service.start(request());
    clock.now = START + ANALYSIS_RUNNING_LIMIT_MILLISECONDS - 1;
    let history = await service.history("monitor:front");
    expect(history.ok && history.entries[0]).toMatchObject({ kind: "attempt", status: "running" });
    expect((await service.start(request())).kind).toBe("already_running");
    clock.now = START + ANALYSIS_RUNNING_LIMIT_MILLISECONDS;
    history = await service.history("monitor:front");
    expect(history.ok && history.entries[0]).toMatchObject({ kind: "attempt", status: "interrupted" });
    expect((await service.start(request())).kind).toBe("started");
    await settle();
    expect(calls).toHaveLength(2);
  });
});

describe("저장 — 최근 5건 · 30일 · 읽을 수 없는 기록", () => {
  async function finishedRun(target: Harness, overrides: Partial<AnalysisStartRequest> = {}) {
    const started = await target.service.start(request(overrides));
    await settle();
    target.answer({ kind: "answered", answer: { ...ANSWER, evidence: [...ANSWER.evidence] } });
    await target.service.whenIdle();
    return started;
  }

  it(`최근 것부터 ${ANALYSIS_HISTORY_LIMIT}건 — 밀려난 시도의 키는 지운다 · 키의 수명은 30일`, async () => {
    const target = harness();
    for (let index = 0; index < 6; index += 1) {
      target.clock.now = START + index * 60_000;
      await finishedRun(target);
    }
    const history = await target.service.history("monitor:front");
    expect(history.ok && history.entries.map((entry) => entry.kind === "attempt" && entry.attempt.requestId)).toEqual(["adm-a-6", "adm-a-5", "adm-a-4", "adm-a-3", "adm-a-2"]);
    const keys = incidentAnalysisKeys("monitor:front");
    expect(target.state.strings.has(keys.attempt("adm-a-1"))).toBe(false);
    expect(target.state.lists.get(keys.history)?.items).toEqual(["adm-a-6", "adm-a-5", "adm-a-4", "adm-a-3", "adm-a-2"]);
    expect(ANALYSIS_RETENTION_MILLISECONDS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(target.state.strings.get(keys.attempt("adm-a-6"))?.expiresAt).toBeGreaterThanOrEqual(target.clock.now + ANALYSIS_RETENTION_MILLISECONDS - 60_000);
    expect(target.state.lists.get(keys.history)?.expiresAt).toBeGreaterThanOrEqual(target.clock.now + ANALYSIS_RETENTION_MILLISECONDS - 60_000);
  });

  it("30일이 지나면 사라진다", async () => {
    const target = harness();
    await finishedRun(target);
    target.clock.now = START + ANALYSIS_RETENTION_MILLISECONDS + 1;
    expect(await target.service.history("monitor:front")).toEqual({ ok: true, entries: [] });
  });

  it("읽을 수 없는 기록(깨진 JSON · 꼴이 틀림)은 그것만 unreadable — 다른 것은 보인다", async () => {
    const target = harness();
    await finishedRun(target);
    target.clock.now += 1;
    await finishedRun(target);
    const keys = incidentAnalysisKeys("monitor:front");
    target.state.strings.get(keys.attempt("adm-a-2"))!.value = "{not json";
    let history = await target.service.history("monitor:front");
    expect(history.ok && history.entries.map((entry) => entry.kind)).toEqual(["unreadable", "attempt"]);
    target.state.strings.get(keys.attempt("adm-a-2"))!.value = JSON.stringify({ version: 1, state: "succeeded", answer: { cause: 1 } });
    history = await target.service.history("monitor:front");
    expect(history.ok && history.entries.map((entry) => entry.kind)).toEqual(["unreadable", "attempt"]);
  });

  it("닫혔다 다시 열린 뒤 — 보낼 때의 since 와 지금의 since 가 다르면 옛 분석", async () => {
    const target = harness();
    await finishedRun(target);
    const same = await target.service.history("monitor:front", "2026-11-25T05:40:00.000Z");
    const reopened = await target.service.history("monitor:front", "2026-11-26T01:00:00.000Z");
    const unknown = await target.service.history("monitor:front");
    expect(same.ok && same.entries[0]).toMatchObject({ fromEarlierOpening: false });
    expect(reopened.ok && reopened.entries[0]).toMatchObject({ fromEarlierOpening: true });
    expect(unknown.ok && unknown.entries[0]).toMatchObject({ fromEarlierOpening: false });
  });

  it("다시 열어 보기는 부르지 않는다 — history 는 실행 자리를 부르지 않는다", async () => {
    const target = harness();
    await finishedRun(target);
    await target.service.history("monitor:front");
    await target.service.history("monitor:front");
    expect(target.calls).toHaveLength(1);
  });
});

describe("로그 — 요청 ID · 문제 식별자 · 결과 · 걸린 시간 · 바이트 수만", () => {
  it("보낸 글 · 답의 내용이 로그에도 Redis 의 다른 키에도 새지 않는다(시도 기록에만)", async () => {
    const target = harness();
    await target.service.start(request());
    await settle();
    target.clock.now = START + 41_000;
    target.answer({ kind: "answered", answer: { ...ANSWER, evidence: [...ANSWER.evidence] } });
    await target.service.whenIdle();
    await target.service.start(request());
    await target.service.start(request({ incidentId: "monitor:backend" }));
    await settle();
    const messages = target.logs.map((entry) => entry.message);
    expect(messages).toContain(`incident-analysis:started incident=monitor:front bytes=${new TextEncoder().encode(`자료 ${PROMPT_MARK}`).length}`);
    expect(messages).toContain(`incident-analysis:succeeded incident=monitor:front duration_ms=41000 bytes=${new TextEncoder().encode(`자료 ${PROMPT_MARK}`).length}`);
    for (const message of messages) {
      expect(message).toMatch(/^incident-analysis:[a-z_]+( [a-z_]+=[^ ]+)*$/);
      expect(message).not.toContain(PROMPT_MARK);
      expect(message).not.toContain(ANSWER_MARK);
    }
    const outsideAttempts = [...target.state.strings].filter(([key]) => !key.includes(":attempt:")).map(([, entry]) => entry.value).join("\n")
      + [...target.state.lists].map(([, entry]) => entry.items.join(",")).join("\n");
    expect(outsideAttempts).not.toContain(PROMPT_MARK);
    expect(everythingStored(target.state)).toContain(PROMPT_MARK);
  });

  it("실패의 로그 — reason 낱말", async () => {
    const target = harness();
    await target.service.start(request());
    await settle();
    target.answer({ kind: "failed", reason: "limit_reached" });
    await target.service.whenIdle();
    expect(target.logs.map((entry) => entry.message)).toContain(
      `incident-analysis:failed reason=limit_reached incident=monitor:front duration_ms=0 bytes=${new TextEncoder().encode(`자료 ${PROMPT_MARK}`).length}`);
  });
});

describe("미리보기는 한 번만 쓴다(명세 ⑫ §21 4 — claimPreview)", () => {
  const TOKEN = `ap2.${START}.-.${"S".repeat(43)}`;
  const OTHER = `ap2.${START}.-.${"T".repeat(43)}`;

  it("표시의 키 — 서명 값의 SHA-256(16진 64자) · 글 · 서명 값 그대로가 키에 없다", () => {
    const digest = createHash("sha256").update(TOKEN, "utf8").digest("hex");
    expect(usedPreviewKey(TOKEN)).toBe(`incident-analysis:v1:used-preview:${digest}`);
    expect(usedPreviewKey(TOKEN)).not.toContain("S".repeat(10));
    expect(usedPreviewKey(OTHER)).not.toBe(usedPreviewKey(TOKEN));
  });

  it("처음이면 claimed — SET NX PX 10분, 값 \"1\" · 두 번째는 used", async () => {
    const { service, state } = harness();
    expect(await service.claimPreview(TOKEN)).toBe("claimed");
    expect(ANALYSIS_USED_PREVIEW_MILLISECONDS).toBe(600_000);
    expect(state.strings.get(usedPreviewKey(TOKEN))).toEqual({ value: "1", expiresAt: START + 600_000 });
    expect(await service.claimPreview(TOKEN)).toBe("used");
    expect(await service.claimPreview(OTHER)).toBe("claimed");
  });

  it("10분이 지나면 표시가 사라진다(그때는 서명도 지났다)", async () => {
    const { service, clock } = harness();
    await service.claimPreview(TOKEN);
    clock.now = START + ANALYSIS_USED_PREVIEW_MILLISECONDS;
    expect(await service.claimPreview(TOKEN)).toBe("claimed");
  });

  it("두 자리가 동시에 — 원자적으로 하나만 claimed", async () => {
    const clock = { now: START };
    const state = createFakeRedisState(() => clock.now);
    const blue = harness({ state, clock });
    const green = harness({ state, clock });
    const results = await Promise.all([blue.service.claimPreview(TOKEN), green.service.claimPreview(TOKEN), blue.service.claimPreview(TOKEN)]);
    expect(results.filter((result) => result === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result === "used")).toHaveLength(2);
  });

  it("Redis 에 닿지 못하면 store_unavailable — 표시를 남기지 못했다", async () => {
    const { service, state } = harness();
    state.down = true;
    expect(await service.claimPreview(TOKEN)).toBe("store_unavailable");
  });
});
