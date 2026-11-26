/** 테스트 전용 — 분석의 가짜들: Redis(ioredis 의 명령 꼴 그대로 · 시계로 수명을 본다 · 멈춤을 흉내 낸다) · 실행 자리의 POST /runs 답 · 근거 묶음.
 * 주소는 문서용 도메인(.test), 비밀값은 꼴만 흉내 낸 가짜. 토큰 꼴의 글은 조각을 이어 만든다(저장소의 비밀값 검사가 진짜로 오인하지 않게). */
import type { AnalysisRedisCommands } from "@/features/incident-analysis/lib/incident-analysis-service";
import type { EvidenceLogLine, IncidentEvidence } from "@/features/incidents/lib/incident-evidence";
import { openIncidentsFrom } from "@/features/incidents/lib/incident-list";
import { HOUR, MINUTE, NOW, SECOND, alertRecord, deployment, iso, monitor, monitors, ok, quietSources } from "@/features/incidents/lib/incidents-test-fakes";

export const FAKE_CLAUDE_RUNNER_CALL_SECRET = "fake-claude-call-secret-marker-c75";
export const CLAUDE_CALL_SECRET_HEADER = "x-claude-runner-secret";
export const FAKE_LOG_REDIS_URL = "redis://redis.example.test:6379";

// ── Redis ────────────────────────────────────────────────

export interface FakeRedisState {
  strings: Map<string, { value: string; expiresAt: number | null }>;
  lists: Map<string, { items: string[]; expiresAt: number | null }>;
  /** 참이면 모든 명령이 거부된다(닿지 못함) */
  down: boolean;
  /** 이 수만큼 명령이 지나간 뒤부터 down(0 이상이면 센다 — null 이면 끔) */
  downAfterCommands: number | null;
  /** 받은 명령(이름과 첫 인자) */
  commands: string[];
  /** 로그 스트림(XADD)으로 받은 줄 */
  streamLines: string[];
  clock: () => number;
}

export function createFakeRedisState(clock: () => number = () => Date.now()): FakeRedisState {
  return { strings: new Map(), lists: new Map(), down: false, downAfterCommands: null, commands: [], streamLines: [], clock };
}

export function resetFakeRedisState(state: FakeRedisState, clock: () => number = () => Date.now()): void {
  state.strings.clear();
  state.lists.clear();
  state.down = false;
  state.downAfterCommands = null;
  state.commands.length = 0;
  state.streamLines.length = 0;
  state.clock = clock;
}

/** 저장된 모든 값(글 · 목록)을 한 글로 — 새지 않음을 볼 때. */
export function everythingStored(state: FakeRedisState): string {
  return [...state.strings].map(([key, entry]) => `${key}=${entry.value}`)
    .concat([...state.lists].map(([key, entry]) => `${key}=${entry.items.join(",")}`)).join("\n");
}

/** ioredis 의 명령 꼴 그대로(명령마다 한 번 양보한다 — 두 자리가 끼어드는 것을 흉내 낸다). */
export class FakeRedis implements AnalysisRedisCommands {
  constructor(private readonly state: FakeRedisState) {}

  private async enter(name: string, key: string): Promise<void> {
    await Promise.resolve();
    if (this.state.downAfterCommands !== null) {
      if (this.state.downAfterCommands <= 0) this.state.down = true;
      else this.state.downAfterCommands -= 1;
    }
    if (this.state.down) throw new Error("connect ECONNREFUSED redis.example.test:6379");
    this.state.commands.push(`${name} ${key}`);
  }

