/** 세부 3 — 로그인 본문 읽기. 읽으면서 바이트 상한(4KB)과 시간 기한(3초)을 적용한다(다 읽은 뒤 재지 않는다).
 * Route Handler 는 Origin 검사 · 속도 제한 뒤에만 이것을 부른다(LoginInput.readCredentials 로 넘긴다). */

export const LOGIN_BODY_MAX_BYTES = 4_096;
export const LOGIN_BODY_DEADLINE_MILLISECONDS = 3_000;
export const LOGIN_ID_MAX_LENGTH = 200;
export const LOGIN_PASSWORD_MAX_LENGTH = 1_024;

export interface LoginBodyOptions {
  /** 기한용 — milliseconds 뒤에 끝나는 약속. 기본은 setTimeout(테스트는 가짜 타이머 또는 직접 끝내는 Fake). */
  delay?: (milliseconds: number) => Promise<void>;
}

/** {id, password} 또는 null(형식 오류 · content-type 이 JSON 아님 · 상한 초과 · 기한 초과). 상한을 넘으면 더 읽지 않고 스트림을 끊는다. */
export async function readLoginBody(request: Request, options: LoginBodyOptions = {}): Promise<{ id: string; password: string } | null> {
  throw new Error("not implemented");
}
