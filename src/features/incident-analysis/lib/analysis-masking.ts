/** 분석에 보내는 글의 가림(한 겹 더 — 명세 ⑫ §19 · §20). 배포 마스터(12-2)의 규칙표 — ci-cd internal/shared/failure_output.go 의 "가림" 절 — 를
 * 같은 뜻으로 옮긴 한 벌이다. **규칙이 두 언어에 두 벌이다 — 한쪽을 고치면 다른 쪽도 고친다.** 계약(테스트가 고정): analysis-masking.test.ts 머리 주석.
 *
 * 가리기 전에 늘 글자를 정리한다(cleanForAnalysis — 배포 마스터의 "글자 정리"와 같은 뜻 + 어드민이 넓힌 것: 줄 구분 U+2028 · U+2029 와
 * 글의 방향을 바꾸는 서식 문자도 U+FFFD 로) — 색 코드 · 제어 문자가 이름이나 값에 끼어 가림 규칙을 비껴가지 못하게. 가림만 따로 부르는 길은 없다.
 * 배포 마스터와 다른 것: 크기 상한 · 긴 한 줄 버리기는 하지 않는다(자르기는 분석의 프롬프트가 한다) ·
 * PEM 덩어리는 한 줄로 모으지 않고 덩어리 안의 줄마다 표시를 둔다 — 줄 수를 바꾸지 않는다(덩어리 하나를 한 번으로 센다).
 * 줄 단위다 — 규칙은 줄을 넘어 맞지 않고, 줄 수 · 줄바꿈은 그대로다. 줄의 앞 · 뒤에 붙은 글(12-1 의 `- ` · `| ` 줄머리)은 값이 아니라 남는다.
 * 소문자는 ASCII 만 바꾼다(글자 수 · 자리가 그대로 — 원래 글과 같은 자리를 본다). 값의 자리는 정규식의 d 깃발(indices)로 읽는다.
 * 시간은 입력에 비례한다: 맞춰 보는 자리마다 줄 끝까지 훑지 않는다(맞은 자리 안은 건너뛰고, 거슬러 찾는 길이에 상한을 둔다 — 함수마다 주석).
 * 값 전체가 정확히 가림 표시 하나인 것(배포 마스터가 이미 가린 것)은 그대로 둔다 — 표시 뒤에 글이 붙었거나 모르는 종류면 값 전체를 가린다.
 * 겹치는 맞음은 합쳐 표시 하나로. 다시 거치면 가림이 늘 수는 있어도 줄지 않고, 가린 값이 되살아나지 않는다. */

/** 가림 표시의 종류 — 표시는 `[가림:<종류>]`(배포 마스터와 같은 꼴). */
export const ANALYSIS_MASK_KINDS = ["pem", "token", "authorization", "url_credential", "secret_field", "hex", "email", "private_ip"] as const;
export type AnalysisMaskKind = (typeof ANALYSIS_MASK_KINDS)[number];

export interface MaskedText {
  text: string;
  /** 종류 → 가린 횟수(0 인 종류는 싣지 않는다) */
  counts: Partial<Record<AnalysisMaskKind, number>>;
}

const MASK_PREFIX = "[가림:";

function maskOf(kind: AnalysisMaskKind): string {
  return `${MASK_PREFIX}${kind}]`;
}

/** 맞음 하나에서 표시로 바꿀 값 [start, end). 맞음끼리 겹칠 수 있다(합쳐서 가린다). */
interface Span {
  start: number;
  end: number;
}

interface Rule {
  kind: AnalysisMaskKind;
  /** ASCII 소문자로 바꾼 줄에서 이 규칙이 맞을 수 있는가(싸게) — 규칙이 맞는 모든 글에 반드시 든 글자로만 거른다. */
  mayMatch: (lowered: string) => boolean;
  /** 줄에서 맞음들(앞에서부터). 시간은 줄의 길이에 비례해야 한다. */
  find: (line: string, lowered: string) => Span[];
}

// ── 글자 가르기(ASCII) ─────────────────────────────────────

function code(text: string, index: number): number {
  return text.charCodeAt(index);
}
function isDigit(value: number): boolean {
  return value >= 0x30 && value <= 0x39;
}
function isAlphanumeric(value: number): boolean {
  return isDigit(value) || (value >= 0x61 && value <= 0x7a) || (value >= 0x41 && value <= 0x5a);
}
function isUpperOrDigit(value: number): boolean {
  return isDigit(value) || (value >= 0x41 && value <= 0x5a);
}
function isWordCharacter(value: number): boolean {
  return isAlphanumeric(value) || value === 0x5f;
}
function isTokenCharacter(value: number): boolean {
  return isWordCharacter(value) || value === 0x2d;
}
function isNameCharacter(value: number): boolean {
  return isTokenCharacter(value) || value === 0x2e;
}
function isSlackPathCharacter(value: number): boolean {
  return isTokenCharacter(value) || value === 0x2f;
}
function isHexDigit(value: number): boolean {
  return isDigit(value) || (value >= 0x61 && value <= 0x66) || (value >= 0x41 && value <= 0x46);
}
function isEmailLocalCharacter(value: number): boolean {
  return isWordCharacter(value) || value === 0x2e || value === 0x25 || value === 0x2b || value === 0x2d;
}

