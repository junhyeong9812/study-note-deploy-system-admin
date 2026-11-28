/** 가리기 전의 글자 정리(명세 ⑫ §21 1 — 배포 마스터(12-2)의 "글자 정리"와 같게, 어드민은 몇 가지를 더 바꾼다).
 * 계약 — cleanForAnalysis(글) · maskForAnalysis 는 정리한 뒤에 가린다(가림만 따로 부르는 길이 없다):
 * - ANSI 제어열을 지운다: CSI(`ESC [` 매개 글자 0x20~0x3F 뒤 끝 글자 0x40~0x7E — 끝 글자 없이 다른 글자가 오면 거기서 그치고 그 글자는 그대로) ·
 *   OSC(`ESC ]` … 끝 표시 BEL 또는 ST(`ESC \`) — 끝 표시 없으면 줄바꿈 앞 · 내용 4,096자 · 글의 끝에서 그친다) ·
 *   그 밖의 ESC(`ESC` + 0x20~0x7E 한 글자를 함께 지운다 · 그 밖이면 ESC 만 지운다).
 * - 줄 끝: `\r\n` → `\n` · 홀로 선 `\r` → `\n`. 탭 · `\n` 은 그대로.
 * - U+FFFD 로(한 글자마다 하나): 그 밖의 C0(U+0000~001F) · DEL(U+007F) · C1(U+0080~009F — NEL 포함) · U+2028 · U+2029 ·
 *   글의 방향을 바꾸는 서식 문자(U+202A~202E · U+2066~2069) · 짝 없는 서로게이트.
 * - 그 밖은 그대로(한글 · 이모지 · ZWJ(U+200D) · 탭 · 줄바꿈). 정리를 두 번 해도 같다.
 * - 표본: 12-2 리뷰의 비밀 칸 33가지 이름 × 20가지 꼴에 색 코드 · OSC 를 다섯 자리(이름 앞 · 이름 가운데 · 이름 뒤 · 구분자 뒤 · 값 앞)에,
 *   U+FFFD 로 바뀌는 글자 아홉 가지를 배포 마스터(Go)가 가리는 자리(이름 앞 · 이름 뒤(XML 꼴 밖) · 값 앞)에 끼워도 모두 가려진다 —
 *   자리마다 Go 의 CaptureOutput 으로 같은 입력을 돌려 확인한 범위다(이름 가운데의 제어 문자 · 구분자 뒤의 제어 문자는 Go 도 가리지 않는다 — §18 후보).
 * - 시간: 정리가 더해져도 256KB 최악 입력(ESC 만 · 끝 표시 없는 OSC 되풀이)이 1.5초 안. */
import { describe, expect, it } from "vitest";
import { cleanForAnalysis, maskForAnalysis } from "@/features/incident-analysis/lib/analysis-masking";
import { FAKE_TOKENS } from "@/features/incident-analysis/lib/analysis-test-fakes";

const ESC = "\u001b";
const NAMES = [
  "password", "PASSWORD", "db_password", "DB_PASSWORD", "passwd", "secret", "client_secret", "CLIENT_SECRET", "api_token", "token", "GITHUB_TOKEN",
  "api_key", "apiKey", "API_KEY", "access_key", "AWS_SECRET_ACCESS_KEY", "private_key", "x-api-key", "api-key", "accessKey", "privateKey", "auth_token",
  "refresh_token", "jwt_secret", "session_secret", "SPRING_DATASOURCE_PASSWORD", "POSTGRES_PASSWORD", "redis_password", "mysql_root_password",
  "secretKey", "Password", "dbPassword", "encryptionSecret",
];
/** 꼴 — [이름 앞, 이름 뒤, 구분자, 구분자 뒤(값 앞), 값 뒤]. XML 꼴의 값 뒤의 NAME 은 이름으로 바뀐다. */
const SHAPES: readonly [string, string, string, string, string][] = [
  ["", "", "=", "", ""], ["", "", ":", " ", ""], ["\"", "\"", ":", " \"", "\""], ["\"", "\"", ":", "\"", "\""], ["'", "'", ":", " '", "'"],
  ["export ", "", "=", "", ""], ["export ", "", "=", "\"", "\""], ["", " ", "=", " ", ""], ["  ", "", ":", " ", ""], ["--", "", "=", "", ""],
  ["-D", "", "=", "", ""], ["{\"", "\"", ":", "\"", "\",\"x\":1}"], ["ENV ", "", "=", "", ""], ["?", "", "=", "", "&x=1"], ["", "", "=", "\"", "\""],
  ["[", "", "=", "", "]"], ["", "", ":", "\"", "\""], ["<", ">", "", "", "</NAME>"], ["", "", "=", "'", "'"], ["  - ", "", "=", "", ""],
];
const XML_SHAPE = 17;
type Position = "beforeName" | "midName" | "afterName" | "afterSeparator" | "beforeValue";

