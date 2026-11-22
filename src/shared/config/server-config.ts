/** 설정 읽기 — 비밀값이 든 환경 변수는 이 모듈만 읽는다. 서버 쪽 전용(클라이언트 묶음에 들어가면 빌드가 실패한다).
 * 값은 로그·응답에 내지 않는다. 비어 있는 키는 "이름만" 알린다. */
import "server-only";

export interface ServerConfig {
  adminUser: string;
  adminPasswordHash: string;
  sessionSecret: string;
  adminOrigin: string;
  observeUrl: string;
  observeSecret: string;
  alertUrl: string;
  alertSecret: string;
  // 다음 task(화면 넷)용 자리 — 지금은 읽기만 한다
  deployMasterUrl: string;
  deploySecret: string;
  backendUrl: string;
  logRedisUrl: string;
  serverName: string;
}

/** 서명 키의 최소 길이 — 짧은 키는 비어 있는 것으로 본다. */
export const SESSION_SECRET_MINIMUM_LENGTH = 32;

function environmentValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function readServerConfig(): ServerConfig {
  return {
    adminUser: environmentValue("ADMIN_USER"),
    adminPasswordHash: environmentValue("ADMIN_PASSWORD_HASH"),
    sessionSecret: environmentValue("SESSION_SECRET"),
    adminOrigin: environmentValue("ADMIN_ORIGIN"),
    observeUrl: environmentValue("OBSERVE_URL"),
    observeSecret: environmentValue("OBSERVE_SECRET"),
    alertUrl: environmentValue("ALERT_URL"),
    alertSecret: environmentValue("ALERT_SECRET"),
    deployMasterUrl: environmentValue("DEPLOY_MASTER_URL"),
    deploySecret: environmentValue("DEPLOY_SECRET"),
    backendUrl: environmentValue("BACKEND_URL"),
    logRedisUrl: environmentValue("LOG_REDIS_URL"),
    serverName: environmentValue("SERVER_NAME") || "admin",
  };
}

/** 로그인에 반드시 있어야 하는 설정 중 비었거나 쓸 수 없는 키의 이름. 하나라도 있으면 로그인은 전부 거절한다. */
export function missingLoginConfigKeys(config: ServerConfig): string[] {
  const missing: string[] = [];
  if (config.adminUser.length === 0) missing.push("ADMIN_USER");
  if (!config.adminPasswordHash.startsWith("$argon2id$")) missing.push("ADMIN_PASSWORD_HASH");
  if (config.sessionSecret.length < SESSION_SECRET_MINIMUM_LENGTH) missing.push("SESSION_SECRET");
  if (config.adminOrigin.length === 0) missing.push("ADMIN_ORIGIN");
  if (config.observeUrl.length === 0) missing.push("OBSERVE_URL");
  if (config.observeSecret.length === 0) missing.push("OBSERVE_SECRET");
  return missing;
}

/** 없어도 로그인은 되지만 기능이 줄어드는 설정(알림 · 다음 task 의 호출 대상 · 로그 스트림). */
export function missingOptionalConfigKeys(config: ServerConfig): string[] {
  const optional: [string, string][] = [
    ["ALERT_URL", config.alertUrl], ["ALERT_SECRET", config.alertSecret],
    ["DEPLOY_MASTER_URL", config.deployMasterUrl], ["DEPLOY_SECRET", config.deploySecret],
    ["BACKEND_URL", config.backendUrl], ["LOG_REDIS_URL", config.logRedisUrl],
  ];
  return optional.filter(([, value]) => value.length === 0).map(([name]) => name);
}

/** middleware·requireSession 이 쓰는 세션 서명 키 — 짧거나 비면 빈 문자열(어떤 쿠키도 세션이 아니다). */
export function sessionSigningKey(): string {
  const secret = environmentValue("SESSION_SECRET");
  return secret.length >= SESSION_SECRET_MINIMUM_LENGTH ? secret : "";
}
