/** 시작 검사 — 필수 설정이 없거나 형식이 틀리면 뜨지 않는다(세부 3 · 4). 로그에는 키 이름만(값은 찍지 않는다).
 * 해시 해석 확인은 argon2 검증 1회(동기, 약 50~70ms)라 시작 때 한 번만 든다. */
import "server-only";
import { missingRequiredConfigKeys } from "@/shared/config/login-config-check";
import { missingOptionalConfigKeys, readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";

/** 필수 설정이 빠졌거나 잘못됐을 때의 종료 코드(sysexits 의 EX_CONFIG). */
export const MISSING_CONFIGURATION_EXIT_CODE = 78;

/** 세부 3 — 설정이 없으면 뜨지 않는다. instrumentation.register() 가 Node 런타임에서 부른다.
 * 빌드 단계(NEXT_PHASE === "phase-production-build")에는 검사하지 않는다.
 * 필수 설정(로그인 + 화면 넷 · 알림 — 판정 11-22 15번)이 빠졌거나 잘못됐으면 키 이름만 1줄 남기고 process.exit(0 이 아닌 코드).
 * 선택으로 남는 것은 LOG_REDIS_URL 뿐이다(막지 않는다). */
export function checkStartupConfiguration(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const missing = missingRequiredConfigKeys(readServerConfig());
  if (missing.length === 0) return;
  // log 는 stdout 에 먼저(동기) 쓴다 — 곧바로 끝내도 컨테이너 로그에 남는다
  void log("startup", `설정 없음 — 서버를 끝낸다 keys=${missing.join(",")}`, "error");
  process.exit(MISSING_CONFIGURATION_EXIT_CODE);
}

/** 선택 설정이 비었으면 이름만 1줄(막지 않는다). */
export function reportMissingConfiguration(): void {
  const missingOptional = missingOptionalConfigKeys(readServerConfig());
  if (missingOptional.length > 0) void log("startup", `설정 없음(선택) keys=${missingOptional.join(",")}`, "warning");
}
