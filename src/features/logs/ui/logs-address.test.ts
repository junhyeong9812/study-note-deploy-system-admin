/** 로그 조회 화면의 주소(순수) — 폼의 KST 시각 칸 ↔ UTC, 화면 주소 → 진입 함수의 입력, 조건 → 주소. */
import { describe, expect, it } from "vitest";
import { isoUtcToKstInput, kstInputToIsoUtc, logSearchInput, logsHref, serviceFilterHref } from "@/features/logs/ui/logs-address";

describe("kstInputToIsoUtc — KST 칸 → ISO UTC", () => {
  it.each([
    ["2026-11-22T09:00", "2026-11-22T00:00:00Z"],
    ["2026-11-22T10:30:15", "2026-11-22T01:30:15Z"],
    ["2026-11-22T05:00", "2026-11-21T20:00:00Z"],     // 날짜가 앞날로
    ["2026-01-01T08:59:59", "2025-12-31T23:59:59Z"],  // 해가 앞으로
  ])("%s → %s", (input, expected) => {
    expect(kstInputToIsoUtc(input)).toBe(expected);
  });

  it.each(["2026-11-22", "2026-11-22T9:00", "2026-11-22T09:00Z", "2026-11-22T09:00:00.5", "2026-02-30T00:00", "2026-11-22T24:00", "어제", ""])(
    "%j → null", (input) => {
      expect(kstInputToIsoUtc(input)).toBeNull();
    });
});

describe("isoUtcToKstInput — ISO UTC → KST 칸(초까지)", () => {
  it("밀리초 아래는 버린다 · 읽을 수 없으면 빈 글자", () => {
    expect(isoUtcToKstInput("2026-11-21T20:00:00.987654Z")).toBe("2026-11-22T05:00:00");
    expect(isoUtcToKstInput("not-a-time")).toBe("");
  });
});

describe("logSearchInput — 화면 주소 → 진입 함수의 입력", () => {
  it("KST 칸을 from · to 로 바꾸고 나머지는 그대로", () => {
    expect(logSearchInput({ from_kst: "2026-11-22T09:00", to_kst: "2026-11-22T10:00", service: "front", q: "ab", before: "1-0", limit: "5", extra: "x" }))
      .toEqual({ from: "2026-11-22T00:00:00Z", to: "2026-11-22T01:00:00Z", service: "front", level: undefined, request_id: undefined, q: "ab", before: "1-0", limit: "5" });
  });

  it("KST 칸이 비면 UTC 값 그대로", () => {
    expect(logSearchInput({ from_kst: "", from: "2026-11-22T00:00:00Z" }).from).toBe("2026-11-22T00:00:00Z");
  });

  it("읽을 수 없는 KST 칸 · KST 칸과 UTC 값이 함께 · KST 칸이 여러 번 → 진입 함수가 거절할 값(조용히 고르지 않는다)", () => {
    const unreadable = logSearchInput({ from_kst: "2026-11-22T09:00Z" }).from;
    expect(typeof unreadable === "string" && /Z$/.test(unreadable)).toBe(false);
    expect(Array.isArray(logSearchInput({ to_kst: "2026-11-22T09:00", to: "2026-11-22T00:00:00Z" }).to)).toBe(true);
    expect(Array.isArray(logSearchInput({ from_kst: ["2026-11-22T09:00", "2026-11-22T10:00"] }).from)).toBe(true);
  });
});

describe("logsHref — 조건 → 주소", () => {
  it("null 인 조건 · 기본 건수는 넣지 않는다 · 글자는 인코딩", () => {
    expect(logsHref({ from: null, to: null, service: null, level: null, requestId: null, text: null, before: null, limit: 100 })).toBe("/logs");
    expect(logsHref({ from: null, to: null, service: "front", level: "error", requestId: null, text: "a&b c", before: null, limit: 20 }))
      .toBe("/logs?service=front&level=error&q=a%26b+c&limit=20");
  });
});

describe("serviceFilterHref — 서비스 하나로 걸러 보기", () => {
  const range = { from: "2026-11-22T00:00:00.250Z", to: "2026-11-22T01:00:00Z" };

  it("수준 · 요청 ID · 낱말 · 건수 · 범위는 그대로, service 만 바꾸고 before 는 없다", () => {
    const href = serviceFilterHref("llm", { level: "error", requestId: "req-1", text: "실패 a&b", limit: 50 }, range);
    expect(Object.fromEntries(new URL(href, "https://admin.example.test").searchParams)).toEqual({
      service: "llm", level: "error", request_id: "req-1", q: "실패 a&b", limit: "50", from: range.from, to: range.to,
    });
  });

  it("빈 조건 · 기본 건수는 넣지 않는다", () => {
    expect(serviceFilterHref("front", { level: null, requestId: null, text: null, limit: 100 }, range))
      .toBe("/logs?service=front&from=2026-11-22T00%3A00%3A00.250Z&to=2026-11-22T01%3A00%3A00Z");
  });

  it("서비스 이름의 특수문자는 인코딩한다(주소의 다른 인자를 만들지 않는다)", () => {
    const href = serviceFilterHref("a&level=debug b/#?", { level: null, requestId: null, text: null, limit: 100 }, range);
    expect(href).toContain("service=a%26level%3Ddebug+b%2F%23%3F");
    expect(new URL(href, "https://admin.example.test").searchParams.get("service")).toBe("a&level=debug b/#?");
    expect(new URL(href, "https://admin.example.test").searchParams.has("level")).toBe(false);
  });
});
