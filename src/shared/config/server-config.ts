/** 설정 읽기 — 비밀값이 든 환경 변수는 이 모듈만 읽는다. 서버 쪽 전용(클라이언트 묶음에 들어가면 빌드가 실패한다).
 * 값은 로그·응답에 내지 않는다. 비었거나 형식이 틀린 키는 "이름만" 알린다.
 * 필수 설정이 없거나 형식이 틀리면 서버가 뜨지 않는다(종료 코드 78 — startup-check). middleware 도 이 모듈을 읽으므로 argon2 를 임포트하지 않는다. */
import "server-only";
import { hasRequiredHashCost } from "@/features/auth/lib/credentials";

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

/** ADMIN_ORIGIN 의 형식 — https 이고 출처 꼴 그대로(`new URL(값).origin === 값`. 끝의 `/` · 경로 · 쿼리 · scheme 없음 · 대문자 호스트는 틀림). */
export function isValidAdminOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return parsed.protocol === "https:" && parsed.origin === value;
}

/** OBSERVE_URL 의 형식 — 해석되는 http(s) 주소(끝의 `/` 허용). */
export function isValidObserveUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
}

/** 로그인에 반드시 있어야 하는 설정 중 비었거나 형식이 틀린 키의 이름(해시는 비용 머리까지 — 라이브러리 해석은
 * login-config-check 가 더한다). 하나라도 있으면 서버가 뜨지 않는다(시작 검사) · 헬스 503 · 로그인 거절. */
export function missingLoginConfigKeys(config: ServerConfig): string[] {
  const missing: string[] = [];
  if (config.adminUser.length === 0) missing.push("ADMIN_USER");
  // 해시 비용(m·t·p)이 더미 해시와 다르면 설정 없음과 같다(세부 2) — 값은 어디에도 찍지 않는다
  if (!hasRequiredHashCost(config.adminPasswordHash)) missing.push("ADMIN_PASSWORD_HASH");
  if (config.sessionSecret.length < SESSION_SECRET_MINIMUM_LENGTH) missing.push("SESSION_SECRET");
  if (!isValidAdminOrigin(config.adminOrigin)) missing.push("ADMIN_ORIGIN");
  if (!isValidObserveUrl(config.observeUrl)) missing.push("OBSERVE_URL");
  if (config.observeSecret.length === 0) missing.push("OBSERVE_SECRET");
  return missing;
}

/** 판정 11-22(15번) — 화면 넷 · 잠금 알림이 부르는 서버의 설정도 필수다("설정이 비어 있으면 구동을 못 하게").
 * DEPLOY_MASTER_URL · BACKEND_URL · ALERT_URL 은 해석되는 http(s) 주소(끝의 `/` 허용 — isValidObserveUrl 과 같은 규칙), DEPLOY_SECRET · ALERT_SECRET 은 비지 않은 값.
 * 어긋난 키의 이름을 이 순서로 돌려준다. 로그인 판정(missingLoginConfigKeys)에는 넣지 않는다 — 시작 검사(startup-check)와 헬스가 둘을 합쳐 본다.
 * (화면 진입 함수의 "그 칸만 설정 없음"은 실행 중 방어로 남는다 — 정상 구동에서는 닿지 않는다.) */
export function missingScreenConfigKeys(config: ServerConfig): string[] {
  void config;
  throw new Error("not implemented");
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
