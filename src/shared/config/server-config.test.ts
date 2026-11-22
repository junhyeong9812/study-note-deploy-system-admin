/** 세부 2 — 해시 비용이 더미와 다르면 "설정 없음"(시작 로그 1줄, 값은 찍지 않는다). */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hash } from "@node-rs/argon2";
import { missingLoginConfigKeys, readServerConfig } from "@/shared/config/server-config";
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