/** ASCII 대문자만 소문자로 — 글자 수 · 자리가 그대로다(toLowerCase 는 글자 수가 바뀔 수 있다). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
}

function runEnd(line: string, start: number, allowed: (value: number) => boolean): number {
  let end = start;
  while (end < line.length && allowed(code(line, end))) end += 1;
  return end;
}

function containsAny(...needles: string[]): (lowered: string) => boolean {
  return (lowered) => needles.some((needle) => lowered.includes(needle));
}

/** lowered 에서 needles 가 나온 자리(처음 · 끝) — 처음의 차례로(같으면 긴 것 먼저). 겹친 자리도 모두. */
function occurrences(lowered: string, needles: readonly string[]): [number, number][] {
  const found: [number, number][] = [];
  for (const needle of needles) {
    for (let index = lowered.indexOf(needle); index >= 0; index = lowered.indexOf(needle, index + 1)) found.push([index, index + needle.length]);
  }
  return found.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
}

/** 정규식(d 깃발)의 맞음에서 처음으로 잡힌 묶음의 자리(없으면 null). */
function firstGroup(match: RegExpExecArray): Span | null {
  const indices = match.indices;
  if (indices === undefined) return null;
  for (let group = 1; group < indices.length; group += 1) {
    const range = indices[group];
    if (range !== undefined) return { start: range[0], end: range[1] };
  }
  return null;
}

/** 줄 안의 start 자리에서만 맞춰 본다(y 깃발). */
function stickyMatch(pattern: RegExp, line: string, start: number): RegExpExecArray | null {
  pattern.lastIndex = start;
  return pattern.exec(line);
}

/** 정규식의 맞음마다 처음으로 잡힌 묶음(값). 정규식은 맞을 수 있는 자리가 정해진 글자로 시작해 그 자리에서 짧게 끝난다. */
function findPatternValues(...patterns: RegExp[]): (line: string) => Span[] {
  return (line) => {
    const spans: Span[] = [];
    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        const span = firstGroup(match);
        if (span !== null) spans.push(span);
      }
    }
    return spans;
  };
}

// ── 바꾸기 ────────────────────────────────────────────────

const MASK_KIND_SET: ReadonlySet<string> = new Set(ANALYSIS_MASK_KINDS);

/** 값이 정확히 `[가림:<아는 종류>]` 하나인가. 표시로 시작해도 뒤에 글이 붙었으면 아니다. */
function isExactMask(value: string): boolean {
  return value.startsWith(MASK_PREFIX) && value.endsWith("]") && MASK_KIND_SET.has(value.slice(MASK_PREFIX.length, -1));
}

/** 맞음의 값을 표시로 바꾼다. 겹치는 값은 합쳐 표시 하나로. 빈 값 · 값 전체가 정확히 표시 하나인 것은 그대로 둔다. */
function replaceSpans(line: string, spans: Span[], kind: AnalysisMaskKind): { line: string; count: number } {
  spans.sort((left, right) => left.start - right.start);
  let result = "";
  let previous = 0;
  let count = 0;
  for (let index = 0; index < spans.length;) {
    const { start } = spans[index];
    let { end } = spans[index];
    for (index += 1; index < spans.length && spans[index].start < end; index += 1) end = Math.max(end, spans[index].end);
    if (start === end || isExactMask(line.slice(start, end))) continue;
    result += line.slice(previous, start) + maskOf(kind);
    previous = end;
    count += 1;
  }
  return count === 0 ? { line, count } : { line: result + line.slice(previous), count };
}

// ── 토큰 ─────────────────────────────────────────────────

/** 접두어(대소문자 그대로) + 허용 글자의 연속. 연속이 minimum 이상이면 접두어부터 연속의 끝까지가 토큰이다(이어 붙은 `ghp_…ghp_…` 도 하나로). */
interface TokenShape {
  prefix: string;
  allowed: (value: number) => boolean;
  minimum: number;
  /** 연속 바로 뒤에 낱말 글자가 오면 아니다 */
  wordEndAfter: boolean;
}

