/** 방문 기록 화면의 글자 — 명세 §13 "경로의 빈칸은 front 가 `%20` 으로, `%` 는 `%25` 로 … V5 의 화면이 보일 때 푼다" ·
 * §14 "누구나 `/wiki/<무엇이든>` · 호스트 꼴의 아무 글을 상위 목록에 올릴 수 있다" · 수의 표기 · 봇 비율의 분모 0.
 * 경로 · 들어온 곳은 방문자가 보낸 글자다 — 푸는 것은 front 가 쓴 두 가지의 거꾸로뿐이고, 던지지 않고, 보이지 않는 글자는 보이게, 긴 값은 자른다.
 * HTML 이스케이프는 이 층이 하지 않는다(React 가 한다 — 여기서 하면 두 번 된다: 화면 사례가 본다). */
import { describe, expect, it } from "vitest";
import {
  VISIT_DIRECT_TEXT, VISIT_HIDDEN_CHARACTER_REPLACEMENT, VISIT_NO_RATIO_TEXT, VISIT_TEXT_ELLIPSIS, VISIT_TEXT_MAXIMUM_LENGTH,
  decodeVisitPath, displayReferrerHost, displayVisitPath, formatVisitCount, formatVisitRatio, parseSiteOrigin, siteHostOf, visitPathHref,
} from "@/features/visits/lib/visit-display";

const SITE = "https://www.example.com";

describe("상수", () => {
  it("120 코드 포인트 · … · U+FFFD · 직접 · —", () => {
    expect(VISIT_TEXT_MAXIMUM_LENGTH).toBe(120);
    expect(VISIT_TEXT_ELLIPSIS).toBe("…");
    expect(VISIT_HIDDEN_CHARACTER_REPLACEMENT).toBe("�");
    expect(VISIT_DIRECT_TEXT).toBe("직접");
    expect(VISIT_NO_RATIO_TEXT).toBe("—");
  });
});

describe("decodeVisitPath — front 가 쓴 두 가지(%20 · %25)만 푼다", () => {
  it.each([
    ["/wiki/01-N으로%20표현", "/wiki/01-N으로 표현"],
    ["/wiki/100%25", "/wiki/100%"],
    ["/wiki/100%25%20done", "/wiki/100% done"],
    ["/wiki/a%20%20b", "/wiki/a  b"],
    ["/", "/"],
    ["/wiki/한글은-그대로", "/wiki/한글은-그대로"],
  ])("%j → %j", (raw, expected) => {
    expect(decodeVisitPath(raw)).toBe(expected);
  });

  it("한 번만 푼다 — %2520 은 %20(빈칸이 아니다) · %2525 는 %25", () => {
    expect(decodeVisitPath("/wiki/a%2520b")).toBe("/wiki/a%20b");
    expect(decodeVisitPath("/wiki/a%2525b")).toBe("/wiki/a%25b");
  });

  it.each([
    "/wiki/%3F", "/wiki/%2f", "/wiki/%2F", "/wiki/%41", "/wiki/%EA%B0%80",
  ])("그 밖의 퍼센트 꼴은 받은 글자 그대로 — %j", (raw) => {
    expect(decodeVisitPath(raw)).toBe(raw);
  });

  it.each([
    "/wiki/50%", "/wiki/%", "/wiki/%2", "/wiki/%zz", "/wiki/%E0%A4%A", "/wiki/%%20", "/wiki/%u0041",
  ])("풀 수 없는 꼴(깨진 퍼센트)은 던지지 않고 받은 글자 그대로(그 안의 퍼센트20 만 푼다) — %j", (raw) => {
    expect(() => decodeVisitPath(raw)).not.toThrow();
    expect(decodeVisitPath(raw)).toBe(raw.replace("%%20", "% "));
  });
});

