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

  it.each([
    ["한글 채움 U+3164", "\u3164"], ["반각 한글 채움 U+FFA0", "\uFFA0"], ["초성 채움 U+115F", "\u115F"], ["중성 채움 U+1160", "\u1160"],
    ["점자 빈칸 U+2800", "\u2800"], ["변형 선택자 U+FE00", "\uFE00"], ["변형 선택자 U+FE0F", "\uFE0F"],
    ["변형 선택자 U+E0100", "\u{E0100}"], ["변형 선택자 U+E01EF", "\u{E01EF}"],
  ])("§17-1 %s 도 하나마다 U+FFFD(경로 · 들어온 곳)", (_label, hidden) => {
    expect(displayVisitPath(`/wiki/real${hidden}${hidden}`)).toBe("/wiki/real\uFFFD\uFFFD");
    expect(displayReferrerHost(`real${hidden}.example.net`)).toBe("real\uFFFD.example.net");
  });

  it("§17-1 목록의 바로 바깥은 그대로(U+FE10 · U+2801 · U+E01F0)", () => {
    for (const neighbour of ["\uFE10", "\u2801", "\u{E01F0}"]) expect(displayVisitPath(`/a${neighbour}`)).toBe(`/a${neighbour}`);
  });

  it.each([
    [1, 1], [2, 2], [3, 3], [4, 4], [5, 4], [6, 4], [30, 4],
  ])("§17-1 결합 문자(Mn)는 연달아 4개까지 — %i개 → %i개만 남는다", (count, kept) => {
    const mark = "\u0301";   // 결합 양음 부호
    expect(displayVisitPath(`/wiki/e${mark.repeat(count)}x`)).toBe(`/wiki/e${mark.repeat(kept)}x`);
  });

  it("§17-1 결합 문자의 줄은 따로 센다 — 사이에 다른 글자가 있으면 다시 0부터", () => {
    const mark = "\u0301";
    expect(displayVisitPath(`/a${mark.repeat(6)}b${mark.repeat(6)}c`)).toBe(`/a${mark.repeat(4)}b${mark.repeat(4)}c`);
    expect(displayReferrerHost(`a${mark.repeat(9)}.example.net`)).toBe(`a${mark.repeat(4)}.example.net`);
  });

  it.each([
    ["한글 완성형", "/wiki/한글-완성형"],
    ["조합형 자모(초성 · 중성 · 종성 — 채움이 아닌 U+1100 대)", "/wiki/\u1100\u1161\u11A8\u1112\u1175"],
    ["악센트 하나 · 둘", "/wiki/cafe\u0301-a\u0300\u0301"],
    ["일본어 탁점(결합 U+3099 · 반탁점 U+309A)", "/wiki/\u304B\u3099\u306F\u309A"],
    ["일본어 완성 탁음", "/wiki/がぱ"],
    ["이모지(변형 선택자 없음)", "/wiki/😀-👍"],
  ])("§17-1 정상 글자는 그대로 — %s", (_label, path) => {
    expect(displayVisitPath(path)).toBe(path);
  });

  it("§17-1 이모지 + 변형 선택자 — ❤️ 의 U+FE0F 는 U+FFFD 가 된다(받아들임)", () => {
    expect(displayVisitPath("/wiki/\u2764\uFE0F")).toBe("/wiki/\u2764\uFFFD");
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

  it("§17-3 보충 평면 글자 70개(코드 포인트 70 · UTF-16 140) — 잘리지 않고 … 없음", () => {
    const path = "😀".repeat(70);
    expect(path.length).toBe(140);
    expect(displayVisitPath(path)).toBe(path);
    expect(displayReferrerHost(path)).toBe(path);
  });

  it("§17-3 보충 평면 글자 120개(UTF-16 240)는 그대로 · 121개는 120개 + …", () => {
    expect(displayVisitPath("😀".repeat(120))).toBe("😀".repeat(120));
    expect(displayVisitPath("😀".repeat(121))).toBe(`${"😀".repeat(120)}…`);
  });

  it("§17-3 121 코드 포인트의 끝이 서로게이트 쌍이어도 쪼개지 않는다(120번째가 쌍)", () => {
    const text = displayVisitPath(`${"a".repeat(119)}😀😀`);
    expect(text).toBe(`${"a".repeat(119)}😀…`);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
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
    ["https://www.example.com:8443", "https://www.example.com:8443"],
    ["  https://www.example.com  ", "https://www.example.com"],
  ])("%j → %j", (value, expected) => {
    expect(parseSiteOrigin(value)).toBe(expected);
  });

  it.each([
    "", "   ", "www.example.com", "https://www.example.com/", "https://www.example.com/wiki", "https://WWW.example.com",
    "ftp://www.example.com", "javascript:alert(1)", "https://user@www.example.com", "https://www.example.com?x=1",
    "https://www.example.com.", "https://www.example.com.:8443", "http://localhost.:3000", "https://www.example.com..",
  ])("출처 꼴이 아니면 null(§17-2 — 끝에 점이 붙은 호스트 포함) — %j", (value) => {
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
    "/wiki/real\u3164", "/wiki/real\uFFA0", "/wiki/\u115Freal", "/wiki/\u1160real", "/wiki/real\u2800", "/wiki/real\uFE0F", "/wiki/real\u{E0100}",
    `/wiki/e${"\u0301".repeat(5)}`,
  ])("링크로 만들지 않는다 — %j", (raw) => {
    expect(visitPathHref(SITE, raw)).toBeNull();
  });

  it("§17-1 정상 결합(4개까지 · 탁점 · 자모)은 링크를 건다", () => {
    for (const raw of [`/wiki/e${"\u0301".repeat(4)}`, "/wiki/\u304B\u3099", "/wiki/\u1100\u1161\u11A8"]) {
      expect(visitPathHref(SITE, raw)).toBe(`${SITE}${raw}`);
    }
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
