/** argon2id 검증 어댑터(@node-rs/argon2). 해석할 수 없는 해시는 예외 대신 false. */
import type { PasswordVerifier } from "@/features/auth/lib/types";

export const verifyArgon2idPassword: PasswordVerifier = async (passwordHash, password) => {
  throw new Error("not implemented");
};