const TOKEN_SHAPES: readonly TokenShape[] = [
  { prefix: "ghp_", allowed: isWordCharacter, minimum: 36, wordEndAfter: false }, { prefix: "gho_", allowed: isWordCharacter, minimum: 36, wordEndAfter: false },
  { prefix: "ghu_", allowed: isWordCharacter, minimum: 36, wordEndAfter: false }, { prefix: "ghs_", allowed: isWordCharacter, minimum: 36, wordEndAfter: false },
  { prefix: "ghr_", allowed: isWordCharacter, minimum: 36, wordEndAfter: false },
  { prefix: "github_pat_", allowed: isWordCharacter, minimum: 22, wordEndAfter: false },
  { prefix: "sk-", allowed: isTokenCharacter, minimum: 20, wordEndAfter: false },
  { prefix: "AKIA", allowed: isUpperOrDigit, minimum: 16, wordEndAfter: true }, { prefix: "ASIA", allowed: isUpperOrDigit, minimum: 16, wordEndAfter: true },
  { prefix: "xoxa-", allowed: isTokenCharacter, minimum: 10, wordEndAfter: false }, { prefix: "xoxb-", allowed: isTokenCharacter, minimum: 10, wordEndAfter: false },
  { prefix: "xoxp-", allowed: isTokenCharacter, minimum: 10, wordEndAfter: false }, { prefix: "xoxr-", allowed: isTokenCharacter, minimum: 10, wordEndAfter: false },
  { prefix: "xoxs-", allowed: isTokenCharacter, minimum: 10, wordEndAfter: false },
  { prefix: "AIza", allowed: isTokenCharacter, minimum: 35, wordEndAfter: false },
  { prefix: "npm_", allowed: isWordCharacter, minimum: 36, wordEndAfter: true },
];

const SLACK_WEBHOOK_PREFIX = "hooks.slack.com/services/";
const TOKEN_NEEDLES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk-", "akia", "asia", "eyj", "xox", "aiza", "npm_", SLACK_WEBHOOK_PREFIX];

/** `eyJ<10+>.eyJ<10+>.<10+>` 의 끝 — 맞지 않으면 end -1 과 첫 마디의 끝. */
function jwtEnd(line: string, start: number): { end: number; firstSegmentEnd: number } {
  const firstSegmentEnd = runEnd(line, start + 3, isTokenCharacter);
  if (firstSegmentEnd - (start + 3) < 10 || line[firstSegmentEnd] !== "." || !line.startsWith("eyJ", firstSegmentEnd + 1)) return { end: -1, firstSegmentEnd };
  const secondStart = firstSegmentEnd + 4;
  const secondEnd = runEnd(line, secondStart, isTokenCharacter);
  if (secondEnd - secondStart < 10 || line[secondEnd] !== ".") return { end: -1, firstSegmentEnd };
  const thirdEnd = runEnd(line, secondEnd + 1, isTokenCharacter);
  if (thirdEnd - (secondEnd + 1) < 10) return { end: -1, firstSegmentEnd };
  return { end: thirdEnd, firstSegmentEnd };
}

/** 토큰 꼴 — 낱말의 처음에서만. 맞은 토큰 안의 자리는 건너뛰고, JWT 가 첫 마디에서 실패하면 그 마디 안의 자리도 건너뛴다(한 번 훑기). */
function findTokens(line: string, lowered: string): Span[] {
  const spans: Span[] = [];
  let previous = 0;
  let jwtSkipUntil = 0;
  for (const [start] of occurrences(lowered, TOKEN_NEEDLES)) {
    if (start < previous) continue;
    if (lowered.startsWith(SLACK_WEBHOOK_PREFIX, start)) {   // 웹훅은 주소를 남기고 경로를 가린다
      const valueStart = start + SLACK_WEBHOOK_PREFIX.length;
      const end = runEnd(line, valueStart, isSlackPathCharacter);
      if (end > valueStart) {
        spans.push({ start: valueStart, end });
        previous = end;
      }
      continue;
    }
    if (start > 0 && isWordCharacter(code(line, start - 1))) continue;
    if (line.startsWith("eyJ", start)) {
      if (start < jwtSkipUntil) continue;
      const { end, firstSegmentEnd } = jwtEnd(line, start);
      if (end < 0) {
        jwtSkipUntil = firstSegmentEnd;
        continue;
      }
      spans.push({ start, end });
      previous = end;
      continue;
    }
    for (const shape of TOKEN_SHAPES) {
      if (!line.startsWith(shape.prefix, start)) continue;
      const bodyStart = start + shape.prefix.length;
      const end = runEnd(line, bodyStart, shape.allowed);
      if (end - bodyStart < shape.minimum || (shape.wordEndAfter && end < line.length && isWordCharacter(code(line, end)))) break;
      spans.push({ start, end });
      previous = end;
      break;
    }
  }
  return spans;
}

// ── Authorization · URL 의 자격 ────────────────────────────

