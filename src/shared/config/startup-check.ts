/** 시작 검사 — 설정이 없으면 뜨지 않는다(세부 3). 로그에는 키 이름만(값은 찍지 않는다). */
import "server-only";
import { missingLoginConfigKeys, missingOptionalConfigKeys, readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";

/** 필수 설정이 빠졌거나 잘못됐을 때의 종료 코드(sysexits 의 EX_CONFIG). */
export const MISSING_CONFIGURATION_EXIT_CODE = 78;

/** 세부 3 — 설정이 없으면 뜨지 않는다. instrumentation.register() 가 Node 런타임에서 부른다.
 * 빌드 단계(NEXT_PHASE === "phase-production-build")에는 검사하지 않는다.
 * 로그인 필수 설정이 빠졌거나 잘못됐으면 키 이름만 1줄 남기고 process.exit(0 이 아닌 코드). 선택 설정(ALERT_*)은 막지 않는다. */
export function checkStartupConfiguration(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const missing = missingLoginConfigKeys(readServerConfig());
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
