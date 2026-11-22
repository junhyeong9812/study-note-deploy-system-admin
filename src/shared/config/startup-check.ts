/** 시작 로그 — 설정이 비었으면 키 이름만 한 줄 남긴다(값은 찍지 않는다). 앱은 그대로 뜬다(헬스 ok, 로그인은 전부 거절). */
import "server-only";
import { missingLoginConfigKeys, missingOptionalConfigKeys, readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";

export function reportMissingConfiguration(): void {
  const config = readServerConfig();
  const missingLogin = missingLoginConfigKeys(config);
  const missingOptional = missingOptionalConfigKeys(config);
  if (missingLogin.length > 0) void log("startup", `설정 없음 — 로그인 전부 거절 keys=${missingLogin.join(",")}`, "error");
  if (missingOptional.length > 0) void log("startup", `설정 없음(선택) keys=${missingOptional.join(",")}`, "warning");
}
