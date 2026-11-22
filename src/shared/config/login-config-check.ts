/** 로그인 필수 설정의 전체 검사 — 형식(server-config) + 비밀번호 해시를 검증 라이브러리가 실제로 읽을 수 있는지(세부 4).
 * 시작 검사 · 헬스(missingRequiredConfigKeys 로 화면용 키와 합쳐) · 로그인 서비스가 같이 쓴다. argon2 를 임포트하므로 middleware 는 이 모듈을 쓰지 않는다. */
import "server-only";
import { isReadableArgon2idHash } from "@/features/auth/lib/password-hash";
import { missingLoginConfigKeys, missingScreenConfigKeys, type ServerConfig } from "@/shared/config/server-config";

export function missingOrUnreadableLoginConfigKeys(config: ServerConfig): string[] {
  const missing = missingLoginConfigKeys(config);
  // 비용 머리가 맞을 때만 라이브러리로 확인한다(검증 1회 — 결과는 password-hash 가 기억)
  if (!missing.includes("ADMIN_PASSWORD_HASH") && !isReadableArgon2idHash(config.adminPasswordHash)) {
    missing.push("ADMIN_PASSWORD_HASH");
  }
  return missing;
}

/** 서버가 뜨는 데 필요한 설정 전부 — 로그인(형식 · 해시 해석) + 화면 넷 · 알림(판정 11-22 15번). 시작 검사와 헬스가 쓴다.
 * 로그인 서비스는 로그인 몫(missingOrUnreadableLoginConfigKeys)만 본다. */
export function missingRequiredConfigKeys(config: ServerConfig): string[] {
  return [...missingOrUnreadableLoginConfigKeys(config), ...missingScreenConfigKeys(config)];
}
