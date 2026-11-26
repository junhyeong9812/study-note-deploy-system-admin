/** 설정 읽기 — 비밀값이 든 환경 변수는 이 모듈만 읽는다. 서버 쪽 전용(클라이언트 묶음에 들어가면 빌드가 실패한다).
 * 값은 로그·응답에 내지 않는다. 비었거나 형식이 틀린 키는 "이름만" 알린다.
 * 필수 설정이 없거나 형식이 틀리면 서버가 뜨지 않는다(종료 코드 78 — startup-check). middleware 도 이 모듈을 읽으므로 argon2 를 임포트하지 않는다. */
import "server-only";
import { hasRequiredHashCost } from "@/features/auth/lib/credentials";
import { isHttpBaseUrl } from "@/shared/lib/upstream-fetch";

export interface ServerConfig {
  adminUser: string;
  adminPasswordHash: string;
  sessionSecret: string;
  adminOrigin: string;
  observeUrl: string;
  observeSecret: string;
  alertUrl: string;
  alertSecret: string;
  // 화면 넷이 부르는 서버(배포 이력 · 상태 한눈에) — 필수(missingScreenConfigKeys)
  deployMasterUrl: string;
  deploySecret: string;
  backendUrl: string;
  logRedisUrl: string;
  /** GitHub REST API 토큰(배포 상세 task 07) — **선택**: 비어 있어도 뜬다(익명 한도). 값은 로그 · 응답 · 오류 문구에 내지 않는다. */
  githubToken: string;
  /** Claude 실행 자리(사용량 · 상한 화면 — GET /usage · GET/PUT /limits · GET /health) — **선택**: 비어 있어도 뜬다(실행 자리가 배포되기 전에도 어드민이 뜬다).
   * 비면 그 화면의 칸이 "설정 없음". 설정용 비밀값은 머리글로만 싣고 로그 · 응답 · 오류 문구에 내지 않는다. */
  claudeRunnerUrl: string;
  claudeRunnerSettingsSecret: string;
  /** 실행 자리의 **호출용** 비밀값(X-Claude-Runner-Secret — 문제 화면의 분석 POST /runs) — **선택**: 비면 분석을 시작하지 않는다(503 "설정 없음").
   * 설정용 비밀값과 다른 값. 머리글로만 싣고 로그 · 응답 · 오류 문구에 내지 않는다. */
  claudeRunnerCallSecret: string;
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
    githubToken: environmentValue("GITHUB_TOKEN"),
    claudeRunnerUrl: environmentValue("CLAUDE_RUNNER_URL"),
    claudeRunnerSettingsSecret: environmentValue("CLAUDE_RUNNER_SETTINGS_SECRET"),
    claudeRunnerCallSecret: environmentValue("CLAUDE_RUNNER_SECRET"),
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
  return isHttpBaseUrl(value);
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
  const missing: string[] = [];
  if (!isHttpBaseUrl(config.deployMasterUrl)) missing.push("DEPLOY_MASTER_URL");
  if (config.deploySecret.length === 0) missing.push("DEPLOY_SECRET");
  if (!isHttpBaseUrl(config.backendUrl)) missing.push("BACKEND_URL");
  if (!isHttpBaseUrl(config.alertUrl)) missing.push("ALERT_URL");
  if (config.alertSecret.length === 0) missing.push("ALERT_SECRET");
  return missing;
}

/** 없어도 뜨는 설정 — 남은 것은 로그 스트림(LOG_REDIS_URL — 비면 stdout 만)뿐이다(판정 11-22 15번). */
export function missingOptionalConfigKeys(config: ServerConfig): string[] {
  return config.logRedisUrl.length === 0 ? ["LOG_REDIS_URL"] : [];
}

/** middleware·requireSession 이 쓰는 세션 서명 키 — 짧거나 비면 빈 문자열(어떤 쿠키도 세션이 아니다). */
export function sessionSigningKey(): string {
  const secret = environmentValue("SESSION_SECRET");
  return secret.length >= SESSION_SECRET_MINIMUM_LENGTH ? secret : "";
}
