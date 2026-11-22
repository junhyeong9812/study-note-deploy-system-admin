/** 세부 3 — 설정이 없으면 뜨지 않는다 · 헬스는 설정이 유효할 때만 200. process.exit 를 대체해 종료 코드를 본다. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hash } from "@node-rs/argon2";
import { GET as healthGet } from "@/app/api/health/route";
import { register } from "@/instrumentation";
import { checkStartupConfiguration } from "@/shared/config/startup-check";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";

class ExitSignal extends Error {
  constructor(public code: number | string | null | undefined) { super(`exit:${String(code)}`); }
}

const FAKE_OBSERVE_SECRET = "fake-observe-secret-marker-91";
const FAKE_ALERT_SECRET = "fake-alert-secret-marker-92";
const FAKE_OBSERVE_URL = "http://observe.example.test:17000";
let sameCostHash = "";
let expensiveHash = "";
const consoleLines: string[] = [];
let exitCalls: (number | string | null | undefined)[] = [];

const REQUIRED_KEYS = ["ADMIN_USER", "ADMIN_PASSWORD_HASH", "SESSION_SECRET", "ADMIN_ORIGIN", "OBSERVE_URL", "OBSERVE_SECRET"];

beforeAll(async () => {
  sameCostHash = await hash(FAKE_PASSWORD, { algorithm: 2 });
  expensiveHash = await hash(FAKE_PASSWORD, { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 });
});

beforeEach(() => {
  vi.unstubAllEnvs();
  consoleLines.length = 0;
  exitCalls = [];
  vi.stubEnv("ADMIN_USER", FAKE_ADMIN_ID);
  vi.stubEnv("ADMIN_PASSWORD_HASH", sameCostHash);
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", FAKE_OBSERVE_URL);
  vi.stubEnv("OBSERVE_SECRET", FAKE_OBSERVE_SECRET);
  vi.stubEnv("ALERT_URL", "http://alert.example.test:16000");
  vi.stubEnv("ALERT_SECRET", FAKE_ALERT_SECRET);
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "phase-production-server");
  vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    exitCalls.push(code);
    throw new ExitSignal(code);
  }) as typeof process.exit);
  // 종료 로그 등록이 실제 리스너를 남기지 않게
  vi.spyOn(process, "once").mockImplementation((() => process) as unknown as typeof process.once);
  vi.spyOn(process, "on").mockImplementation((() => process) as unknown as typeof process.on);
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => vi.restoreAllMocks());

async function runRegister(): Promise<void> {
  try {
    await register();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  }
}

function allFakeValues(): string[] {
  return [FAKE_ADMIN_ID, sameCostHash, expensiveHash, FAKE_SIGNING_KEY, FAKE_OBSERVE_SECRET, FAKE_ALERT_SECRET, FAKE_OBSERVE_URL];
}

const brokenSettings: [string, string, () => string][] = [
  ["ADMIN_USER 빔", "ADMIN_USER", () => ""],
  ["ADMIN_PASSWORD_HASH 빔", "ADMIN_PASSWORD_HASH", () => ""],
  ["ADMIN_PASSWORD_HASH 비용 다름", "ADMIN_PASSWORD_HASH", () => expensiveHash],
  ["ADMIN_PASSWORD_HASH argon2id 아님", "ADMIN_PASSWORD_HASH", () => "not-a-hash-fake"],
  ["SESSION_SECRET 빔", "SESSION_SECRET", () => ""],
  ["SESSION_SECRET 짧음", "SESSION_SECRET", () => "fake-short-key"],
  ["ADMIN_ORIGIN 빔", "ADMIN_ORIGIN", () => ""],
  ["OBSERVE_URL 빔", "OBSERVE_URL", () => ""],
  ["OBSERVE_SECRET 빔", "OBSERVE_SECRET", () => ""],
];

describe("시작 검사 — instrumentation.register()", () => {
  it("전부 유효하면 끝내지 않는다", async () => {
    await runRegister();
    expect(exitCalls).toEqual([]);
  });

  it.each(brokenSettings)("%s → 0 이 아닌 코드로 끝낸다, 로그 1줄에 키 이름만(값 없음)", async (_label, name, makeValue) => {
    vi.stubEnv(name, makeValue());
    await runRegister();
    expect(exitCalls).toHaveLength(1);
    expect(typeof exitCalls[0]).toBe("number");
    expect(exitCalls[0]).not.toBe(0);
    const keyLines = consoleLines.filter((line) => line.includes(name));
    expect(keyLines).toHaveLength(1);
    for (const line of consoleLines) {
      for (const value of allFakeValues()) expect(line, `logged: ${line}`).not.toContain(value);
      for (const otherKey of REQUIRED_KEYS.filter((key) => key !== name)) expect(line).not.toContain(otherKey);
    }
  });

  it("여러 키가 빠지면 1줄에 이름을 모두 담는다", async () => {
    vi.stubEnv("ADMIN_USER", "");
    vi.stubEnv("OBSERVE_SECRET", "");
    await runRegister();
    expect(exitCalls).toHaveLength(1);
    const lines = consoleLines.filter((line) => line.includes("ADMIN_USER") || line.includes("OBSERVE_SECRET"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ADMIN_USER");
    expect(lines[0]).toContain("OBSERVE_SECRET");
  });

  it.each(["ALERT_URL", "ALERT_SECRET"])("선택 설정 %s 가 비어도 끝내지 않는다", async (name) => {
    vi.stubEnv(name, "");
    await runRegister();
    expect(exitCalls).toEqual([]);
  });

  it("빌드 단계(NEXT_PHASE=phase-production-build)에는 검사하지 않는다", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("ADMIN_USER", "");
    await runRegister();
    expect(exitCalls).toEqual([]);
  });

  it("Node 런타임이 아니면(edge) 검사하지 않는다", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("ADMIN_USER", "");
    await runRegister();
    expect(exitCalls).toEqual([]);
  });
});

describe("시작 검사 — checkStartupConfiguration 직접", () => {
  it("유효하면 끝내지 않는다", () => {
    checkStartupConfiguration();
    expect(exitCalls).toEqual([]);
  });

  it("설정이 비면 0 이 아닌 코드", () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => checkStartupConfiguration()).toThrow(ExitSignal);
    expect(exitCalls[0]).not.toBe(0);
  });
});

describe("헬스 — 설정이 유효할 때만 200", () => {
  it("유효 → 200 {status:ok}, no-store", async () => {
    const response = await healthGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
  });

  it.each(brokenSettings)("%s → 503, 본문에 키 이름 · 값 없음", async (_label, name, makeValue) => {
    vi.stubEnv(name, makeValue());
    const response = await healthGet();
    expect(response.status).toBe(503);
    const text = await response.text();
    for (const key of REQUIRED_KEYS) expect(text).not.toContain(key);
    for (const value of allFakeValues()) expect(text).not.toContain(value);
  });

  it("선택 설정(ALERT_*)이 비어도 200", async () => {
    vi.stubEnv("ALERT_URL", "");
    vi.stubEnv("ALERT_SECRET", "");
    expect((await healthGet()).status).toBe(200);
  });
});

describe("세부 4 — 설정의 형식도 검사한다(형식이 틀리면 빈 값과 같이 종료 · 헬스 503)", () => {
  const malformedSettings: [string, string, () => string][] = [
    ["ADMIN_ORIGIN 끝의 /", "ADMIN_ORIGIN", () => `${FAKE_ORIGIN}/`],
    ["ADMIN_ORIGIN 경로 붙음", "ADMIN_ORIGIN", () => `${FAKE_ORIGIN}/login`],
    ["ADMIN_ORIGIN scheme 없음", "ADMIN_ORIGIN", () => FAKE_ORIGIN.replace("https://", "")],
    ["ADMIN_ORIGIN http", "ADMIN_ORIGIN", () => FAKE_ORIGIN.replace("https://", "http://")],
    ["ADMIN_ORIGIN 대문자 호스트", "ADMIN_ORIGIN", () => FAKE_ORIGIN.replace("admin.", "ADMIN.")],
    ["ADMIN_ORIGIN 가운데 공백", "ADMIN_ORIGIN", () => FAKE_ORIGIN.replace("admin.", "admin .")],
    ["ADMIN_ORIGIN 쿼리", "ADMIN_ORIGIN", () => `${FAKE_ORIGIN}?x=1`],
    ["OBSERVE_URL scheme 없음", "OBSERVE_URL", () => "observe-host:17000"],
    ["OBSERVE_URL 해석 불가", "OBSERVE_URL", () => "http://"],
    ["OBSERVE_URL ftp", "OBSERVE_URL", () => "ftp://observe.example.test"],
    ["OBSERVE_URL 낱말", "OBSERVE_URL", () => "observe"],
    ["해시 비용 머리 + 쓰레기", "ADMIN_PASSWORD_HASH", () => "$argon2id$v=19$m=19456,t=2,p=1$garbage"],
    ["해시 비용 머리 + 빈 조각", "ADMIN_PASSWORD_HASH", () => "$argon2id$v=19$m=19456,t=2,p=1$$"],
    ["해시 digest 깨짐", "ADMIN_PASSWORD_HASH", () => `${sameCostHash.slice(0, sameCostHash.lastIndexOf("$") + 1)}!!!not-base64!!!`],
  ];

  it.each(malformedSettings)("%s → 0 이 아닌 코드로 종료, 로그 1줄에 키 이름만", async (_label, name, makeValue) => {
    const value = makeValue();
    vi.stubEnv(name, value);
    await runRegister();
    expect(exitCalls).toHaveLength(1);
    expect(exitCalls[0]).not.toBe(0);
    expect(consoleLines.filter((line) => line.includes(name))).toHaveLength(1);
    for (const line of consoleLines) {
      expect(line).not.toContain(value);
      for (const fakeValue of allFakeValues()) expect(line).not.toContain(fakeValue);
    }
  });

  it.each(malformedSettings)("%s → 헬스 503, 본문에 키 이름 · 값 없음", async (_label, name, makeValue) => {
    const value = makeValue();
    vi.stubEnv(name, value);
    const response = await healthGet();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain(name);
    expect(text).not.toContain(value);
  });

  const validSettings: [string, string, () => Promise<string> | string][] = [
    ["ADMIN_ORIGIN 출처 꼴", "ADMIN_ORIGIN", () => "https://admin.example.test"],
    ["ADMIN_ORIGIN 포트가 붙은 https", "ADMIN_ORIGIN", () => "https://admin.example.test:8443"],
    ["OBSERVE_URL http + 포트", "OBSERVE_URL", () => "http://observe.example.test:17000"],
    ["OBSERVE_URL https", "OBSERVE_URL", () => "https://observe.example.test"],
    ["OBSERVE_URL 끝의 /", "OBSERVE_URL", () => "http://observe.example.test:17000/"],
    ["해시 salt 8바이트", "ADMIN_PASSWORD_HASH", () => hash(FAKE_PASSWORD, { algorithm: 2, salt: new Uint8Array(8).fill(7) })],
    ["해시 salt 32바이트", "ADMIN_PASSWORD_HASH", () => hash(FAKE_PASSWORD, { algorithm: 2, salt: new Uint8Array(32).fill(9) })],
    ["해시 출력 64바이트", "ADMIN_PASSWORD_HASH", () => hash(FAKE_PASSWORD, { algorithm: 2, outputLen: 64 })],
  ];

  it.each(validSettings)("%s → 종료하지 않고 헬스 200", async (_label, name, makeValue) => {
    vi.stubEnv(name, await makeValue());
    await runRegister();
    expect(exitCalls).toEqual([]);
    expect((await healthGet()).status).toBe(200);
  });
});
