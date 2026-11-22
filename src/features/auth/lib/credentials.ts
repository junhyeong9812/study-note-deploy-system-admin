/** 자격 검증 — 계정 1개(환경 변수의 ID · argon2id 해시). */
import { timingSafeEqual } from "node:crypto";
import type { PasswordVerifier } from "@/features/auth/lib/types";

export interface AccountConfig {
  adminId: string;
  passwordHash: string;
}

export interface CredentialInput {
  id: string;
  password: string;
}

/** ID 가 틀렸을 때(또는 설정이 비었을 때) 검증에 쓰는 고정된 argon2id 해시.
 * 어떤 비밀번호와도 맞지 않는 값이어야 한다(가짜 평문으로 만든 해시 — 평문은 저장하지 않는다).
 * 만든 방법: 48바이트 난수의 base64 를 @node-rs/argon2 기본값(m=19456,t=2,p=1)으로 해시하고 평문은 버렸다.
 * 운영 해시도 같은 기본값으로 만들어야 검증 시간이 비슷하다(README 의 해시 명령). */
export const DUMMY_PASSWORD_HASH: string =
  "$argon2id$v=19$m=19456,t=2,p=1$cNSBwG500oNe6ZK/B2GFDQ$46GeUCSwgBMi+zFiJd2NzRJRPsEk7ExWdfzt7yr6XHw";

/** 설정 해시가 가져야 하는 머리(알고리즘 · 버전 · 비용 m·t·p) — 더미 해시와 같다.
 * 다르면 설정 없음과 같이 전부 거절한다(세부 2 — ID 틀림과 비밀번호 틀림의 검증 시간이 갈리지 않게). */
export const REQUIRED_PASSWORD_HASH_PREFIX = "$argon2id$v=19$m=19456,t=2,p=1$";

/** 설정 해시가 더미 해시와 같은 알고리즘 · 비용인가. */
export function hasRequiredHashCost(passwordHash: string): boolean {
  return passwordHash.startsWith(REQUIRED_PASSWORD_HASH_PREFIX) && passwordHash.length > REQUIRED_PASSWORD_HASH_PREFIX.length;
}

function sameText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

/** 맞으면 true. 규칙:
 * - 설정(ID · 해시) 중 하나라도 비거나 해시 비용이 더미와 다르면 항상 false(빈 값이 통과가 되지 않는다).
 * - ID 가 틀려도 DUMMY_PASSWORD_HASH 로 verifyPassword 를 정확히 1회 호출한다(시간 구별 방지).
 * - ID 비교는 글자까지 같을 때만 맞음. */
export async function verifyCredentials(input: CredentialInput, config: AccountConfig,
                                        verifyPassword: PasswordVerifier): Promise<boolean> {
  const configured = config.adminId.trim().length > 0 && hasRequiredHashCost(config.passwordHash);
  const idMatches = configured && sameText(input.id, config.adminId);
  const hashToCheck = idMatches ? config.passwordHash : DUMMY_PASSWORD_HASH;
  let passwordMatches = false;
  try {
    passwordMatches = await verifyPassword(hashToCheck, input.password);
  } catch {
    passwordMatches = false;
  }
  return idMatches && passwordMatches === true;
}