  private alive<Entry extends { expiresAt: number | null }>(map: Map<string, Entry>, key: string): Entry | undefined {
    const entry = map.get(key);
    if (entry !== undefined && entry.expiresAt !== null && entry.expiresAt <= this.state.clock()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    await this.enter("get", key);
    return this.alive(this.state.strings, key)?.value ?? null;
  }

  async set(key: string, value: string, mode: "PX", milliseconds: number, condition?: "NX"): Promise<"OK" | null> {
    await this.enter("set", key);
    if (mode !== "PX" || !Number.isInteger(milliseconds) || milliseconds <= 0) throw new Error("ERR syntax error");
    if (condition === "NX" && this.alive(this.state.strings, key) !== undefined) return null;
    this.state.strings.set(key, { value, expiresAt: this.state.clock() + milliseconds });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    await this.enter("del", keys.join(" "));
    let removed = 0;
    for (const key of keys) {
      if (this.alive(this.state.strings, key) !== undefined) { this.state.strings.delete(key); removed += 1; }
      if (this.alive(this.state.lists, key) !== undefined) { this.state.lists.delete(key); removed += 1; }
    }
    return removed;
  }

  async lpush(key: string, value: string): Promise<number> {
    await this.enter("lpush", key);
    const entry = this.alive(this.state.lists, key) ?? { items: [], expiresAt: null };
    entry.items.unshift(value);
    this.state.lists.set(key, entry);
    return entry.items.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<"OK"> {
    await this.enter("ltrim", key);
    const entry = this.alive(this.state.lists, key);
    if (entry !== undefined) entry.items = entry.items.slice(start, stop < 0 ? entry.items.length + stop + 1 : stop + 1);
    return "OK";
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    await this.enter("lrange", key);
    const items = this.alive(this.state.lists, key)?.items ?? [];
    return items.slice(start, stop < 0 ? items.length + stop + 1 : stop + 1);
  }

  async pexpire(key: string, milliseconds: number): Promise<number> {
    await this.enter("pexpire", key);
    const entry = this.alive(this.state.strings, key) ?? this.alive(this.state.lists, key);
    if (entry === undefined) return 0;
    entry.expiresAt = this.state.clock() + milliseconds;
    return 1;
  }

  // 로그(logger.ts)가 같은 Redis 에 쓰는 명령 — 받기만 한다
  async xadd(...parts: (string | number)[]): Promise<string> {
    await Promise.resolve();
    if (this.state.down) throw new Error("connect ECONNREFUSED");
    const lineIndex = parts.indexOf("line");
    if (lineIndex >= 0) this.state.streamLines.push(String(parts[lineIndex + 1]));
    return "0-1";
  }

  on(): this { return this; }
  async quit(): Promise<"OK"> { return "OK"; }
  disconnect(): void {}
}

// ── 실행 자리 POST /runs 의 답 ──────────────────────────────

export function validRunnerAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cause: "backend 의 DB 연결 풀이 비었습니다", evidence: ["오류 로그 42줄이 같은 예외", "직전 배포에서 풀 크기를 줄였다"],
    confidence: "medium", remedy: "직전 배포를 되돌린 뒤 풀 크기를 다시 늘립니다", recommended_action: "rollback", ...overrides,
  };
}

export function runnerSuccessBody(answer: unknown = validRunnerAnswer(), requestId = "req-analysis-1"): Record<string, unknown> {
  return { success: true, data: { answer, purpose: "analysis", request_id: requestId, duration_ms: 41_000, usage: { input_tokens: 9000, output_tokens: 700 } } };
}

export function runnerFailureBody(code: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return { success: false, error: { code, ...details } };
}

// ── 토큰 꼴(조각을 이어 만든다) ───────────────────────────────

/** 정해진 씨에서 만든 글자 — 같은 씨면 같은 글. */
export function fakeCharacters(seed: number, length: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"): string {
  let state = seed >>> 0;
  let text = "";
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    text += alphabet[(state >>> 8) % alphabet.length];
  }
  return text;
}

