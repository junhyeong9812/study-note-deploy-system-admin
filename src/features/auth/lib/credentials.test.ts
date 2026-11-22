import { describe, expect, it, vi } from "vitest";
import { DUMMY_PASSWORD_HASH, verifyCredentials } from "@/features/auth/lib/credentials";
import { verifyArgon2idPassword } from "@/features/auth/lib/password-hash";
import { FAKE_ADMIN_ID, FAKE_PASSWORD, FAKE_PASSWORD_HASH } from "@/features/auth/lib/test-fakes";
import type { PasswordVerifier } from "@/features/auth/lib/types";

const CONFIG = { adminId: FAKE_ADMIN_ID, passwordHash: FAKE_PASSWORD_HASH };

/** 해시가 설정값이고 비밀번호가 FAKE_PASSWORD 일 때만 true 인 검증 Fake. */
function fakeVerifier() {
  return vi.fn<PasswordVerifier>(async (passwordHash, password) =>
    passwordHash === FAKE_PASSWORD_HASH && password === FAKE_PASSWORD);
}

describe("verifyCredentials", () => {
  it("ID 와 비밀번호가 맞으면 true, 설정 해시로 1회 검증", async () => {
    const verifier = fakeVerifier();
    expect(await verifyCredentials({ id: FAKE_ADMIN_ID, password: FAKE_PASSWORD }, CONFIG, verifier)).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledWith(FAKE_PASSWORD_HASH, FAKE_PASSWORD);
  });

  it("비밀번호가 틀리면 false, 검증 1회", async () => {
    const verifier = fakeVerifier();
    expect(await verifyCredentials({ id: FAKE_ADMIN_ID, password: "fake-wrong" }, CONFIG, verifier)).toBe(false);
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it("ID 가 틀려도 더미 해시로 정확히 1회 검증하고 false", async () => {
    const verifier = fakeVerifier();
    expect(await verifyCredentials({ id: "fake-other-id", password: FAKE_PASSWORD }, CONFIG, verifier)).toBe(false);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier.mock.calls[0][0]).toBe(DUMMY_PASSWORD_HASH);
  });

  it("ID 가 틀리면 검증 함수가 true 를 돌려줘도 false", async () => {
    const alwaysTrue = vi.fn<PasswordVerifier>(async () => true);
    expect(await verifyCredentials({ id: "fake-other-id", password: FAKE_PASSWORD }, CONFIG, alwaysTrue)).toBe(false);
    expect(alwaysTrue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["대소문자만 다른 ID", FAKE_ADMIN_ID.toUpperCase()],
    ["뒤에 공백", `${FAKE_ADMIN_ID} `],
    ["앞부분만", FAKE_ADMIN_ID.slice(0, -1)],
    ["빈 ID", ""],
  ])("ID 는 글자까지 같아야 맞음 — %s", async (_label, id) => {
    const alwaysTrue = vi.fn<PasswordVerifier>(async () => true);
    expect(await verifyCredentials({ id, password: FAKE_PASSWORD }, CONFIG, alwaysTrue)).toBe(false);
  });

  it.each([
    ["ID 가 빔", { adminId: "", passwordHash: FAKE_PASSWORD_HASH }, { id: "", password: FAKE_PASSWORD }],
    ["해시가 빔", { adminId: FAKE_ADMIN_ID, passwordHash: "" }, { id: FAKE_ADMIN_ID, password: "" }],
    ["둘 다 빔", { adminId: "", passwordHash: "" }, { id: "", password: "" }],
    ["공백뿐", { adminId: "  ", passwordHash: "  " }, { id: "  ", password: "  " }],
  ])("설정이 비면 항상 거절 — %s (검증 함수가 true 여도)", async (_label, config, input) => {
    const alwaysTrue = vi.fn<PasswordVerifier>(async () => true);
    expect(await verifyCredentials(input, config, alwaysTrue)).toBe(false);
  });

  it("설정이 비어도 검증 함수를 더미 해시로 1회 호출한다(시간 구별 방지)", async () => {
    const verifier = fakeVerifier();
    await verifyCredentials({ id: "", password: "" }, { adminId: "", passwordHash: "" }, verifier);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier.mock.calls[0][0]).toBe(DUMMY_PASSWORD_HASH);
  });
});

describe("argon2id 어댑터 (실제 @node-rs/argon2)", () => {
  it("더미 해시는 argon2id 형식이고 설정 해시와 다르다", () => {
    expect(DUMMY_PASSWORD_HASH.startsWith("$argon2id$")).toBe(true);
    expect(DUMMY_PASSWORD_HASH).not.toBe(FAKE_PASSWORD_HASH);
  });

  it("더미 해시는 흔한 입력과 맞지 않는다(검증은 예외 없이 false)", async () => {
    for (const password of ["", "password", "admin", FAKE_PASSWORD]) {
      expect(await verifyArgon2idPassword(DUMMY_PASSWORD_HASH, password)).toBe(false);
    }
  });

  it("argon2id 해시를 만들어 맞는 비밀번호만 true", async () => {
    const { hash } = await import("@node-rs/argon2");
    const ARGON2ID_ALGORITHM = 2;   // Algorithm.Argon2id (const enum — isolatedModules 에서 직접 못 씀)
    const passwordHash = await hash("fake-generated-password", { algorithm: ARGON2ID_ALGORITHM });
    expect(await verifyArgon2idPassword(passwordHash, "fake-generated-password")).toBe(true);
    expect(await verifyArgon2idPassword(passwordHash, "fake-generated-passwordX")).toBe(false);
  });

  it.each(["", "not-a-hash", "$argon2id$broken", FAKE_PASSWORD_HASH.slice(0, 20)])(
    "해석할 수 없는 해시(%j)는 예외 대신 false", async (passwordHash) => {
      await expect(verifyArgon2idPassword(passwordHash, FAKE_PASSWORD)).resolves.toBe(false);
    });
});