/** 한 줄 — 끼울 글(insert)을 그 자리에. 색 코드는 감싸는 꼴로(이름 · 값을 색으로 칠한 것처럼). */
function variant(name: string, shapeIndex: number, position: Position, insert: string | "color", value: string): string {
  const [before, after, separator, beforeValue, tail] = SHAPES[shapeIndex];
  let nameText = name;
  let afterName = after;
  let afterSeparator = beforeValue;
  let valueText = value;
  if (insert === "color") {
    if (position === "beforeName") nameText = `${ESC}[36m${name}${ESC}[0m`;
    else if (position === "midName") nameText = `${name.slice(0, name.length >> 1)}${ESC}[1m${name.slice(name.length >> 1)}`;
    else if (position === "afterName") afterName = `${ESC}[0m${after}`;
    else if (position === "afterSeparator") afterSeparator = `${ESC}[2m${beforeValue}`;
    else valueText = `${ESC}[35m${value}${ESC}[0m`;
  } else {
    if (position === "beforeName") nameText = `${insert}${name}`;
    else if (position === "midName") nameText = `${name.slice(0, name.length >> 1)}${insert}${name.slice(name.length >> 1)}`;
    else if (position === "afterName") afterName = `${insert}${after}`;
    else if (position === "afterSeparator") afterSeparator = `${insert}${beforeValue}`;
    else valueText = `${insert}${value}`;
  }
  return `${before}${nameText}${afterName}${separator}${afterSeparator}${valueText}${tail.replace("NAME", name)}`;
}

/** 자리 하나의 모든 줄을 가려 남은 비밀값을 모은다(실패 메시지에 처음 몇 줄). */
function leaks(insert: string | "color", position: Position, shapeFilter: (shapeIndex: number) => boolean = () => true): string[] {
  const leaked: string[] = [];
  let seed = 0;
  for (const name of NAMES) {
    for (let shapeIndex = 0; shapeIndex < SHAPES.length; shapeIndex += 1) {
      if (!shapeFilter(shapeIndex)) continue;
      const value = `Zq81v${seed++}x`;
      const line = variant(name, shapeIndex, position, insert, value);
      if (maskForAnalysis(line).text.includes(value)) leaked.push(JSON.stringify(line));
    }
  }
  return leaked;
}

describe("리뷰가 재현한 줄 — 가림 함수에서도 비밀값이 남지 않는다", () => {
  it.each([
    [`${ESC}[36mpassword${ESC}[0m=${ESC}[35mZq81ColorSecret99${ESC}[0m`, "Zq81ColorSecret99"],
    [`${ESC}[2mDB_PASSWORD${ESC}[0m: Zq81DimSecret42`, "Zq81DimSecret42"],
    [`Authorization: ${ESC}[33mBearer${ESC}[0m Zq81BearerColor77`, "Zq81BearerColor77"],
    ["password\u0000=Zq81NulSecret11", "Zq81NulSecret11"],
    ["secret_key\u007f = Zq81DelSecret12", "Zq81DelSecret12"],
    ["redis_password\u000c=Zq81FormFeed13", "Zq81FormFeed13"],
    ["token\u000b: Zq81VerticalTab14", "Zq81VerticalTab14"],
    ["password=Zq81Nel\u0085Middle15", "Middle15"],
    ["password=Zq81Line\u2028Middle16", "Middle16"],
    ["password=Zq81Para\u2029Middle17", "Middle17"],
  ])("%j", (line, secret) => {
    const masked = maskForAnalysis(line).text;
    expect(masked).not.toContain(secret);
    expect(masked).not.toContain("Zq81");
    expect(masked).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202A-\u202E\u2066-\u2069]/);
  });
});

