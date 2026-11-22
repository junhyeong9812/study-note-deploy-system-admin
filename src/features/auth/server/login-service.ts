/** 로그인 흐름의 프로세스 단일 인스턴스 — 속도 제한 · 임시 제한 · 대기열이 프로세스 안에 하나만 있게 한다.
 * globalThis 에 둔다: 개발 모드의 모듈 재로딩과 라우트별 묶음에서도 같은 인스턴스를 쓴다. */
import "server-only";
import { randomUUID } from "node:crypto";
import { createAlertClient } from "@/features/auth/lib/alert-client";
import { createAttemptQueue, type AttemptQueue } from "@/features/auth/lib/attempt-queue";
import { createLoginFlow, type LoginFlow } from "@/features/auth/lib/login-flow";
import { createObserveClient } from "@/features/auth/lib/observe-client";
import { verifyArgon2idPassword } from "@/features/auth/lib/password-hash";
import { createRateLimiter } from "@/features/auth/lib/rate-limit";
import { createTemporaryLockout } from "@/features/auth/lib/temporary-lockout";
import { missingOrUnreadableLoginConfigKeys } from "@/shared/config/login-config-check";
import { readServerConfig } from "@/shared/config/server-config";
import { log } from "@/shared/lib/logger";

export interface LoginService {
  /** 필수 설정이 없거나 틀리면 null — 정상 구동에서는 닿지 않는다(그런 설정이면 서버가 뜨지 않는다). 닿으면 로그인 401 거절만. */
  flow: LoginFlow | null;
  /** 관측 서버 장애 중의 기록 대기열(종료 로그가 건수를 읽는다). 설정이 틀리면 null. */
  attemptQueue: AttemptQueue | null;
}

const GLOBAL_KEY = Symbol.for("study-note-admin.login-service");

interface GlobalHolder {
  [GLOBAL_KEY]?: LoginService;
  [key: symbol]: unknown;
}

function createLoginService(): LoginService {
  const config = readServerConfig();
  const missing = missingOrUnreadableLoginConfigKeys(config);
  if (missing.length > 0) {
    void log("login-service", `login:disabled 설정 없음 keys=${missing.join(",")}`, "error");
    return { flow: null, attemptQueue: null };
  }
  const clock = () => Date.now();
  const attemptQueue = createAttemptQueue();
  const flow = createLoginFlow({
    clock,
    newAttemptId: () => randomUUID(),
    account: { adminId: config.adminUser, passwordHash: config.adminPasswordHash },
    verifyPassword: verifyArgon2idPassword,
    sessionSigningKey: config.sessionSecret,
    configuredOrigin: config.adminOrigin,
    rateLimiter: createRateLimiter({ clock }),
    temporaryLockout: createTemporaryLockout({ clock }),
    attemptQueue,
    observeClient: createObserveClient({ baseUrl: config.observeUrl, secret: config.observeSecret, clock, fetch: (input, init) => fetch(input, init) }),
    alertClient: createAlertClient({ baseUrl: config.alertUrl, secret: config.alertSecret, fetch: (input, init) => fetch(input, init) }),
    logger: log,
  });
  return { flow, attemptQueue };
}

/** 이미 만들어진 인스턴스만 — 없으면 null(만들지 않는다). 종료 로그용. */
export function existingLoginService(): LoginService | null {
  return (globalThis as unknown as GlobalHolder)[GLOBAL_KEY] ?? null;
}

export function loginService(): LoginService {
  const holder = globalThis as unknown as GlobalHolder;
  if (holder[GLOBAL_KEY] === undefined) holder[GLOBAL_KEY] = createLoginService();
  return holder[GLOBAL_KEY];
}
