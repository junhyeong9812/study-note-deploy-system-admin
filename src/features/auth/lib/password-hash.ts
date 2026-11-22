/** argon2id 검증 어댑터(@node-rs/argon2). 해석할 수 없는 해시는 예외 대신 false. */
import { verify } from "@node-rs/argon2";
import type { PasswordVerifier } from "@/features/auth/lib/types";

export const verifyArgon2idPassword: PasswordVerifier = async (passwordHash, password) => {
  if (!passwordHash.startsWith("$argon2id$")) return false;   // argon2id 만 받는다(다른 변형·빈 값은 맞지 않음)
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
};