describe("표본 × 색 코드 · OSC — 다섯 자리 모두", () => {
  const POSITIONS: Position[] = ["beforeName", "midName", "afterName", "afterSeparator", "beforeValue"];
  it.each(POSITIONS)("색 코드(%s) — 660줄이 모두 가려진다", (position) => {
    const leaked = leaks("color", position);
    expect(leaked.slice(0, 3), `${leaked.length}줄이 남았다`).toEqual([]);
  });
  it.each(POSITIONS)("OSC 링크(BEL 끝 — %s) — 660줄이 모두 가려진다", (position) => {
    const leaked = leaks(`${ESC}]8;;https://x.example${"\u0007"}`, position);
    expect(leaked.slice(0, 3), `${leaked.length}줄이 남았다`).toEqual([]);
  });
  it.each(POSITIONS)("OSC 제목(ST 끝 — %s) — 660줄이 모두 가려진다", (position) => {
    const leaked = leaks(`${ESC}]0;title${ESC}\\`, position);
    expect(leaked.slice(0, 3), `${leaked.length}줄이 남았다`).toEqual([]);
  });
});

describe("표본 × U+FFFD 로 바뀌는 글자 — 배포 마스터가 가리는 자리", () => {
  const CHARACTERS: [string, string][] = [
    ["NUL", "\u0000"], ["VT", "\u000b"], ["FF", "\u000c"], ["DEL", "\u007f"], ["NEL(U+0085)", "\u0085"], ["CSI(U+009B)", "\u009b"],
    ["LS(U+2028)", "\u2028"], ["RLO(U+202E)", "\u202E"], ["LRI(U+2066)", "\u2066"],
  ];
  for (const [label, character] of CHARACTERS) {
    it(`${label} — 이름 앞(XML 꼴 밖)`, () => {
      expect(leaks(character, "beforeName", (shape) => shape !== XML_SHAPE).slice(0, 3)).toEqual([]);
    });
    it(`${label} — 이름 바로 뒤(XML 꼴 밖)`, () => {
      expect(leaks(character, "afterName", (shape) => shape !== XML_SHAPE).slice(0, 3)).toEqual([]);
    });
    it(`${label} — 값 앞(모든 꼴)`, () => {
      expect(leaks(character, "beforeValue").slice(0, 3)).toEqual([]);
    });
  }
});

describe("토큰 · 주소 · 메일 · URL 의 자격 — 색 코드 · 제어 문자가 끼어도", () => {
  const TOKEN_PLACES: ((token: string) => string)[] = [
    (token) => `Authorization: Bearer ${token}`, (token) => `using ${token} now`, (token) => `url=https://x-access-token:${token}@github.com/o/r.git`,
    (token) => `"${token}"`, (token) => `(${token})`, (token) => `Bearer ${token}`, (token) => `${token}\t`, (token) => `Authorization: Basic ${token}`,
  ];
  it.each(Object.entries(FAKE_TOKENS))("토큰 %s", (_name, token) => {
    for (const place of TOKEN_PLACES) {
      for (const wrapped of [`${ESC}[33m${token}${ESC}[0m`, `\u0000${token}`, `\u202E${token}`]) {
        expect(maskForAnalysis(place(wrapped)).text, place(wrapped)).not.toContain(token.slice(4, 16));
      }
    }
  });

  it.each(["10.1.2.3", "172.20.0.5", "192.168.0.10", "100.100.1.1", "169.254.1.1", "fd12:3456:789a::1", "fe80::1%eth0"])("내부 주소 %s", (address) => {
    for (const wrapped of [`${ESC}[33m${address}${ESC}[0m`, `\u0000${address}`]) {
      for (const line of [`connect to ${wrapped}:5432 failed`, `Host: ${wrapped}`, `http://${wrapped}/health`, `addr=${wrapped}`]) {
        expect(maskForAnalysis(line).text, line).not.toContain(address);
      }
    }
  });

  it("메일 · URL 의 자격", () => {
    expect(maskForAnalysis(`Author: ${ESC}[1mci-bot@example.org${ESC}[0m`).text).not.toContain("ci-bot@example.org");
    expect(maskForAnalysis(`postgres://app:${ESC}[2mZq81UrlSecret9${ESC}[0m@db:5432/x`).text).not.toContain("Zq81UrlSecret9");
    expect(maskForAnalysis("postgres://app:\u0000Zq81UrlSecret8@db:5432/x").text).not.toContain("Zq81UrlSecret8");
  });
});

