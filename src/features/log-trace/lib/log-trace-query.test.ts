/** 연관 로그의 입력 검증 — 명세 §11.2 "선택은 주소에 담는다(selected=<로그 id>)" · "고른 로그는 … 관측 서버에서 다시 확인 — 주소의 값을 믿지 않는다" ·
 * ② 세부 5 "입력의 상한을 넘는 값은 줄여서 받지 않고 거절". 로그 id 의 꼴 = 관측 서버 StreamId(observe log/LogEntry.kt:9-19). */
import { describe, expect, it } from "vitest";
import { LOG_ID_PATTERN, cursorJustAfter, parseLogTraceQuery } from "@/features/log-trace/lib/log-trace-query";
import { SELECTED_LOG_ID, SELECTED_MILLISECONDS } from "@/features/log-trace/lib/log-trace-test-fakes";
import { UPSTREAM_RAW_MARKER, expectFailure } from "@/shared/lib/upstream-test-fakes";

describe("parseLogTraceQuery — 통과", () => {
  it("selected 의 id 와 그 밀리초", () => {
    expect(parseLogTraceQuery({ selected: SELECTED_LOG_ID })).toEqual({
      ok: true, query: { selectedLogId: SELECTED_LOG_ID, selectedAtMilliseconds: SELECTED_MILLISECONDS },
    });
  });

  it.each([
    ["0-0", 0], ["1-999999999", 1], ["999999999999999-0", 999_999_999_999_999], ["1763805600000-3", 1_763_805_600_000],
  ] as const)("%s → 밀리초 %d", (selected, milliseconds) => {
    expect(parseLogTraceQuery({ selected })).toEqual({ ok: true, query: { selectedLogId: selected, selectedAtMilliseconds: milliseconds } });
  });

  it("다른 이름의 입력은 보지 않는다", () => {
    expect(parseLogTraceQuery({ selected: SELECTED_LOG_ID, service: "../x", from: "nope" })).toMatchObject({ ok: true });
  });

  it("관측 서버의 꼴과 같다", () => {
    expect(LOG_ID_PATTERN.source).toBe("^\\d{1,15}-\\d{1,9}$");
  });
});

describe("parseLogTraceQuery — 거절(invalid_input, field selected)", () => {
  it.each([
    ["없음", {}],
    ["빈 글자", { selected: "" }],
    ["여러 번", { selected: [SELECTED_LOG_ID, SELECTED_LOG_ID] }],
    ["숫자만", { selected: "1763805600000" }],
    ["순번 없음", { selected: "1763805600000-" }],
    ["밀리초 없음", { selected: "-3" }],
    ["셋으로 나뉨", { selected: "1-2-3" }],
    ["밀리초 16자리", { selected: "1234567890123456-1" }],
    ["순번 10자리", { selected: "1763805600000-1234567890" }],
    ["앞 공백", { selected: ` ${SELECTED_LOG_ID}` }],
    ["뒤 공백", { selected: `${SELECTED_LOG_ID} ` }],
    ["뒤 줄바꿈", { selected: `${SELECTED_LOG_ID}\n` }],
    ["부호", { selected: "+1763805600000-3" }],
    ["음수", { selected: "-1763805600000-3" }],
    ["전각 숫자", { selected: "１７６３-3" }],
    ["스크립트", { selected: "<script>alert(1)</script>" }],
    ["표식", { selected: UPSTREAM_RAW_MARKER }],
  ] as [string, Record<string, string | string[]>][])("%s → 거절", (_label, input) => {
    const result = parseLogTraceQuery(input);
    expectFailure(result, "invalid_input");
    expect(!result.ok && result.field).toBe("selected");
  });
});

describe("cursorJustAfter — 관측 서버 before(엄격히 작은 쪽)에 넘길 '바로 다음' 커서", () => {
  it.each([
    ["1763805600000-3", "1763805600000-4"],
    ["1763805600000-0", "1763805600000-1"],
    ["1763805600000-999999998", "1763805600000-999999999"],
    ["1763805600000-999999999", "1763805600001-0"],
    ["0-0", "0-1"],
  ])("%s → %s", (logId, cursor) => {
    expect(cursorJustAfter(logId)).toBe(cursor);
  });

  it("결과는 언제나 관측 서버의 커서 꼴", () => {
    for (const logId of ["1-0", "1-999999999", SELECTED_LOG_ID]) expect(cursorJustAfter(logId)).toMatch(LOG_ID_PATTERN);
  });
});
