/** argon2id 검증 어댑터(@node-rs/argon2). 해석할 수 없는 해시는 예외 대신 false. */
import { verify, verifySync } from "@node-rs/argon2";
import type { PasswordVerifier } from "@/features/auth/lib/types";

export const verifyArgon2idPassword: PasswordVerifier = async (passwordHash, password) => {
  if (!passwordHash.startsWith("$argon2id$")) return false;   // argon2id 만 받는다(다른 변형·빈 값은 맞지 않음)
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
};

/** 해시를 검증 라이브러리가 실제로 읽을 수 있는가(세부 4 — 길이를 고정하지 않는다).
 * 아무 입력으로 한 번 검증해 본다: 읽을 수 없는 해시는 예외, 읽을 수 있으면 true/false 가 돌아온다.
 * 비용은 argon2 검증 1회(m=19456,t=2 에서 약 50~70ms, 동기). 같은 값은 기억해 다시 돌리지 않는다(헬스가 요청마다 돌리지 않게). */
const readableHashResults = new Map<string, boolean>();

export function isReadableArgon2idHash(passwordHash: string): boolean {
  const remembered = readableHashResults.get(passwordHash);
  if (remembered !== undefined) return remembered;
  let readable: boolean;
  try {
    verifySync(passwordHash, "readability-probe");
    readable = true;
  } catch {
    readable = false;
  }
  if (readableHashResults.size >= 16) readableHashResults.clear();   // 설정값은 사실상 하나 — 무한히 커지지 않게만
  readableHashResults.set(passwordHash, readable);
  return readable;
}