describe("cleanForAnalysis — 정리의 정확한 범위", () => {
  it.each([
    ["CSI 색", `a${ESC}[31;1mb${ESC}[0mc`, "abc"],
    ["CSI 매개 없음", `a${ESC}[Kb`, "ab"],
    ["CSI 가 끝 글자 없이 끊김 — 그 글자는 그대로", `a${ESC}[31éb`, "aéb"],
    ["CSI 가 줄바꿈에서 끊김", `a${ESC}[31\nb`, "a\nb"],
    ["OSC — BEL 끝", `a${ESC}]0;title\u0007b`, "ab"],
    ["OSC — ST 끝", `a${ESC}]8;;https://x.example${ESC}\\b`, "ab"],
    ["OSC — 끝 표시 없이 줄바꿈", `a${ESC}]0;title\nb`, "a\nb"],
    ["OSC — 끝 표시 없이 글의 끝", `a${ESC}]0;title`, "a"],
    ["그 밖의 ESC(+ 보이는 글자 하나만 — 배포 마스터와 같게 `ESC ( B` 의 B 는 남는다)", `a${ESC}Mb${ESC}(Bc`, "abBc"],
    ["홀로 선 ESC — 글의 끝", `a${ESC}`, "a"],
    ["ESC 뒤가 보이는 ASCII 가 아님 — ESC 만", `a${ESC}é`, "aé"],
    ["CRLF · 홀로 선 CR", "a\r\nb\rc\r\r\nd", "a\nb\nc\n\nd"],
    ["탭 · 줄바꿈은 그대로", "a\tb\nc", "a\tb\nc"],
    ["C0 · DEL · C1 → U+FFFD 한 글자마다", "a\u0000\u0001\u0008\u000b\u000c\u000e\u001f\u007f\u0080\u0085\u009fb", `a${"\uFFFD".repeat(11)}b`],
    ["줄 구분 · 방향 서식 → U+FFFD", "a\u2028\u2029\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069b", `a${"\uFFFD".repeat(11)}b`],
    ["짝 없는 서로게이트 → U+FFFD", "a\uD800b\uDC00c", "a\uFFFDb\uFFFDc"],
    ["정상 글 — 한글 · 이모지 · ZWJ · 그 밖의 서식(U+200B · U+FEFF)", "연결 풀 😀 👩\u200D💻 \u200B\uFEFF", "연결 풀 😀 👩\u200D💻 \u200B\uFEFF"],
  ])("%s", (_label, input, expected) => {
    expect(cleanForAnalysis(input)).toBe(expected);
  });

  it("OSC 의 내용은 4,096자까지 — 끝 표시 없이 더 길면 거기서 그치고 나머지는 글", () => {
    expect(cleanForAnalysis(`${ESC}]${"x".repeat(4_096)}yz`)).toBe("yz");
    expect(cleanForAnalysis(`${ESC}]${"x".repeat(5_000)}`)).toBe("x".repeat(904));
  });

  it("두 번 해도 같다 · 정리한 글을 가려도 정리된 글이다", () => {
    const dirty = `${ESC}[36mpassword${ESC}[0m=x\u0000\r\n\u202Ey\u2028`;
    expect(cleanForAnalysis(cleanForAnalysis(dirty))).toBe(cleanForAnalysis(dirty));
    expect(maskForAnalysis(dirty).text).toBe(maskForAnalysis(cleanForAnalysis(dirty)).text);
  });

  it("정상 글은 가림에서도 그대로(탭 · 줄바꿈 · 이모지 · ZWJ)", () => {
    const line = "TestPool\tok\n연결 풀 😀 👩\u200D💻";
    expect(maskForAnalysis(line)).toEqual({ text: line, counts: {} });
  });
});

describe("시간 — 정리가 더해져도 입력에 비례", () => {
  const SIZE = 256 * 1024;
  const repeated = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  it.each([
    ["ESC 만", repeated(ESC)], ["ESC [ 만", repeated(`${ESC}[`)], ["끝 표시 없는 OSC 되풀이", repeated(`${ESC}]0;`)],
    ["CSI 매개가 끝없이", `${ESC}[${"1;".repeat(SIZE / 2)}`], ["제어 문자만", repeated("\u0000\u000b")], ["방향 서식만", repeated("\u202E\u2066")],
    ["CR 만", repeated("\r")],
  ])("%s — 256KB 가 1.5초 안", (_label, text) => {
    const started = performance.now();
    maskForAnalysis(text);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
