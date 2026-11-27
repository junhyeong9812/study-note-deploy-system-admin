/** 추적의 ID(`X-Request-Id`)를 정하는 한 곳 — 서버 전용(route 핸들러 · 서버 컴포넌트 · 그 아래의 클라이언트). 통신 규약 §1.2 · §1.3 · 1.4 #7(⑬ T2g).
 * 어드민 nginx 가 넘긴 값(`proxy_set_header X-Request-Id $request_id`)을 믿되 꼴은 다시 본다. 꼴이 틀리거나 없으면 16진수 소문자 32자를 새로 만든다.
 * 진입(화면 · 데이터 경로의 진입 함수)은 inRequestScope 로 그 요청의 값을 범위로 열고, 그 아래의 호출 · 로그는 request-scope 의 currentRequestId 로 같은 값을 쓴다. */
import { headers } from "next/headers";
import { REQUEST_ID_HEADER, newRequestId, runWithRequestId } from "@/shared/lib/request-scope";

export { REQUEST_ID_HEADER, newRequestId };

/** 규약의 꼴 — 밑줄 포함 · 1~64자 · 로그 한 줄의 구분자 `:` 가 들어갈 수 없다. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 요청의 머리글에서 추적의 ID — `X-Request-Id` 가 꼴에 맞으면 그 값, 없거나 틀리면(여러 값 · 너무 긴 것 · 제어 문자 · 빈 값) 새 값. */
export function incomingRequestId(requestHeaders: Headers): string {
  const value = requestHeaders.get(REQUEST_ID_HEADER);
  return value !== null && REQUEST_ID_PATTERN.test(value) ? value : newRequestId();
}

/** 요청의 머리글 객체마다 정한 값 — 한 요청에서 진입 함수 둘이 나란히 불려도(꼴이 틀려 새로 만든 값까지) 같은 값이 되게. 머리글 객체가 사라지면 함께 사라진다. */
const requestIdByHeaders = new WeakMap<object, string>();

/** 서버 컴포넌트 · route 핸들러에서 — `next/headers` 의 `headers()` 로 같은 규칙. 요청 밖(headers() 가 던짐)이면 새 값(던지지 않는다). */
export async function serverRequestId(): Promise<string> {
  let requestHeaders: Headers;
  try {
    requestHeaders = await headers();
  } catch {
    return newRequestId();
  }
  const known = requestIdByHeaders.get(requestHeaders);
  if (known !== undefined) return known;
  const requestId = incomingRequestId(requestHeaders);
  requestIdByHeaders.set(requestHeaders, requestId);
  return requestId;
}

/** 진입 함수의 몸을 그 요청의 추적 ID 범위 안에서 — 그 안의 우리 서비스 호출과 로그 줄이 모두 그 값. */
export async function inRequestScope<Value>(run: () => Promise<Value>): Promise<Value> {
  return runWithRequestId(await serverRequestId(), run);
}
