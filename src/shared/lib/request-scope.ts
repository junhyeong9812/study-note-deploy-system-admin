/** 그 요청의 추적 ID 를 요청의 길 따라 넘기는 범위(⑬ T2g · 통신 규약 §1.2) — 서버 전용 · 순수(Next 를 읽지 않는다: 범위는 진입에서 연다 — request-id 의 inRequestScope).
 * 우리 서비스로 가는 호출(getUpstream · 직접 fetch 하는 클라이언트)과 그 요청의 로그 줄이 currentRequestId() 로 같은 값을 쓴다.
 * 범위 밖(들어온 요청 없이 시작되는 호출 — 통신 지도의 허브 · 의존 조회는 바퀴마다 새 범위를 연다)이면 부를 때마다 새 값. 모듈 전역에 값을 두지 않는다(겹친 요청이 섞이지 않게). */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/** 머리글 이름(읽기는 대소문자 무관). */
export const REQUEST_ID_HEADER = "X-Request-Id";

const REQUEST_ID_BYTES = 16;
const requestIdScope = new AsyncLocalStorage<string>();

/** 새 추적 ID — 16진수 소문자 32자(nginx 의 `$request_id` 와 같은 꼴). 부를 때마다 새 값. */
export function newRequestId(): string {
  return randomBytes(REQUEST_ID_BYTES).toString("hex");
}

/** run 을 그 추적 ID 의 범위 안에서 — 그 안의 비동기 일(await · 타이머)까지 같은 값을 본다. 안쪽에서 다시 열면 안쪽의 값. */
export function runWithRequestId<Value>(requestId: string, run: () => Value): Value {
  return requestIdScope.run(requestId, run);
}

/** 지금 범위의 추적 ID — 범위 밖이면 새 값(부를 때마다 다르다). */
export function currentRequestId(): string {
  return requestIdScope.getStore() ?? newRequestId();
}

/** 우리 서비스로 가는 호출의 머리글에 그 범위의 추적 ID 를 싣는다(set — 늘 하나). 바깥(GitHub)으로 가는 호출에는 부르지 않는다. */
export function withRequestId(headers: Headers): Headers {
  headers.set(REQUEST_ID_HEADER, currentRequestId());
  return headers;
}
