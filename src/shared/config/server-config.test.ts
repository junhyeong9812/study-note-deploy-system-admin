/** 세부 2 — 해시 비용이 더미와 다르면 "설정 없음"(시작 로그 1줄, 값은 찍지 않는다). */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hash } from "@node-rs/argon2";
import { missingLoginConfigKeys, missingOptionalConfigKeys, missingScreenConfigKeys, readServerConfig } from "@/shared/config/server-config";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";

let sameCostHash = "";
let expensiveHash = "";
const consoleLines: string[] = [];

beforeAll(async () => {
  sameCostHash = await hash(FAKE_PASSWORD, { algorithm: 2 });
  expensiveHash = await hash(FAKE_PASSWORD, { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 });
});

beforeEach(() => {
  vi.unstubAllEnvs();
  consoleLines.length = 0;
  vi.stubEnv("ADMIN_USER", FAKE_ADMIN_ID);
  vi.stubEnv("ADMIN_PASSWORD_HASH", sameCostHash);
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("OBSERVE_URL", "http://observe.example.test:17000");
  vi.stubEnv("OBSERVE_SECRET", "fake-observe-secret");
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { consoleLines.push(parts.map(String).join(" ")); });
  }
});

afterEach(() => vi.restoreAllMocks());

describe("missingLoginConfigKeys — 해시 비용", () => {
  it("더미와 같은 비용(m=19456,t=2,p=1)이면 빠진 키 없음", () => {
    expect(missingLoginConfigKeys(readServerConfig())).toEqual([]);
  });

  it("비용이 다르면 ADMIN_PASSWORD_HASH 를 설정 없음으로 본다", () => {
    vi.stubEnv("ADMIN_PASSWORD_HASH", expensiveHash);
    expect(missingLoginConfigKeys(readServerConfig())).toContain("ADMIN_PASSWORD_HASH");
  });
});

describe("판정 11-22(15번) — missingScreenConfigKeys: 화면용 · 알림 설정도 필수", () => {
  const SCREEN_KEYS = ["DEPLOY_MASTER_URL", "DEPLOY_SECRET", "BACKEND_URL", "ALERT_URL", "ALERT_SECRET"];

  beforeEach(() => {
    vi.stubEnv("DEPLOY_MASTER_URL", "http://deploy-master.example.test:15000");
    vi.stubEnv("DEPLOY_SECRET", "fake-deploy-secret");
    vi.stubEnv("BACKEND_URL", "http://backend.example.test:8080/");
    vi.stubEnv("ALERT_URL", "https://alert.example.test");
    vi.stubEnv("ALERT_SECRET", "fake-alert-secret");
  });

  it("다섯이 다 맞으면 빈 목록", () => {
    expect(missingScreenConfigKeys(readServerConfig())).toEqual([]);
  });

  it.each(SCREEN_KEYS)("%s 가 비면(공백만 포함) 그 이름", (name) => {
    vi.stubEnv(name, "  ");
    expect(missingScreenConfigKeys(readServerConfig())).toEqual([name]);
  });

  it.each([
    ["DEPLOY_MASTER_URL", "deploy-master.example.test:15000"], ["DEPLOY_MASTER_URL", "ftp://deploy-master.example.test"],
    ["BACKEND_URL", "http://"], ["BACKEND_URL", "backend"], ["ALERT_URL", "alert.example.test"],
  ])("주소 키 %s = %j(해석되는 http(s) 아님) → 그 이름", (name, value) => {
    vi.stubEnv(name, value);
    expect(missingScreenConfigKeys(readServerConfig())).toEqual([name]);
  });

  it("전부 비면 다섯 이름 모두", () => {
    for (const name of SCREEN_KEYS) vi.stubEnv(name, "");
    expect([...missingScreenConfigKeys(readServerConfig())].sort()).toEqual([...SCREEN_KEYS].sort());
  });

  it("로그인 판정(missingLoginConfigKeys)에는 들어가지 않는다 — 시작 검사와 헬스가 합쳐 본다", () => {
    for (const name of SCREEN_KEYS) vi.stubEnv(name, "");
    expect(missingLoginConfigKeys(readServerConfig())).toEqual([]);
  });

  it("선택 설정 목록에는 화면용 · 알림 키가 없다(남은 선택은 LOG_REDIS_URL)", () => {
    for (const name of SCREEN_KEYS) vi.stubEnv(name, "");
    vi.stubEnv("LOG_REDIS_URL", "");
    expect(missingOptionalConfigKeys(readServerConfig())).toEqual(["LOG_REDIS_URL"]);
  });
});
