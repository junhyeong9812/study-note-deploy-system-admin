/** 테스트 전용 — 화면 넷의 서버 쪽 데이터 계층 사례가 함께 쓰는 가짜. 주소는 문서용 도메인(.test), 비밀값은 명백한 가짜.
 * 시간은 vi.useFakeTimers 의 setTimeout 으로만 흐른다(실제 대기 없음). */
import { expect, vi } from "vitest";
import { UPSTREAM_FAILURE_MESSAGES, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const FAKE_DEPLOY_MASTER_URL = "http://deploy-master.example.test:15000";
export const FAKE_DEPLOY_SECRET = "fake-deploy-secret-marker-d41";
export const FAKE_OBSERVE_URL = "http://observe.example.test:17000";
export const FAKE_OBSERVE_SECRET = "fake-observe-secret-marker-o52";
export const FAKE_ALERT_URL = "http://alert.example.test:16000";
export const FAKE_ALERT_SECRET = "fake-alert-secret-marker-a63";
export const FAKE_BACKEND_URL = "http://backend.example.test:8080";

/** 다른 서버의 오류 본문 · 예외 문구에 일부러 넣는 표식 — 결과에 나오면 원문을 흘린 것이다. */
export const UPSTREAM_RAW_MARKER = "raw-upstream-text-marker-zz9";

export const SECRET_HEADER_NAMES = ["x-deploy-secret", "x-observe-secret", "x-alert-secret"] as const;

/** 결과 어디에도 나오면 안 되는 글자 — 비밀값 · 다른 서버의 주소(호스트) · 비밀 헤더 이름 · 원문 표식. */
export const FORBIDDEN_IN_RESULTS: readonly string[] = [
  FAKE_DEPLOY_SECRET, FAKE_OBSERVE_SECRET, FAKE_ALERT_SECRET,
  "deploy-master.example.test", "observe.example.test", "alert.example.test", "backend.example.test",
  "X-Deploy-Secret", "X-Observe-Secret", "X-Alert-Secret", "x-deploy-secret", "x-observe-secret", "x-alert-secret",
  UPSTREAM_RAW_MARKER,
];

export function expectNoForbiddenText(value: unknown, forbidden: readonly string[] = FORBIDDEN_IN_RESULTS) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  for (const word of forbidden) expect(text, `결과에 ${word} 가 들어 있다`).not.toContain(word);
}

/** 오류 본문 — 비밀값 · 주소 · 표식을 일부러 담는다(다른 서버가 이상한 글자를 돌려주는 경우). */
export function leakyErrorBody(): string {
  return JSON.stringify({
    success: false,
    error: { code: "boom", detail: `${UPSTREAM_RAW_MARKER} ${FAKE_DEPLOY_SECRET} ${FAKE_OBSERVE_SECRET} ${FAKE_ALERT_SECRET} ${FAKE_DEPLOY_MASTER_URL} ${FAKE_OBSERVE_URL} ${FAKE_ALERT_URL} ${FAKE_BACKEND_URL}` },
    status: `${UPSTREAM_RAW_MARKER}`,
  });
}

export function leakyNetworkError(): Error {
  const error = new TypeError(`fetch failed ${UPSTREAM_RAW_MARKER} ${FAKE_DEPLOY_MASTER_URL} ${FAKE_OBSERVE_URL} ${FAKE_ALERT_URL} ${FAKE_BACKEND_URL} ${FAKE_DEPLOY_SECRET} ${FAKE_OBSERVE_SECRET} ${FAKE_ALERT_SECRET}`);
  return error;
}

export function textResponse(body: string, status = 200, contentType = "application/json"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

export function jsonBody(body: unknown, status = 200): Response {
  return textResponse(JSON.stringify(body), status);
}

/** 가짜 타이머(setTimeout)로 끊기는 제한 시간 신호 — 요청받은 밀리초를 남긴다. */
export function createTimerTimeoutSignal() {
  const requestedMilliseconds: number[] = [];
  const factory = (milliseconds: number): AbortSignal => {
    requestedMilliseconds.push(milliseconds);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), milliseconds);
    return controller.signal;
  };
  return { factory, requestedMilliseconds };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

/** 응답하지 않는 서버 — 신호가 끊길 때까지 기다렸다가 실제 fetch 처럼 그 이유로 거부한다. */
export function hangUntilAborted(init: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const signal = init.signal;
    if (!signal) return;   // 신호 없이 부르면 영원히 끝나지 않는다(기한을 걸지 않은 구현은 사례가 끝나지 않아 빨강)
    if (signal.aborted) { reject(abortReason(signal)); return; }
    signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
  });
}

/** 머리글은 곧바로 주고 본문은 끝내지 않는 서버 — 실제 fetch 처럼 신호가 끊기면 본문 읽기가 그 이유로 실패한다. */
export function headersThenStalledBody(init: RequestInit, status = 200): Response {
  const signal = init.signal;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{\"success\":true,"));
      signal?.addEventListener("abort", () => controller.error(abortReason(signal)), { once: true });
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "application/json" } });
}

/** milliseconds 뒤에 응답한다(가짜 타이머). 그 전에 신호가 끊기면 거부. */
export function respondAfter(milliseconds: number, makeResponse: () => Response, init: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(makeResponse()), milliseconds);
    init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(abortReason(init.signal!)); }, { once: true });
  });
}

export type RoutedFetchHandler = (url: URL, init: RequestInit) => Promise<Response> | Response;

/** 주소를 보고 답하는 fetch 가짜 — 받은 요청(주소 · init)을 남긴다. 처리기가 동기로 던져도 그대로 던진다. */
export function createRoutedFetch(handler: RoutedFetchHandler) {
  return vi.fn((input: string, init: RequestInit = {}): Promise<Response> => {
    const result = handler(new URL(input), init);
    return result instanceof Response ? Promise.resolve(result) : result;
  });
}

export function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? {});
}

/** 읽기 전용 — GET 만, 본문 없음. */
export function expectReadOnlyRequest(init: RequestInit | undefined) {
  expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
  expect(init?.body ?? null).toBeNull();
}

/** 실패 결과의 꼴 — reason 이 맞고 message 는 고정 표의 글자 그대로, 다른 서버의 글자 없음. */
export function expectFailure(result: UpstreamFailure | { ok: true }, reason: string, status?: number) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe(reason);
  expect(result.message).toBe(UPSTREAM_FAILURE_MESSAGES[result.reason]);
  if (status !== undefined) expect(result.status).toBe(status);
  expect(result).not.toHaveProperty("value");
  expectNoForbiddenText(result);
}

/** 성공 결과의 값을 꺼낸다(실패면 사례 실패). */
export function okValue<Value>(result: UpstreamResult<Value>): Value {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error("expected ok");
  return result.value;
}

/** 아직 끝나지 않았는지 볼 수 있게 감싼다. */
export function track<Value>(promise: Promise<Value>) {
  const state = { settled: false, value: undefined as Value | undefined, error: undefined as unknown };
  promise.then((value) => { state.settled = true; state.value = value; }, (error) => { state.settled = true; state.error = error; });
  return state;
}
