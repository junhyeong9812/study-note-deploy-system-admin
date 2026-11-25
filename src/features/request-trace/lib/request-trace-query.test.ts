/** 요청 추적의 입력 검증 — 지금 있는 서비스들이 실제로 만드는 요청 ID 의 꼴은 모두 받고, 관측 서버가 저장하지 않는 꼴은 부르기 전에 거절한다.
 * 받는 꼴(관측 서버 api/LogController.kt REQUEST_ID · log/LogEntry.kt LogLineParser 와 같은 `^[A-Za-z0-9_.-]{1,80}$`):
 * front `req-` + 12자 16진(src/shared/api/backend.ts newRequestId) · backend `req-` + UUID 앞 12자(shared/infra/RequestLog.kt newRequestId — 8자 뒤에 `-`) ·
 * ci-cd `req-` + 나노초 16진(internal/shared/logger.go NewRequestID) · 어드민 앞 nginx 의 `$request_id`(16진 32자) · 어드민 로그인의 randomUUID(36자) ·
 * 어드민 화면 로그의 이름표(`screen-log-trace`). */
import { describe, expect, it } from "vitest";
import { parseRequestTraceQuery } from "@/features/request-trace/lib/request-trace-query";
import { UPSTREAM_FAILURE_MESSAGES } from "@/shared/lib/upstream-result";

describe("받는 요청 ID — 지금 있는 꼴 전부", () => {
  it.each([
    ["front", "req-0123456789ab"],
    ["backend", "req-1a2b3c4d-5e6f"],
    ["ci-cd", "req-18a1b2c3d4e5f6a7"],
    ["어드민 앞 nginx", "0f1e2d3c4b5a69788796a5b4c3d2e1f0"],
    ["어드민 로그인(randomUUID)", "3d9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"],
    ["어드민 화면 로그의 이름표", "screen-log-trace"],
    ["밑줄 · 점", "deploy_1.retry"],
    ["한 글자", "a"],
    ["80자", "r".repeat(80)],
  ])("%s %s → 그 글자 그대로", (_label, requestId) => {
    expect(parseRequestTraceQuery({ request_id: requestId })).toEqual({ ok: true, query: { requestId } });
  });

  it("request_id 밖의 이름은 보지 않는다", () => {
    expect(parseRequestTraceQuery({ request_id: "req-0123456789ab", selected: "1-0", q: "<script>" }))
      .toEqual({ ok: true, query: { requestId: "req-0123456789ab" } });
  });
});

describe("거절 — invalid_input(field request_id)", () => {
  it.each([
    ["없음", {}],
    ["빈 값", { request_id: "" }],
    ["배열(같은 이름 두 번)", { request_id: ["req-0123456789ab", "req-0123456789ac"] }],
    ["81자", { request_id: "r".repeat(81) }],
    ["콜론(로그 규약의 구분자)", { request_id: "req:1" }],
    ["가운데 공백", { request_id: "req 1" }],
    ["빗금", { request_id: "req/1" }],
    ["퍼센트", { request_id: "req%2e1" }],
    ["태그", { request_id: "<script>" }],
    ["한글", { request_id: "요청" }],
    ["줄바꿈", { request_id: "req-1\nreq-2" }],
  ])("%s", (_label, input) => {
    const result = parseRequestTraceQuery(input as Record<string, string | string[]>);
    expect(result).toEqual({ ok: false, reason: "invalid_input", field: "request_id", message: UPSTREAM_FAILURE_MESSAGES.invalid_input });
  });
});