export const FAKE_TOKENS = {
  github: "gh" + "p_" + fakeCharacters(1, 36),
  githubFineGrained: "github" + "_pat_" + fakeCharacters(2, 30),
  openAi: "s" + "k-" + fakeCharacters(3, 40),
  openAiProject: "s" + "k-proj-" + fakeCharacters(4, 40),
  aws: "AK" + "IA" + fakeCharacters(5, 16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
  jwt: "ey" + "J" + fakeCharacters(6, 20) + ".ey" + "J" + fakeCharacters(7, 30) + "." + fakeCharacters(8, 30),
} as const;

// ── 근거 묶음(맞추기 전) ─────────────────────────────────────

export const DOWN_AT = NOW - 20 * MINUTE;

export function downIncident() {
  return openIncidentsFrom(quietSources({ monitors: ok(monitors([monitor({ name: "front", status: "DOWN", downSince: iso(DOWN_AT), reason: "status 502" })])) })).incidents[0];
}

export function evidenceLogLines(count: number, message: (index: number) => string): EvidenceLogLine[] {
  return Array.from({ length: count }, (_, index) => {
    const at = iso(DOWN_AT - 10 * MINUTE + index * SECOND);
    const id = `${Date.parse(at)}-${index}`;
    return { id, at, level: "error", service: "front", requestId: "", message: message(index), href: `/logs?selected=${id}` };
  });
}

/** 칸이 모두 값인 감시 대상 DOWN 묶음(맞추기 전). */
export function analysisEvidence(lines: EvidenceLogLine[] = evidenceLogLines(3, (index) => `오류 ${index}`), overrides: Partial<IncidentEvidence> = {}): IncidentEvidence {
  const recent = deployment({ requestId: "req-deploy-7", service: "backend", commitSha: "e".repeat(40), state: "failed", failedStage: "cd_health", acceptedAt: iso(DOWN_AT - 30 * MINUTE) });
  return {
    incident: downIncident(),
    facts: [{ label: "대상", value: "front" }, { label: "상태", value: "DOWN" }, { label: "이유", value: "status 502" }],
    alertHistory: { state: "value", value: { from: iso(DOWN_AT - HOUR), to: iso(DOWN_AT + HOUR), coversWindow: true, records: [alertRecord({ at: iso(DOWN_AT), key: "front", title: "응답 없음: front" })] } },
    logs: { state: "value", value: { scope: "levels", from: iso(DOWN_AT - 10 * MINUTE), to: iso(DOWN_AT + 10 * MINUTE), services: ["front"], requestId: null, lines, truncated: false, noticeText: null } },
    deployments: { state: "value", value: { kind: "window", from: iso(DOWN_AT - HOUR), to: iso(DOWN_AT), coversWindow: true, deployments: [{ ...recent, href: "/deploys?selected=req-deploy-7" }] } },
    resources: { state: "not_applicable" },
    reductions: [],
    ...overrides,
  };
}

/** 정해진 바이트를 차례로 돌려주는 무작위 원천(다 쓰면 마지막 것을 되풀이). */
export function scriptedRandomBytes(...draws: number[][]): { randomBytes: (size: number) => Uint8Array; calls: number[] } {
  const calls: number[] = [];
  let index = 0;
  return {
    calls,
    randomBytes: (size: number) => {
      calls.push(size);
      const draw = draws[Math.min(index, draws.length - 1)];
      index += 1;
      return Uint8Array.from({ length: size }, (_, position) => draw[position % draw.length]);
    },
  };
}

export function hexOf(bytes: number[], size = 16): string {
  return Array.from({ length: size }, (_, position) => bytes[position % bytes.length].toString(16).padStart(2, "0")).join("");
}

// ── ioredis 를 대신하는 것(vi.mock("ioredis") 에서 default 로) ─────────

/** 테스트 파일 하나가 함께 쓰는 Redis 의 상태 — ioredis 를 가짜로 바꾼 모든 연결이 이것을 본다(두 자리가 같은 Redis 를 보는 것과 같다). */
export const SHARED_FAKE_REDIS_STATE: FakeRedisState = createFakeRedisState();
/** 만들어진 연결의 주소 */
export const FAKE_REDIS_CONNECTIONS: string[] = [];

export class FakeIoRedis extends FakeRedis {
  constructor(url?: unknown) {
    super(SHARED_FAKE_REDIS_STATE);
    FAKE_REDIS_CONNECTIONS.push(String(url));
  }
}