describe("displayVisitPath — 풀고 · 보이지 않는 글자를 바꾸고 · 자른다", () => {
  it("푼 글자를 보인다", () => {
    expect(displayVisitPath("/wiki/01-N으로%20표현")).toBe("/wiki/01-N으로 표현");
    expect(displayVisitPath("/wiki/100%25%20done")).toBe("/wiki/100% done");
  });

  it.each([
    ["제어 문자 NUL", "\u0000"], ["제어 문자 ESC", "\u001b"], ["제어 문자 DEL", "\u007f"], ["C1 제어 문자 NEL", "\u0085"],
    ["오른쪽에서 왼쪽 덮어쓰기", "‮"], ["오른쪽에서 왼쪽 표시", "‏"], ["폭 없는 빈칸", "​"], ["방향 격리", "⁧"],
    ["BOM", "﻿"], ["줄 구분", " "], ["문단 구분", " "], ["줄바꿈", "\n"], ["탭", "\t"],
  ])("%s 는 하나마다 U+FFFD", (_label, hidden) => {
    expect(displayVisitPath(`/wiki/a${hidden}b${hidden}`)).toBe("/wiki/a�b�");
  });

  it("푼 뒤에 본다 — 빈칸과 함께 와도 빈칸은 그대로", () => {
    expect(displayVisitPath("/wiki/%20‮txt.exe")).toBe("/wiki/ �txt.exe");
  });

  it("HTML 글자는 그대로 둔다(이스케이프는 그리는 쪽 — 여기서 하면 두 번 된다)", () => {
    expect(displayVisitPath("/wiki/<script>alert(1)</script>")).toBe("/wiki/<script>alert(1)</script>");
    expect(displayVisitPath("/wiki/\"onmouseover=\"x")).toBe("/wiki/\"onmouseover=\"x");
    expect(displayVisitPath("/wiki/a&amp;b")).toBe("/wiki/a&amp;b");
  });

  it("주소 꼴 · 메일 주소 꼴도 글자 그대로(가리지도 링크로 바꾸지도 않는다)", () => {
    expect(displayVisitPath("/wiki/203.0.113.7")).toBe("/wiki/203.0.113.7");
    expect(displayVisitPath("/wiki/someone@example.com")).toBe("/wiki/someone@example.com");
  });

  it("120 코드 포인트까지는 그대로, 넘으면 120 + …", () => {
    const exact = `/${"a".repeat(119)}`;
    expect(displayVisitPath(exact)).toBe(exact);
    const over = `/${"a".repeat(120)}`;
    expect(displayVisitPath(over)).toBe(`/${"a".repeat(119)}…`);
    const korean = `/wiki/${"가".repeat(500)}`;
    expect(Array.from(displayVisitPath(korean))).toHaveLength(121);
    expect(displayVisitPath(korean).endsWith("가…")).toBe(true);
  });

  it("푼 뒤의 길이로 잰다 — %20 119개는 빈칸 119개(120자 — 자르지 않는다)", () => {
    expect(displayVisitPath(`/${"%20".repeat(119)}`)).toBe(`/${" ".repeat(119)}`);
  });

  it("서로게이트 쌍을 가르지 않는다", () => {
    const text = displayVisitPath(`/${"a".repeat(118)}😀😀😀`);
    expect(text).toBe(`/${"a".repeat(118)}😀…`);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("512 자의 경로(관측 서버의 상한)도 던지지 않는다", () => {
    expect(() => displayVisitPath(`/${"%".repeat(511)}`)).not.toThrow();
  });
});

describe("displayReferrerHost", () => {
  it("null · 빈 글자 → 직접", () => {
    expect(displayReferrerHost(null)).toBe("직접");
    expect(displayReferrerHost("")).toBe("직접");
  });

  it("호스트는 그대로 — 풀지 않는다", () => {
    expect(displayReferrerHost("www.google.com")).toBe("www.google.com");
    expect(displayReferrerHost("a%20b.example.net")).toBe("a%20b.example.net");
    expect(displayReferrerHost("203.0.113.7")).toBe("203.0.113.7");
  });

  it("보이지 않는 글자 · 긴 값은 경로와 같은 규칙", () => {
    expect(displayReferrerHost("evil‮moc.example.net")).toBe("evil�moc.example.net");
    const long = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;   // 253자
    expect(displayReferrerHost(long)).toBe(`${long.slice(0, 120)}…`);
  });
});

describe("parseSiteOrigin · siteHostOf", () => {
  it.each([
    ["https://www.example.com", "https://www.example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["  https://www.example.com  ", "https://www.example.com"],
  ])("%j → %j", (value, expected) => {
    expect(parseSiteOrigin(value)).toBe(expected);
  });

  it.each([
    "", "   ", "www.example.com", "https://www.example.com/", "https://www.example.com/wiki", "https://WWW.example.com",
    "ftp://www.example.com", "javascript:alert(1)", "https://user@www.example.com", "https://www.example.com?x=1",
  ])("출처 꼴이 아니면 null — %j", (value) => {
    expect(parseSiteOrigin(value)).toBeNull();
  });

  it("호스트 이름 — 포트 없이", () => {
    expect(siteHostOf("https://www.example.com")).toBe("www.example.com");
    expect(siteHostOf("http://localhost:3000")).toBe("localhost");
  });
});

describe("visitPathHref — 사이트의 그 글로만", () => {
  it("설정이 없으면 링크 없음", () => {
    expect(visitPathHref(null, "/wiki/a")).toBeNull();
  });

  it("받은 경로를 풀지 않고 사이트 출처 뒤에 그대로", () => {
    expect(visitPathHref(SITE, "/wiki/a")).toBe("https://www.example.com/wiki/a");
    expect(visitPathHref(SITE, "/")).toBe("https://www.example.com/");
    expect(visitPathHref(SITE, "/wiki/01-N으로%20표현")).toBe("https://www.example.com/wiki/01-N으로%20표현");
    expect(visitPathHref(SITE, "/@evil.example.net")).toBe("https://www.example.com/@evil.example.net");
  });

  it.each([
    "//evil.example.net/x", "///evil.example.net", "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "https://evil.example.net/",
    "", "wiki/a", ".evil.example.net/x", "@evil.example.net", " /wiki/a", "/\\evil.example.net", "/wiki\\..\\x",
    "/wiki/a\u0000", "/wiki/‮a", "/wiki/a\n", "/wiki/​a", "\t/wiki/a",
  ])("링크로 만들지 않는다 — %j", (raw) => {
    expect(visitPathHref(SITE, raw)).toBeNull();
  });

  it("만든 주소의 출처는 언제나 사이트 출처다", () => {
    for (const raw of ["/wiki/a", "/@x", "/wiki/%2F%2Fevil", "/wiki/100%25", "/:8080", "/a?b#c"]) {
      const href = visitPathHref(SITE, raw);
      if (href !== null) expect(new URL(href).origin).toBe(SITE);
    }
  });
});

describe("수의 표기", () => {
  it.each([[0, "0"], [7, "7"], [999, "999"], [1000, "1,000"], [12_345, "12,345"], [1_234_567, "1,234,567"]] as const)("%i → %s", (value, text) => {
    expect(formatVisitCount(value)).toBe(text);
  });

  it("봇 비율 — 분모가 0(null)이면 — · 0 은 실제 0.0% · 소수 한 자리", () => {
    expect(formatVisitRatio(null)).toBe("—");
    expect(formatVisitRatio(0)).toBe("0.0%");
    expect(formatVisitRatio(0.25)).toBe("25.0%");
    expect(formatVisitRatio(1)).toBe("100.0%");
    expect(formatVisitRatio(306 / 1540)).toBe("19.9%");
    expect(formatVisitRatio(0.00049)).toBe("0.0%");
  });
});
