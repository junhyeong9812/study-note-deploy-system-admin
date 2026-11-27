/** 추적의 ID(`X-Request-Id`)를 정하는 한 곳 — 서버 전용(route 핸들러 · 서버 컴포넌트 · 그 아래의 클라이언트). 통신 규약 §1.2 · §1.3 · 1.4 #7(⑬ T2g).
 * 어드민 nginx 가 넘긴 값(`proxy_set_header X-Request-Id $request_id`)을 믿되 꼴은 다시 본다. 꼴이 틀리거나 없으면 16진수 소문자 32자를 새로 만든다.
 * 뼈대 — 구현은 구현 워커가 한다(테스트: request-id.test.ts · src/app/request-id-calls.test.ts). */
import { headers } from "next/headers";

/** 머리글 이름(읽기는 대소문자 무관). */
export const REQUEST_ID_HEADER = "X-Request-Id";

/** 규약의 꼴 — 밑줄 포함 · 1~64자 · 로그 한 줄의 구분자 `:` 가 들어갈 수 없다. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 새 추적 ID — 16진수 소문자 32자(nginx 의 `$request_id` 와 같은 꼴). 부를 때마다 새 값. */
export function newRequestId(): string {
  throw new Error("not implemented — ⑬ T2g newRequestId");
}

/** 요청의 머리글에서 추적의 ID — `X-Request-Id` 가 꼴에 맞으면 그 값, 없거나 틀리면(여러 값 · 너무 긴 것 · 제어 문자 · 빈 값) 새 값. */
export function incomingRequestId(requestHeaders: Headers): string {
  void requestHeaders;
  throw new Error("not implemented — ⑬ T2g incomingRequestId");
}

/** 서버 컴포넌트에서 — `next/headers` 의 `headers()` 로 같은 규칙. 요청 밖(headers() 가 던짐)이면 새 값(던지지 않는다). */
export async function serverRequestId(): Promise<string> {
  void headers;
  throw new Error("not implemented — ⑬ T2g serverRequestId");
}
