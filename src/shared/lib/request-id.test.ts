/** ⑬ T2g — 추적의 ID 를 정하는 한 곳(통신 규약 §1.2 · §1.3). 어드민 nginx 는 앱으로 늘 자기가 만든 `$request_id`(16진 32자)를 넘긴다
 * (`deploy/nginx/nginx.conf:59` — 바깥이 보낸 값은 nginx 가 덮는다). 앱은 그 값을 믿되 꼴은 다시 본다(앱의 포트는 루프백에만 열려 있다 — `docker-compose.yml` 의 `127.0.0.1:1800x`).
 * 고정하는 계약(`@/shared/lib/request-id`):
 * - `REQUEST_ID_HEADER` = `X-Request-Id` · `REQUEST_ID_PATTERN` = `^[A-Za-z0-9_-]{1,64}$`(규약 1.2 — 밑줄을 받는다: 로그인의 옛 꼴 `^[A-Za-z0-9-]{1,64}$` 를 넓힌다).
 * - `newRequestId(): string` — 16진수 소문자 32자 · 부를 때마다 다르다(규약 1.2 "들어온 요청 없이 시작되는 호출").
 * - `incomingRequestId(headers: Headers): string` — 머리글(대소문자 무관)이 꼴에 맞으면 그 값, 없거나 틀리면 `newRequestId()` 꼴의 새 값.
 * - `serverRequestId(): Promise<string>` — 서버 컴포넌트용. `next/headers` 의 `headers()` 로 같은 규칙 · 요청 밖이라 던지면 새 값(던지지 않는다). */
import { afterEach, describe, expect, it, vi } from "vitest";

const nextHeaders = vi.hoisted(() => ({ current: null as Headers | null, throws: false }));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (nextHeaders.throws) throw new Error("`headers` was called outside a request scope");
    return nextHeaders.current ?? new Headers();
  },
}));

import { REQUEST_ID_HEADER, REQUEST_ID_PATTERN, incomingRequestId, newRequestId, serverRequestId } from "./request-id";

const NEW_ID = /^[0-9a-f]{32}$/;
const PROTOCOL = /^[A-Za-z0-9_-]{1,64}$/;

afterEach(() => { nextHeaders.current = null; nextHeaders.throws = false; });

describe("상수", () => {
  it("머리글 이름 X-Request-Id · 꼴 ^[A-Za-z0-9_-]{1,64}$", () => {
    expect(REQUEST_ID_HEADER).toBe("X-Request-Id");
    expect(REQUEST_ID_PATTERN.source).toBe("^[A-Za-z0-9_-]{1,64}$");
    expect(REQUEST_ID_PATTERN.flags).toBe("");
  });
});

describe("newRequestId — 16진수 소문자 32자", () => {
  it("꼴 · 부를 때마다 다르다", () => {
    const made = Array.from({ length: 50 }, () => newRequestId());
    for (const id of made) expect(id).toMatch(NEW_ID);
    expect(new Set(made).size).toBe(made.length);
  });
});

describe("incomingRequestId — 들어온 추적의 ID", () => {
  it.each([
    ["nginx 의 16진 32자", "0123456789abcdef0123456789abcdef"],
    ["한 글자", "a"],
    ["64자", "A".repeat(64)],
    ["밑줄(옛 로그인 꼴이 받지 않던 것)", "trace_from_nginx_01"],
    ["밑줄만", "_"],
    ["하이픈 · 대문자 · 숫자", "Trace-ID-01"],
    ["UUID 36자(옛 로그인이 만들던 꼴)", "123e4567-e89b-42d3-a456-426614174000"],
    ["front 의 꼴", "req-0123456789ab"],
    ["GitHub 배포의 꼴", "gh-123456789-1"],
  ])("꼴에 맞으면(%s) 그 값 그대로", (_label, value) => {
    expect(incomingRequestId(new Headers({ "x-request-id": value }))).toBe(value);
  });

  it("머리글 이름은 대소문자 무관", () => {
    expect(incomingRequestId(new Headers({ "X-REQUEST-ID": "trace01" }))).toBe("trace01");
    expect(incomingRequestId(new Headers({ "X-Request-Id": "trace02" }))).toBe("trace02");
  });

  it.each([
    ["없음", null],
    ["빈 값", ""],
    ["65자", "A".repeat(65)],
    ["아주 긴 값", "a".repeat(4096)],
    ["쌍점(로그의 구분자)", "abc:def"],
    ["빈칸", "abc def"],
    ["탭(제어 문자)", "abc\tdef"],
    ["그 밖의 제어 문자", "abc\u0001def"],
    ["DEL", "abc\u007fdef"],
    ["점", "abc.def"],
    ["쉼표로 이은 두 값", "abc, def"],
    ["CR/LF 를 흉내 낸 글자", "abc\\r\\nX-Injected: 1"],
    ["퍼센트로 쓴 줄바꿈", "abc%0d%0aX-Injected"],
    ["한글", "추적"],
    ["더하기 · 빗금(base64 꼴)", "abc+def/ghi="],
  ])("꼴이 틀리면(%s) 새 값 — 16진수 소문자 32자", (_label, value) => {
    const requestHeaders = new Headers();
    if (value !== null) {
      try { requestHeaders.set("x-request-id", value); } catch { /* 머리글에 실을 수 없는 글자 — 없는 것과 같다 */ }
    }
    const id = incomingRequestId(requestHeaders);
    expect(id).toMatch(NEW_ID);
    expect(id).toMatch(PROTOCOL);
    expect(id).not.toBe(value);
  });

  it("머리글이 두 번 오면(append — Headers.get 이 쉼표로 잇는다) 여러 값이라 새 값", () => {
    const requestHeaders = new Headers();
    requestHeaders.append("x-request-id", "trace-a");
    requestHeaders.append("x-request-id", "trace-b");
    const id = incomingRequestId(requestHeaders);
    expect(id).toMatch(NEW_ID);
    expect(id).not.toContain("trace-");
  });

  it("같은 값이 두 번 와도 새 값(하나로 줄이지 않는다)", () => {
    const requestHeaders = new Headers();
    requestHeaders.append("x-request-id", "trace-a");
    requestHeaders.append("x-request-id", "trace-a");
    expect(incomingRequestId(requestHeaders)).toMatch(NEW_ID);
  });

  it("새 값은 부를 때마다 다르다", () => {
    expect(incomingRequestId(new Headers())).not.toBe(incomingRequestId(new Headers()));
  });

  it("다른 머리글(X-Correlation-Id · traceparent)을 대신 쓰지 않는다", () => {
    const id = incomingRequestId(new Headers({ "x-correlation-id": "corr-01", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }));
    expect(id).toMatch(NEW_ID);
  });
});

describe("serverRequestId — 서버 컴포넌트", () => {
  it("next/headers 의 X-Request-Id 가 꼴에 맞으면 그 값(밑줄 포함)", async () => {
    nextHeaders.current = new Headers({ "x-request-id": "trace_from_nginx_01" });
    expect(await serverRequestId()).toBe("trace_from_nginx_01");
  });

  it("꼴이 틀리면 새 값", async () => {
    nextHeaders.current = new Headers({ "x-request-id": "bad:value" });
    expect(await serverRequestId()).toMatch(NEW_ID);
  });

  it("없으면 새 값", async () => {
    nextHeaders.current = new Headers();
    expect(await serverRequestId()).toMatch(NEW_ID);
  });

  it("요청 밖이라 headers() 가 던지면 새 값(던지지 않는다)", async () => {
    nextHeaders.throws = true;
    expect(await serverRequestId()).toMatch(NEW_ID);
  });
});
