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

/** 기본 기한 — setTimeout(가짜 타이머로 몰 수 있다). 프로세스 종료를 붙잡지 않는다. */
function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    (timer as { unref?: () => void }).unref?.();
  });
}

const DEADLINE_PASSED: unique symbol = Symbol("deadline-passed");

/** 상한 · 기한 안에서 본문 바이트를 모은다. 넘으면 null(스트림을 끊는다). */
async function readBoundedBytes(request: Request, delay: (milliseconds: number) => Promise<void>): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const deadline = delay(LOGIN_BODY_DEADLINE_MILLISECONDS).then(() => DEADLINE_PASSED);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (typeof next === "symbol") {
        reader.cancel().catch(() => undefined);
        return null;
      }
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > LOGIN_BODY_MAX_BYTES) {
        reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    reader.cancel().catch(() => undefined);
    return null;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** {id, password} 또는 null(형식 오류 · content-type 이 JSON 아님 · 상한 초과 · 기한 초과). 상한을 넘으면 더 읽지 않고 스트림을 끊는다. */
export async function readLoginBody(request: Request, options: LoginBodyOptions = {}): Promise<{ id: string; password: string } | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    request.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await readBoundedBytes(request, options.delay ?? defaultDelay);
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { id, password } = parsed as Record<string, unknown>;
  if (typeof id !== "string" || typeof password !== "string") return null;
  if (id.length > LOGIN_ID_MAX_LENGTH || password.length > LOGIN_PASSWORD_MAX_LENGTH) return null;
  return { id, password };
}