/** Authorization 머리 · 칸: 방식(Bearer · Basic …)은 남기고 값만. */
const AUTHORIZATION_PATTERN = /authorization["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token|digest|negotiate)[ \t]+)?([^ \t"'\n,;]+)/dgi;
const BEARER_PATTERN = /\bbearer[ \t]+([^ \t"'\n,;]+)/dgi;
const URL_CREDENTIAL_PATTERN = /:\/\/([^/ \t\n"'@:]*:[^/ \t\n"'@]+)@/dg;

// ── 비밀 칸 ───────────────────────────────────────────────

/** 이름(소문자로)이 이 낱말로 끝나면 비밀 칸이다. 한글 이름은 그대로. */
const SECRET_WORDS = [
  "password", "passwd", "secret", "token", "api_key", "apikey", "api-key", "access_key", "accesskey", "access-key", "private_key", "privatekey", "private-key",
  "secret_key", "secretkey", "secret-key", "secret_key_base", "secretkeybase", "secret-key-base", "비밀번호", "패스워드", "암호",
];
/** 이름의 끝 마디가 정확히 이것일 때만(pass 는 앞에 다른 마디가 있을 때만) · 값이 숫자만이면 남긴다. 혼자 선 pwd 는 값이 / 로 시작하면 남긴다(PWD=/app). */
const SHORT_SECRET_WORDS = ["pass", "pwd"];
const SECRET_FIELD_WORDS = [...SECRET_WORDS, ...SHORT_SECRET_WORDS];
const SECRET_FIELD_NEEDLES = ["docker", ...SECRET_FIELD_WORDS];

/** 긴 옵션 · XML 의 이름을 거슬러 찾는 상한 — 낱말이 나온 자리마다 줄 처음까지 거스르지 않는다. */
const NAME_LOOKBEHIND_LIMIT = 128;
const REPLACEMENT_CHARACTER = "\uFFFD";

/** 값: 따옴표 안(역빗금 이스케이프를 따라 닫는 따옴표까지, 없으면 줄 끝까지) 또는 구분 글자까지. */
const QUOTED_OR_BARE_VALUE = String.raw`(?:"((?:[^"\\\n]|\\[^\n])*)"?|'((?:[^'\\\n]|\\[^\n])*)'?|([^ \t"'&,;\n]+))`;
/** 비밀 낱말 바로 뒤에서 맞춰 보는 칸의 나머지: 구분 · 값(낱말 바로 뒤에 이름의 글자가 오면 맞지 않는다 — 이름이 비밀 낱말로 끝날 때만). */
const SECRET_FIELD_REST = new RegExp(String.raw`["']?[ \t]*[:=][ \t]*` + QUOTED_OR_BARE_VALUE, "dy");
/** 긴 옵션의 값(`--password <값>`) — `-` 로 시작하는 다음 옵션은 값이 아니다. */
const LONG_OPTION_REST = /[ \t]+([^- \t"'\n][^ \t"'\n]*)/dy;
const DOCKER_LOGIN = /\bdocker[ \t]+login\b/g;
const DOCKER_PASSWORD_OPTION = /[ \t]-p[ \t]+/g;
const DOCKER_PASSWORD_VALUE = new RegExp(QUOTED_OR_BARE_VALUE, "dy");

function allDigits(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

/** `<이름>값</이름>`(같은 줄 · 같은 이름)의 값 — 값은 다음 '<' 까지(훑기가 거기서 멈춰 자리마다 겹치지 않는다). 빈 값은 아니다. */
function xmlElementValue(line: string, wordStart: number, wordEnd: number): Span | null {
  let nameStart = wordStart;
  while (nameStart > 0 && wordStart - nameStart < NAME_LOOKBEHIND_LIMIT && isNameCharacter(code(line, nameStart - 1))) nameStart -= 1;
  if (nameStart === 0 || line[nameStart - 1] !== "<") return null;
  const valueStart = wordEnd + 1;
  const valueEnd = line.indexOf("<", valueStart);
  if (valueEnd <= valueStart) return null;
  return line.startsWith(`</${line.slice(nameStart, wordEnd)}>`, valueEnd) ? { start: valueStart, end: valueEnd } : null;
}

/** docker login 뒤의 `-p <값>` — 정규식의 "docker login 부터 -p 까지"를 줄 끝까지 되풀이해 훑지 않게, 찾은 자리에서 이어서 찾는다. */
function findDockerPasswords(line: string): Span[] {
  const spans: Span[] = [];
  for (let position = 0; ;) {
    DOCKER_LOGIN.lastIndex = position;
    const login = DOCKER_LOGIN.exec(line);
    if (login === null) return spans;
    let found = false;
    DOCKER_PASSWORD_OPTION.lastIndex = login.index + login[0].length;
    for (let option = DOCKER_PASSWORD_OPTION.exec(line); option !== null; option = DOCKER_PASSWORD_OPTION.exec(line)) {
      const value = stickyMatch(DOCKER_PASSWORD_VALUE, line, option.index + option[0].length);
      const span = value === null ? null : firstGroup(value);
      if (value !== null && span !== null) {
        spans.push(span);
        position = value.index + value[0].length;
        found = true;
        break;
      }
      DOCKER_PASSWORD_OPTION.lastIndex = option.index + 1;
    }
    if (!found) return spans;   // 이 뒤에 값이 붙은 -p 가 없다 — 뒤의 docker login 도 맞을 수 없다
  }
}

/** 이름이 비밀 낱말로 끝나는 칸의 값 — 낱말이 나온 자리에서만 맞춰 보고, 맞은 칸 안의 자리는 건너뛴다. docker login 의 -p 값은 따로(겹쳐도 합친다). */
function findSecretFields(line: string, lowered: string): Span[] {
  const spans: Span[] = [];
  let previous = 0;
  for (const [wordStart, wordEnd] of occurrences(lowered, SECRET_FIELD_WORDS)) {
    if (wordStart < previous) continue;
    const word = lowered.slice(wordStart, wordEnd);
    const short = word === "pass" || word === "pwd";
    const before = wordStart > 0 ? code(line, wordStart - 1) : 0x20;
    const separated = before === 0x5f || before === 0x2d || before === 0x2e;
    if (short) {
      if (word === "pass" && !(separated && wordStart >= 2 && isAlphanumeric(code(line, wordStart - 2)))) continue;   // PASS: · pass=12 는 시험 결과다
      if (word === "pwd" && !separated && isAlphanumeric(before)) continue;   // cwd 같은 낱말의 끝
    }
    if (line[wordEnd] === ">" && !short) {   // XML `<이름>값</이름>`
      const element = xmlElementValue(line, wordStart, wordEnd);
      if (element !== null) {
        spans.push(element);
        previous = element.end;
      }
      continue;
    }
    let restStart = wordEnd;
    while (line.startsWith(REPLACEMENT_CHARACTER, restStart)) restStart += 1;   // 이름 안에 낀 제어 문자(배포 마스터가 정리한 U+FFFD)
    let match = stickyMatch(SECRET_FIELD_REST, line, restStart);
    if (match === null) {
      let optionStart = wordStart;
      while (optionStart > 0 && wordStart - optionStart < NAME_LOOKBEHIND_LIMIT && isTokenCharacter(code(line, optionStart - 1))) optionStart -= 1;
      const isLongOption = line.startsWith("--", optionStart) && optionStart + 2 < wordStart + 1
        && (optionStart === 0 || line[optionStart - 1] === " " || line[optionStart - 1] === "\t");
      if (!isLongOption || short) continue;
      match = stickyMatch(LONG_OPTION_REST, line, restStart);
      if (match === null) continue;
    }
    const value = firstGroup(match);
    if (value === null) continue;
    const valueText = line.slice(value.start, value.end);
    if (short && (allDigits(valueText) || (word === "pwd" && !separated && valueText.startsWith("/")))) continue;
    spans.push(value);
    previous = match.index + match[0].length;
  }
  if (lowered.includes("docker")) spans.push(...findDockerPasswords(line));
  return spans;
}

// ── 메일 ─────────────────────────────────────────────────

const EMAIL_DOMAIN = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/y;

/** '@' 가 나온 자리에서만 앞(이름)과 뒤(도메인)를 맞춰 본다. 앞뒤 훑기는 '@' 에서 멈추므로 서로 겹치지 않는다. */
function findEmails(line: string): Span[] {
  const spans: Span[] = [];
  let previous = 0;
  for (let offset = 0; offset < line.length;) {
    const at = line.indexOf("@", offset);
    if (at < 0) break;
    let start = at;
    while (start > previous && isEmailLocalCharacter(code(line, start - 1))) start -= 1;
    const domain = start === at ? null : stickyMatch(EMAIL_DOMAIN, line, at + 1);
    if (domain === null) {
      offset = at + 1;
      continue;
    }
    const end = at + 1 + domain[0].length;
    spans.push({ start, end });
    previous = end;
    offset = end;
  }
  return spans;
}

// ── 16진 ─────────────────────────────────────────────────

/** 41자 이상 — 40자 커밋 SHA 는 남긴다. */
const LONG_HEX_LENGTH = 41;
/** 이 이름 뒤에 정확히 이 길이일 때만 다이제스트로 보고 남긴다. */
const DIGEST_LENGTHS: readonly [string, number][] = [["sha256:", 64], ["sha384:", 96], ["sha512:", 128]];

function hasLongHexRun(lowered: string): boolean {
  let run = 0;
  for (let index = 0; index < lowered.length; index += 1) {
    if (isHexDigit(code(lowered, index))) {
      run += 1;
      if (run >= LONG_HEX_LENGTH) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/** 바로 앞이 다이제스트의 이름(그 앞은 낱말 글자가 아니다)이면 그 이름이 요구하는 길이, 아니면 0. */
function digestLength(line: string, start: number): number {
  const before = asciiLower(line.slice(Math.max(0, start - 8), start));
  for (const [prefix, length] of DIGEST_LENGTHS) {
    if (!before.endsWith(prefix)) continue;
    const nameStart = start - prefix.length;
    if (nameStart === 0 || !isWordCharacter(code(line, nameStart - 1))) return length;
  }
  return 0;
}

/** 16진 글자만으로 된 낱말(앞에 0x 가 붙어도)이 41자 이상이면 가린다. 다이제스트 표기(길이가 맞을 때)는 남긴다. */
function findLongHex(line: string): Span[] {
  const spans: Span[] = [];
  for (let start = 0; start < line.length;) {
    if (!isWordCharacter(code(line, start))) {
      start += 1;
      continue;
    }
    const end = runEnd(line, start, isWordCharacter);
    let digitsStart = start;
    if (end - start > 2 && line[start] === "0" && (line[start + 1] === "x" || line[start + 1] === "X")) digitsStart += 2;
    const length = end - digitsStart;
    if (length >= LONG_HEX_LENGTH && runEnd(line, digitsStart, isHexDigit) === end && digestLength(line, start) !== length) spans.push({ start, end });
    start = end;
  }
  return spans;
}

// ── 내부 주소 ─────────────────────────────────────────────

/** 가장 긴 IPv6 글(IPv4 를 품은 꼴) · zone 의 상한 — 훑는 길이에 상한이 있다. */
const IPV6_TEXT_LIMIT = 45;
const ZONE_TEXT_LIMIT = 32;

/** IPv4 점 네 마디(Go netip 과 같이 — 마디마다 0~255 · 앞자리 0 없음) → 네 바이트, 아니면 null. */
function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part) || (part.length > 1 && part[0] === "0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/** 사설 · 공유 · 링크 로컬 IPv4(10/8 · 172.16/12 · 192.168/16 · 100.64/10 · 169.254/16). */
function isInternalIpv4([first, second]: number[]): boolean {
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254);
}

/** IPv6 글(뒤에 %zone 가능) → 처음 두 바이트, 아니면 null. 묶음 1~4자리 16진 · `::` 는 한 번 · 끝에 IPv4 를 품을 수 있다(Go netip 의 꼴). */
function parseIpv6Head(text: string): [number, number] | null {
  let address = text;
  const zone = text.indexOf("%");
  if (zone >= 0) {
    if (zone === text.length - 1) return null;
    address = text.slice(0, zone);
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (half: string): number[] | null => {
    if (half.length === 0) return [];
    const groups: number[] = [];
    const parts = half.split(":");
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (index === parts.length - 1 && part.includes(".")) {
        const ipv4 = parseIpv4(part);
        if (ipv4 === null) return null;
        groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return null;
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 2 && halves[0].includes(".")) return null;   // IPv4 꼴은 맨 끝에만
  const count = head.length + tail.length;
  if (halves.length === 1 ? count !== 8 : count > 7) return null;
  const first = head.length > 0 ? head[0] : 0;   // 앞이 `::` 면 첫 묶음은 0
  return [first >> 8, first & 0xff];
}

/** fc00::/7 · fe80::/10. */
function isInternalIpv6([first, second]: [number, number]): boolean {
  return (first & 0xfe) === 0xfc || (first === 0xfe && (second & 0xc0) === 0x80);
}

/** line[start:] 이 내부 대역의 IPv6(뒤에 %zone 가능)로 시작하면 그 끝, 아니면 -1. 첫 묶음이 네 자리인 fc · fd · fe 로 시작하는 낱말만. */
function internalIpv6At(line: string, start: number): number {
  if (start + 5 > line.length || (code(line, start) | 0x20) !== 0x66 || line[start + 4] !== ":") return -1;
  const second = code(line, start + 1) | 0x20;
  if ((second !== 0x63 && second !== 0x64 && second !== 0x65) || !isHexDigit(code(line, start + 2)) || !isHexDigit(code(line, start + 3))) return -1;
  if (start > 0) {
    const before = code(line, start - 1);
    if (isWordCharacter(before) || before === 0x3a || before === 0x2e) return -1;   // 더 긴 낱말 · 주소의 가운데
  }
  let end = start + 5;
  while (end < line.length && end - start < IPV6_TEXT_LIMIT && (isHexDigit(code(line, end)) || line[end] === ":" || line[end] === ".")) end += 1;
  if (end + 1 < line.length && line[end] === "%") {
    const zoneCharacter = (value: number) => isWordCharacter(value) || value === 0x2e || value === 0x2d;
    if (zoneCharacter(code(line, end + 1))) {
      let zoneEnd = end + 1;
      while (zoneEnd < line.length && zoneEnd - end <= ZONE_TEXT_LIMIT && zoneCharacter(code(line, zoneEnd))) zoneEnd += 1;
      end = zoneEnd;
    }
  }
  for (; end > start; end -= 1) {   // 뒤에 붙은 ':' · '.' 는 주소가 아닐 수 있다 — 하나씩 떼어 다시 본다
    const head = parseIpv6Head(line.slice(start, end));
    if (head !== null) return isInternalIpv6(head) ? end : -1;
    if (line[end - 1] !== ":" && line[end - 1] !== ".") break;
  }
  return -1;
}

function mayHoldInternalAddress(lowered: string): boolean {
  if (containsAny("10.", "172.", "192.168.", "100.", "169.254.")(lowered)) return true;
  return lowered.includes(":") && containsAny("fc", "fd", "fe8", "fe9", "fea", "feb")(lowered);
}

/** 정규식 없이 훑는다: IPv4 는 점으로 이은 수 전체(넷이 아니면 주소가 아니다 — 3.10.0.1.4 같은 판 번호의 일부를 가리지 않는다), IPv6 는 internalIpv6At. */
function findInternalAddresses(line: string): Span[] {
  const spans: Span[] = [];
  for (let index = 0; index < line.length;) {
    if (isDigit(code(line, index))) {
      const start = index;
      let end = runEnd(line, index, isDigit);
      let parts = 1;
      while (end + 1 < line.length && line[end] === "." && isDigit(code(line, end + 1))) {
        end = runEnd(line, end + 1, isDigit);
        parts += 1;
      }
      if (parts === 4 && end - start <= 15) {
        const ipv4 = parseIpv4(line.slice(start, end));
        if (ipv4 !== null && isInternalIpv4(ipv4)) spans.push({ start, end });
      }
      index = end;
      continue;
    }
    const end = internalIpv6At(line, index);
    if (end > index) {
      spans.push({ start: index, end });
      index = end;
      continue;
    }
    index += 1;
  }
  return spans;
}

// ── 규칙의 차례 ──────────────────────────────────────────

const RULES: readonly Rule[] = [
  { kind: "token", mayMatch: containsAny(...TOKEN_NEEDLES), find: findTokens },
  { kind: "authorization", mayMatch: containsAny("authorization", "bearer"), find: findPatternValues(AUTHORIZATION_PATTERN, BEARER_PATTERN) },
  { kind: "url_credential", mayMatch: containsAny("://"), find: findPatternValues(URL_CREDENTIAL_PATTERN) },
  { kind: "secret_field", mayMatch: containsAny(...SECRET_FIELD_NEEDLES), find: findSecretFields },
  { kind: "hex", mayMatch: hasLongHexRun, find: findLongHex },
  { kind: "email", mayMatch: containsAny("@"), find: findEmails },
  { kind: "private_ip", mayMatch: mayHoldInternalAddress, find: findInternalAddresses },
];

// ── PEM ──────────────────────────────────────────────────

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{1,64}-----/g;
const PEM_END = /-----END [A-Z0-9 ]{1,64}-----/g;
/** END 없는 PEM 이 표시로 덮는 상한(UTF-16 글자) — 넘으면 덩어리가 끝난 것으로 본다(열쇠는 그보다 짧다). */
const PEM_SWALLOW_LIMIT = 64 * 1024;

interface PemState {
  inside: boolean;
  swallowed: number;
  count: number;
}

function firstMatchFrom(pattern: RegExp, line: string, from: number): RegExpExecArray | null {
  pattern.lastIndex = from;
  return pattern.exec(line);
}

/** 한 줄 안의 PEM — 같은 줄에 BEGIN · END 가 다 있으면 표시 하나로, END 가 없으면 BEGIN 부터 줄 끝까지 표시로 덮고 덩어리 안으로 들어간다.
 * BEGIN 마다 그 뒤의 END 를 한 번만 찾는다(END 가 없으면 뒤의 BEGIN 에도 없다 — 줄 끝까지 되풀이해 훑지 않는다). */
function maskPemLine(line: string, state: PemState): string {
  if (state.inside) {
    const end = firstMatchFrom(PEM_END, line, 0);
    if (end === null) {
      state.swallowed += line.length;
      if (state.swallowed > PEM_SWALLOW_LIMIT) state.inside = false;   // 단순화: END 가 64K 글자 안에 없으면 덩어리가 끝난 것으로 본다(배포 마스터와 같은 상한)
      return maskOf("pem");
    }
    state.inside = false;
    return maskOf("pem") + maskPemLine(line.slice(end.index + end[0].length), state);
  }
  if (!line.includes("-----BEGIN ")) return line;
  let result = "";
  let position = 0;
  for (;;) {
    const begin = firstMatchFrom(PEM_BEGIN, line, position);
    if (begin === null) return result + line.slice(position);
    const end = firstMatchFrom(PEM_END, line, begin.index + begin[0].length);
    state.count += 1;
    result += line.slice(position, begin.index) + maskOf("pem");
    if (end === null) {
      state.inside = true;
      state.swallowed = 0;
      return result;
    }
    position = end.index + end[0].length;
  }
}

// ── 글자 정리 ─────────────────────────────────────────────

const ESCAPE = 0x1b;
/** 끝 표시 없는 OSC 가 삼키는 글자의 상한 — 배포 마스터와 같다. */
const OSC_LENGTH_LIMIT = 4 * 1024;

/** U+FFFD 로 바꾸는 글자인가 — 탭 · 줄바꿈 밖의 C0 · DEL · C1 · 줄 구분 · 방향 서식 · 짝 없는 서로게이트(코드 포인트로 본다). */
function isReplacedCodePoint(value: number): boolean {
  return (value < 0x20 && value !== 0x09 && value !== 0x0a) || (value >= 0x7f && value <= 0x9f) || value === 0x2028 || value === 0x2029
    || (value >= 0x202a && value <= 0x202e) || (value >= 0x2066 && value <= 0x2069) || (value >= 0xd800 && value <= 0xdfff);
}

/** 가리기 전의 글자 정리(명세 ⑫ §21 1 — 배포 마스터 internal/shared/failure_output.go 의 clean 과 같은 뜻, 같은 상태 기계):
 * ANSI 제어열(CSI · OSC · 그 밖의 ESC)을 지우고 · `\r\n` 과 홀로 선 `\r` 을 `\n` 으로 · 탭과 `\n` 밖의 제어 문자 · 줄 구분 · 방향 서식 · 짝 없는 서로게이트를
 * 글자마다 U+FFFD 로. 한 번 훑는다(정규식 없음 — 입력에 비례하는 시간). 두 번 해도 같다. 계약: analysis-cleaning.test.ts 머리 주석. */
export function cleanForAnalysis(text: string): string {
  const pieces: string[] = [];
  let runStart = 0;   // 그대로 옮길 글의 처음
  const flush = (end: number) => {
    if (end > runStart) pieces.push(text.slice(runStart, end));
  };
  let index = 0;
  while (index < text.length) {
    const value = text.codePointAt(index)!;
    const size = value > 0xffff ? 2 : 1;
    if (value === ESCAPE) {
      flush(index);
      index = escapeEnd(text, index);
      runStart = index;
      continue;
    }
    if (value === 0x0d) {   // \r\n 과 홀로 선 \r → \n
      flush(index);
      pieces.push("\n");
      index += text.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      runStart = index;
      continue;
    }
    if (isReplacedCodePoint(value)) {
      flush(index);
      pieces.push("\uFFFD");
      index += size;
      runStart = index;
      continue;
    }
    index += size;
  }
  flush(index);
  return pieces.join("");
}

function isVisibleAscii(value: number): boolean {
  return value >= 0x20 && value <= 0x7e;
}

/** text[start] 의 ESC 로 시작하는 제어열이 끝난 자리(그 자리부터는 보통 글). 끝 글자 없이 끊긴 제어열은 끊은 글자를 보통 글로 둔다. */
function escapeEnd(text: string, start: number): number {
  const next = text.charCodeAt(start + 1);
  if (next === 0x5b) {   // CSI — ESC [ 매개(0x20~0x3F) … 끝 글자(0x40~0x7E)
    let index = start + 2;
    while (index < text.length) {
      const value = text.charCodeAt(index);
      if (value >= 0x40 && value <= 0x7e) return index + 1;
      if (value < 0x20 || value > 0x3f) return index;
      index += 1;
    }
    return index;
  }
  if (next === 0x5d) {   // OSC — ESC ] … BEL 또는 ESC \ (없으면 줄바꿈 앞 · 4,096자 · 글의 끝)
    let index = start + 2;
    let length = 0;
    while (index < text.length) {
      const value = text.codePointAt(index)!;
      if (value === 0x07) return index + 1;
      if (value === ESCAPE) {
        if (text.charCodeAt(index + 1) === 0x5c) return index + 2;
        return index;   // ESC 가 새 제어열을 시작한다
      }
      if (value === 0x0a || length >= OSC_LENGTH_LIMIT) return index;   // 단순화: 끝 표시 없는 OSC 는 줄바꿈이나 4,096자에서 그친다(그때까지의 글은 버린다 — 배포 마스터와 같다)
      length += 1;
      index += value > 0xffff ? 2 : 1;
    }
    return index;
  }
  if (isVisibleAscii(next)) return start + 2;   // 그 밖의 ESC — 보이는 글자 하나를 함께
  return start + 1;   // ESC 만
}

// ── 들머리 ────────────────────────────────────────────────

/** 가림 — 늘 정리한 뒤에(cleanForAnalysis). */
export function maskForAnalysis(text: string): MaskedText {
  const counts: Partial<Record<AnalysisMaskKind, number>> = {};
  const pem: PemState = { inside: false, swallowed: 0, count: 0 };
  const lines = cleanForAnalysis(text).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    let line = maskPemLine(lines[index], pem);
    if (line.length === 0) continue;   // 빈 줄은 맞을 것이 없다(CR 만 되풀이한 글 등 — 줄마다의 고정 비용을 아낀다)
    let lowered = asciiLower(line);
    for (const rule of RULES) {
      if (!rule.mayMatch(lowered)) continue;
      const replaced = replaceSpans(line, rule.find(line, lowered), rule.kind);
      if (replaced.count === 0) continue;
      counts[rule.kind] = (counts[rule.kind] ?? 0) + replaced.count;
      line = replaced.line;
      lowered = asciiLower(line);
    }
    lines[index] = line;
  }
  if (pem.count > 0) counts.pem = pem.count;
  const ordered: Partial<Record<AnalysisMaskKind, number>> = {};
  for (const kind of ANALYSIS_MASK_KINDS) if (counts[kind] !== undefined) ordered[kind] = counts[kind];
  return { text: lines.join("\n"), counts: ordered };
}

