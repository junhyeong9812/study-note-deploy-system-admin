/** 로그인 시도 기록 화면의 판정과 글자(순수) — 데이터 계층이 준 값(시도 목록 · 잠금 상태)을 화면의 갈래 · 기호 · 설명 글자로 옮긴다.
 * 결과 낱말의 뜻은 관측 서버(observe auth/AuthAttempt.kt — 잠금 판정 · 결과 낱말)와 어드민 로그인 흐름(auth/lib/login-flow.ts — 거절 이유와 HTTP 상태),
 * 명세 ②(기록 범위 · 잠금 · replayed)에서 옮겼다. 받은 값만 쓰고 없는 값을 짓지 않는다. */
import type { LockStatusView, LoginAttemptOutcome } from "@/features/login-attempts/lib/login-attempts-query";
import type { UpstreamFailure, UpstreamResult } from "@/shared/lib/upstream-result";

/** 관측 서버의 잠금 수치(observe AuthAttempt.kt — 명세 ② "연속 5회 실패 → 15분 잠금"). 화면 설명 글자에만 쓴다(판정은 관측 서버가 한다). */
export const OBSERVE_FAILURE_LIMIT = 5;
export const OBSERVE_LOCK_MINUTES = 15;

/** 결과의 갈래 — 색 + 기호 + 글자로 보인다(색만으로 가르지 않는다). 거절 = 자격 확인 전에 막은 것(세 이유). */
export type AttemptTone = "success" | "failure" | "locked" | "rejected";

export interface OutcomeDescription {
  label: string;
  mark: string;
  tone: AttemptTone;
  meaning: string;
}

/** 결과 낱말(LOGIN_ATTEMPT_OUTCOMES 전부) → 화면 글자. */
export const OUTCOME_DESCRIPTIONS: Readonly<Record<LoginAttemptOutcome, OutcomeDescription>> = {
  success: { label: "성공", mark: "✓", tone: "success", meaning: "ID · 비밀번호가 맞아 로그인함(연속 실패 횟수가 0 이 됨)" },
  failure: {
    label: "실패", mark: "✕", tone: "failure",
    meaning: `ID 나 비밀번호가 틀림 — 연속 실패에 듦(${OBSERVE_FAILURE_LIMIT}회면 ${OBSERVE_LOCK_MINUTES}분 잠금, 잠금을 건 그 시도도 실패로 남음)`,
  },
  locked: { label: "잠금 중 거절", mark: "!", tone: "locked", meaning: "잠금 중이라 자격과 상관없이 거절함(횟수에 들지 않고 잠금을 늘리지 않음)" },
  rate_limited: { label: "거절 · 속도 제한", mark: "⊘", tone: "rejected", meaning: "같은 IP 가 1분에 10회를 넘어 자격 확인 전에 거절함(HTTP 429)" },
  origin_rejected: { label: "거절 · 출처 다름", mark: "⊘", tone: "rejected", meaning: "요청 출처(Origin)가 어드민 주소와 달라 자격 확인 전에 거절함(HTTP 403)" },
  malformed: { label: "거절 · 형식 오류", mark: "⊘", tone: "rejected", meaning: "요청 본문의 형식이 맞지 않아 자격 확인 전에 거절함(HTTP 400)" },
};

/** "나중에 보낸 기록"(replayed) 표시. */
export const REPLAYED_DESCRIPTION = {
  label: "나중에 보낸 기록",
  mark: "↻",
  meaning: "관측 서버에 닿지 않던 동안 어드민이 임시 제한으로 판정해 두었다가 복귀 뒤 보낸 기록 — 시각은 원래 시각, 잠금 계산에는 넣지 않음",
} as const;

/** 다른 서버 실패의 화면 글자 — 고정 사유(upstream-result 의 표 그대로)와 받은 HTTP 상태만. 다른 서버의 글자는 섞지 않는다. */
export function failureText(failure: UpstreamFailure): string {
  return failure.status === undefined ? failure.message : `${failure.message} · HTTP ${failure.status}`;
}

/** 현재 잠금 상태의 화면 갈래.
 * - unknown: 잠금 조회만 실패(목록과 무관) — 그 자리만 "확인 못 함".
 * - locked: 잠김 — 풀리는 시각(관측 서버가 주지 않았으면 null)과 연속 실패 횟수.
 * - unlocked: 잠기지 않음 — 연속 실패 횟수와 잠금까지 남은 횟수(0 아래로 내려가지 않는다). */
export type LockStatusDescription =
  | { kind: "unknown"; detail: string }
  | { kind: "locked"; lockedUntil: string | null; failures: number }
  | { kind: "unlocked"; failures: number; remaining: number };

export function describeLockStatus(result: UpstreamResult<LockStatusView>): LockStatusDescription {
  if (!result.ok) return { kind: "unknown", detail: `관측 서버: ${failureText(result)}` };
  const { locked, lockedUntil, failures } = result.value;
  if (locked) return { kind: "locked", lockedUntil, failures };
  return { kind: "unlocked", failures, remaining: Math.max(0, OBSERVE_FAILURE_LIMIT - failures) };
}

/** 표에 보이는 User-Agent 의 길이(코드 포인트). 넘으면 앞부분 + "…" 를 보이고 전체는 펼쳐 본다. */
export const USER_AGENT_VISIBLE_LENGTH = 60;

/** User-Agent → 표의 줄인 글자(코드 포인트 기준 — 서로게이트 쌍을 가르지 않는다). 줄였으면 truncated. 빈 글자는 빈 글자. */
export function shortUserAgent(userAgent: string): { text: string; truncated: boolean } {
  const codePoints = Array.from(userAgent);
  if (codePoints.length <= USER_AGENT_VISIBLE_LENGTH) return { text: userAgent, truncated: false };
  return { text: `${codePoints.slice(0, USER_AGENT_VISIBLE_LENGTH).join("")}…`, truncated: true };
}
