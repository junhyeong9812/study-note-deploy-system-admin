/** 판정 11-22(7번) — 감시 대상의 reason · backend 의존성의 detail 은 "가린 형태"로 넘긴다:
 * 주소 꼴(http(s) 의 scheme+host[:port], 맨 IPv4[:port])은 `(주소)`, 줄바꿈은 공백, 앞 120자. */
import { describe, expect, it } from "vitest";
import { MASKED_ADDRESS, UPSTREAM_REASON_MAXIMUM_LENGTH, maskUpstreamReason } from "@/shared/lib/upstream-reason";

const ADDRESS_FRAGMENTS = ["10.0.0.5", "192.168.0.10", "203.0.113.9", "elasticsearch.internal.example.test", "9200", "17000", "http://", "https://", "user:pass"];

function expectNoAddress(masked: string) {
  for (const fragment of ADDRESS_FRAGMENTS) expect(masked, masked).not.toContain(fragment);
}

describe("maskUpstreamReason — 주소 가리기", () => {
  it.each([
    ["http + IPv4 + 포트", "status 503 from http://10.0.0.5:9200", `status 503 from ${MASKED_ADDRESS}`],
    ["https + 이름", "https://elasticsearch.internal.example.test timed out", `${MASKED_ADDRESS} timed out`],
    ["scheme 대문자", "HTTP://10.0.0.5:9200 refused", `${MASKED_ADDRESS} refused`],
    ["scheme 섞임", "HtTpS://elasticsearch.internal.example.test:17000 x", `${MASKED_ADDRESS} x`],
    ["경로 · 쿼리는 남는다", "GET http://10.0.0.5:9200/_cluster/health?pretty failed", `GET ${MASKED_ADDRESS}/_cluster/health?pretty failed`],
    ["사용자정보도 가린다", "http://user:pass@10.0.0.5:9200/x", `${MASKED_ADDRESS}/x`],
    ["대괄호 IPv6", "http://[2001:db8::1]:8080/health down", `${MASKED_ADDRESS}/health down`],
    ["맨 IPv4", "Connection refused: 192.168.0.10", `Connection refused: ${MASKED_ADDRESS}`],
    ["맨 IPv4 + 포트", "connect to 192.168.0.10:6379 failed", `connect to ${MASKED_ADDRESS} failed`],
    ["여러 개", "a http://10.0.0.5:9200 b 203.0.113.9:17000 c https://elasticsearch.internal.example.test",
      `a ${MASKED_ADDRESS} b ${MASKED_ADDRESS} c ${MASKED_ADDRESS}`],
  ])("%s", (_label, input, expected) => {
    const masked = maskUpstreamReason(input);
    expect(masked).toBe(expected);
    expectNoAddress(masked);
  });

  it("주소가 없으면 그대로(예외 종류 이름 · 한국어 사유)", () => {
    for (const text of ["database SQLException", "정상이 아닌 구성 요소: embedding", "status 500", "3초 안에 응답 없음", "cluster status red"]) {
      expect(maskUpstreamReason(text)).toBe(text);
    }
  });

  it("빈 글자는 빈 글자", () => {
    expect(maskUpstreamReason("")).toBe("");
  });

  it("scheme 없는 이름:포트(elasticsearch:9200)는 규칙 밖 — 그대로 둔다(판정된 규칙은 http(s) 주소와 맨 IPv4 뿐)", () => {
    expect(maskUpstreamReason("elasticsearch:9200 refused")).toBe("elasticsearch:9200 refused");
  });
});

describe("maskUpstreamReason — 줄바꿈 · 길이", () => {
  it("줄바꿈은 하나씩 공백 한 칸", () => {
    expect(maskUpstreamReason("a\nb\r\nc\rd")).toBe("a b c d");
  });

  it("앞 120자로 자른다", () => {
    expect(UPSTREAM_REASON_MAXIMUM_LENGTH).toBe(120);
    expect(maskUpstreamReason("가".repeat(300))).toBe("가".repeat(120));
    expect(maskUpstreamReason("a".repeat(120))).toBe("a".repeat(120));
  });

  it("가린 뒤에 자른다 — 120자 경계에 걸친 주소도 조각이 남지 않는다", () => {
    const input = `${"x".repeat(110)} 203.0.113.9:17000 tail and more`;
    const masked = maskUpstreamReason(input);
    expect(masked).toBe(`${"x".repeat(110)} ${MASKED_ADDRESS} tail`);
    expect(masked).not.toContain("203.0.113");   // 먼저 자르면 "203.0.113" 조각이 IPv4 꼴이 아니게 되어 가려지지 않는다
    expectNoAddress(masked);
  });

  it("서로게이트 쌍을 가르지 않는다(코드 포인트 120개)", () => {
    const masked = maskUpstreamReason("😀".repeat(200));
    expect(Array.from(masked)).toHaveLength(120);
    expect(masked).toBe("😀".repeat(120));
  });

  it("줄바꿈 바꾸기 뒤의 길이로 잰다", () => {
    expect(maskUpstreamReason(`${"a".repeat(119)}\nbcd`)).toBe(`${"a".repeat(119)} `);
  });
});
