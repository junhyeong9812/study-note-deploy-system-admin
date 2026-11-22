/** 인증 모듈이 함께 쓰는 형태. 시계·네트워크·로거는 전부 주입한다(테스트에서 Fake 로 바꾼다). */

/** 현재 시각(epoch 밀리초). */
export type Clock = () => number;

/** 앱 로그 — front `src/shared/lib/logger.ts` 의 `log(requestId, message, level)` 와 같은 모양.
 * 넘기는 문자열에 IP · 입력 ID · 비밀번호 · User-Agent 를 넣지 않는다(명세 ② 세부). */
export type AppLogger = (requestId: string, message: string, level?: "info" | "warning" | "error") => void | Promise<void>;

/** 전역 fetch 와 같은 모양 — 주입해서 Fake 로 바꾼다. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 제한 시간 신호를 만드는 함수 — 기본 `AbortSignal.timeout`. 테스트는 직접 끊을 수 있는 신호를 준다. */
export type TimeoutSignalFactory = (milliseconds: number) => AbortSignal;

/** argon2id 검증 — (저장된 해시, 입력 비밀번호) → 맞음 여부. */
export type PasswordVerifier = (passwordHash: string, password: string) => Promise<boolean>;

/** 시도의 결과 낱말 — 관측 서버 판정과 재전송 본문의 `outcome`. */
export type AttemptOutcome = "success" | "failure" | "locked";

/** 관측 서버 `POST /auth/attempts` 의 판정(응답 data). 임시 제한도 같은 모양으로 답한다.
 * 잠금을 건 그 시도는 outcome:"failure" + lockStarted:true(그 시도 자체는 실패) — 어드민 응답은 잠금(423). */
export interface AttemptVerdict {
  allowed: boolean;
  outcome: AttemptOutcome;
  lockedUntil: string | null;   // ISO-8601
  lockStarted: boolean;
  failures: number;
}

/** 관측 서버 `POST /auth/attempts` 본문(전송 형식 그대로 — snake_case). */
export interface AttemptRecordBody {
  attempt_id: string;
  at: string;                    // ISO-8601
  credential_ok: boolean;
  ip: string;
  user_agent: string;            // 앞 200자
  replayed: boolean;
  /** 세부 2: replayed:true 면 필수(임시 제한이 실제로 내린 판정), replayed:false 면 보내지 않는다(키 자체가 없다). */
  outcome?: AttemptOutcome;
}

/** 자격 검증 전에 거절한 이유(세부 2 — 기록 범위). */
export type RejectionReason = "rate_limited" | "origin_rejected" | "malformed";

/** 관측 서버 `POST /auth/attempts/rejected` 본문. IP 마다 60초 창에 이유별 첫 1건만 보낸다. */
export interface RejectedAttemptBody {
  attempt_id: string;
  at: string;
  reason: RejectionReason;
  ip: string;
  user_agent: string;
}
