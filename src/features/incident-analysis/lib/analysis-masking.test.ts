/** 분석에 보내는 글의 가림 — 한 겹 더(명세 ⑫ §19 · 규칙은 12-2 의 §16 · §17 · §18 과 같은 뜻 — 후보로 적힌 꼴은 고정하지 않는다).
 * 계약:
 * - 가린 자리는 `[가림:<종류>]`(종류 = ANALYSIS_MASK_KINDS) · counts 에 종류마다 센 수.
 * - 12-2 리뷰가 모은 표본(비밀 칸 33가지 이름 × 20가지 꼴 · URL 의 자격 · 토큰 꼴 6가지 × 11가지 자리 · 내부 주소 7가지 × 5가지 자리 · 메일)이
 *   모두 가려진다 — 비밀값의 표시 글자 `Zq81…` 이 남지 않는다(`Zq81IPMARK` 는 "이 줄의 내부 주소"를 가리키는 이름표일 뿐 — 주소가 사라져야 한다).
 * - 정상 글은 그대로: 40자 커밋 SHA · `sha256:` + 64자 · 테스트 이름 · `token_test.go:42` · `max_tokens=1024` · 문서용 주소 · 127.0.0.1.
 * - 배포 마스터가 이미 가린 출력(`[가림:…]` 이 값 전체인 것)은 그대로 — 가림 표시를 망가뜨리지 않는다. 표시 뒤에 글이 붙은 값은 값 전체를 가린다.
 * - 줄 단위다 — 줄 수 · 줄머리(12-1 의 `#` 머리 · `- ` · `| `)를 바꾸지 않는다.
 * - 시간은 입력에 비례한다 — 최악 입력 256KB 가 1.5초 안. */
import { describe, expect, it } from "vitest";
import { ANALYSIS_MASK_KINDS, maskForAnalysis } from "@/features/incident-analysis/lib/analysis-masking";
import { FAKE_TOKENS, analysisEvidence, evidenceLogLines, fakeCharacters } from "@/features/incident-analysis/lib/analysis-test-fakes";
import { incidentEvidenceText } from "@/features/incidents/lib/incident-evidence-text";

const SECRET_NAMES = [
  "password", "PASSWORD", "db_password", "DB_PASSWORD", "passwd", "secret", "client_secret", "CLIENT_SECRET", "api_token", "token", "GITHUB_TOKEN",
  "api_key", "apiKey", "API_KEY", "access_key", "AWS_SECRET_ACCESS_KEY", "private_key", "x-api-key", "api-key", "accessKey", "privateKey", "auth_token",
  "refresh_token", "jwt_secret", "session_secret", "SPRING_DATASOURCE_PASSWORD", "POSTGRES_PASSWORD", "redis_password", "mysql_root_password",
  "secretKey", "Password", "dbPassword", "encryptionSecret",
];
const FIELD_SHAPES: ((name: string, value: string) => string)[] = [
  (name, value) => `${name}=${value}`, (name, value) => `${name}: ${value}`, (name, value) => `"${name}": "${value}"`, (name, value) => `"${name}":"${value}"`,
  (name, value) => `'${name}': '${value}'`, (name, value) => `export ${name}=${value}`, (name, value) => `export ${name}="${value}"`,
  (name, value) => `${name} = ${value}`, (name, value) => `  ${name}: ${value}`, (name, value) => `--${name}=${value}`, (name, value) => `-D${name}=${value}`,
  (name, value) => `{"${name}":"${value}","x":1}`, (name, value) => `ENV ${name}=${value}`, (name, value) => `?${name}=${value}&x=1`,
  (name, value) => `${name}="${value}"`, (name, value) => `[${name}=${value}]`, (name, value) => `${name}:"${value}"`,
  (name, value) => `<${name}>${value}</${name}>`, (name, value) => `${name}='${value}'`, (name, value) => `  - ${name}=${value}`,
];
const TOKEN_PLACES: ((token: string) => string)[] = [
  (token) => `Authorization: Bearer ${token}`, (token) => `curl -H "Authorization: token ${token}"`, (token) => `using ${token} now`,
  (token) => `url=https://x-access-token:${token}@github.com/o/r.git`, (token) => `"${token}"`, (token) => `key=${token},`, (token) => `(${token})`,
  (token) => `Bearer ${token}`, (token) => `'${token}'`, (token) => `${token}\t`, (token) => `Authorization: Basic ${token}`,
];
const INTERNAL_ADDRESSES = ["10.1.2.3", "172.20.0.5", "192.168.0.10", "100.100.1.1", "169.254.1.1", "fd12:3456:789a::1", "fe80::1%eth0"];
const ADDRESS_PLACES: ((address: string) => string)[] = [
  (address) => `connect to ${address}:5432 failed`, (address) => `dial tcp ${address}:80: connect: connection refused`, (address) => `Host: ${address}`,
  (address) => `http://${address}/health`, (address) => `addr=${address}`,
];

interface CorpusLine { line: string; gone: string }

/** 12-2 리뷰의 표본(r2-corpus 769줄)과 같은 꼴 — 값은 씨에서 만든 가짜. gone = 가린 뒤 남으면 안 되는 글. */
function corpus(): CorpusLine[] {
  const lines: CorpusLine[] = [];
  let seed = 100;
  for (const name of SECRET_NAMES) {
    for (const shape of FIELD_SHAPES) {
      const value = `Zq81${fakeCharacters(seed++, 12)}`;
      lines.push({ line: shape(name, value), gone: value });
    }
  }
  for (const [user, value, host] of [["app", "", "db:5432/x"], ["", "", "cache:6379"], ["u", "", "c.example.net/db"], ["guest", "", "mq:5672"], ["user", "", "registry.example.com/v2/"]]) {
    void value;
    const secret = `Zq81${fakeCharacters(seed++, 10)}`;
    const scheme = host.startsWith("cache") ? "redis" : host.startsWith("mq") ? "amqp" : host.startsWith("registry") ? "https" : host.startsWith("c.") ? "mongodb+srv" : "postgres";
    lines.push({ line: `${scheme}://${user}:${secret}@${host}`, gone: secret });
  }
  const jdbc = `Zq81${fakeCharacters(seed++, 10)}`;
  lines.push({ line: `jdbc:mysql://h:3306/db?user=root&password=${jdbc}`, gone: jdbc });
  for (const address of INTERNAL_ADDRESSES) for (const place of ADDRESS_PLACES) lines.push({ line: `${place(address)} Zq81IPMARK`, gone: address });
  for (const token of Object.values(FAKE_TOKENS)) for (const place of TOKEN_PLACES) lines.push({ line: place(token), gone: token });
  lines.push({ line: "Author: ci-bot@example.org", gone: "ci-bot@example.org" }, { line: "Author: first.last+tag@sub.example.co.kr", gone: "first.last+tag@sub.example.co.kr" });
  return lines;
}

describe("12-2 리뷰의 표본이 모두 가려진다", () => {
  const lines = corpus();

  it("표본의 수 — 769줄(33 × 20 + URL 6 + 주소 35 + 토큰 66 + 메일 2)", () => {
    expect(lines).toHaveLength(769);
  });

  it.each(lines.map((entry) => [entry.line, entry.gone] as const))("%s", (line, gone) => {
    const masked = maskForAnalysis(line).text;
    expect(masked).not.toContain(gone);
    expect(masked).toMatch(/\[가림:(pem|token|authorization|url_credential|secret_field|hex|email|private_ip)\]/);
    if (line.includes("Zq81IPMARK")) expect(masked).toContain("Zq81IPMARK");
    else expect(masked).not.toContain("Zq81");
    expect(masked.split("\n")).toHaveLength(1);
  });

  it("표본 전체를 한 글로 가려도 같다 — 줄 수가 그대로이고 비밀값이 하나도 남지 않는다", () => {
    const text = lines.map((entry) => entry.line).join("\n");
    const masked = maskForAnalysis(text);
    expect(masked.text.split("\n")).toHaveLength(lines.length);
    for (const entry of lines) expect(masked.text).not.toContain(entry.gone);
    const total = Object.values(masked.counts).reduce((sum, count) => sum + (count ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(lines.length);
    for (const kind of Object.keys(masked.counts)) expect(ANALYSIS_MASK_KINDS as readonly string[]).toContain(kind);
  });
});

describe("정상 글은 그대로", () => {
  it.each([
    ["40자 커밋 SHA", `commit ${"0123456789abcdef".repeat(2)}01234567`],
    ["이미지 다이제스트", `image@sha256:${"a1b2c3d4".repeat(8)}`],
    ["테스트 이름", "--- FAIL: TestTokenRefresh (0.01s)"],
    ["코드 파일 이름", "token_test.go:42: expected 3 got 4"],
    ["LLM 진단 값", "max_tokens=1024 token_count=37 tokenizer=cl100k TOKEN_TYPE=bearer"],
    ["문서용 주소", "GET https://docs.example.com/guide?page=2 → 192.0.2.10 · 198.51.100.7 · 203.0.113.9"],
    ["되돌이 주소", "listening on 127.0.0.1:8080"],
    ["판 번호", "node v20.19.6 · 3.10.0.1.4"],
    ["시험 결과", "PASS: 12 passed, 0 failed"],
    ["한글 문장", "연결 풀이 비었습니다 — 비밀번호 정책 문서를 보세요"],
    ["작업 폴더", "PWD=/app"],
  ])("%s", (_label, line) => {
    expect(maskForAnalysis(line)).toEqual({ text: line, counts: {} });
  });
});

describe("배포 마스터가 이미 가린 출력을 망가뜨리지 않는다", () => {
  it.each([
    "password=[가림:secret_field]", "\"api_key\": \"[가림:secret_field]\"", "Authorization: Bearer [가림:authorization]", "using [가림:token] now",
    "postgres://[가림:url_credential]@db:5432/x", "connect to [가림:private_ip]:5432 failed", "Author: [가림:email]",
    "digest [가림:hex] end",
  ])("%s → 그대로", (line) => {
    expect(maskForAnalysis(line).text).toBe(line);
  });

  it("표시 뒤에 글이 붙은 값 · 입력에 미리 넣은 모르는 표시는 값 전체를 가린다", () => {
    const tail = `Zq81${fakeCharacters(9, 10)}`;
    expect(maskForAnalysis(`DB_PASSWORD=[가림:token]!${tail}`).text).not.toContain(tail);
    expect(maskForAnalysis(`password=[가림:x]${tail}`).text).not.toContain(tail);
  });
});

describe("가림이 12-1 의 줄 구조를 깨지 않는다", () => {
  it("비밀값이 든 근거 묶음의 글 — 줄 수 · `#` 머리 줄 · 줄머리 두 글자가 그대로", () => {
    const secret = `Zq81${fakeCharacters(11, 12)}`;
    const evidence = analysisEvidence(evidenceLogLines(4, (index) => [
      `password=${secret} 연결 실패 ${index}`, `Authorization: Bearer ${FAKE_TOKENS.github}`, `## 가짜 ${FAKE_TOKENS.jwt}`, `connect to 10.1.2.3:5432 failed`,
    ][index]), { facts: [{ label: "대상", value: `front ${FAKE_TOKENS.aws}` }] });
    const text = incidentEvidenceText(evidence);
    const masked = maskForAnalysis(text).text;
    const before = text.split("\n");
    const after = masked.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((line) => /^ {0,3}#/.test(line))).toEqual(before.filter((line) => /^ {0,3}#/.test(line)));
    expect(after.map((line) => line.slice(0, 2))).toEqual(before.map((line) => line.slice(0, 2)));
    for (const gone of [secret, FAKE_TOKENS.github, FAKE_TOKENS.jwt, FAKE_TOKENS.aws, "10.1.2.3"]) expect(masked).not.toContain(gone);
  });

  it("값은 줄을 넘어 먹지 않는다 — 비밀 칸의 값이 비면 다음 줄은 그대로", () => {
    expect(maskForAnalysis("password=\n다음 줄 그대로").text.split("\n")[1]).toBe("다음 줄 그대로");
  });
});

describe("세는 수", () => {
  it("종류마다 가린 횟수", () => {
    const masked = maskForAnalysis(`password=Zq81aaaaaaaa\nusing ${FAKE_TOKENS.github} and ${FAKE_TOKENS.openAi}\nmail ops@example.org`);
    expect(masked.counts.secret_field).toBe(1);
    expect(masked.counts.token).toBe(2);
    expect(masked.counts.email).toBe(1);
  });
});

describe("시간은 입력에 비례한다(12-2 가 겪은 제곱 시간 — 최악 입력)", () => {
  const SIZE = 256 * 1024;
  const repeated = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  it.each([
    ["token- 되풀이", repeated("token-")], ["password= 되풀이", repeated("password=")], ["password 되풀이", repeated("password")],
    ["a@ 되풀이", repeated("a@")], ["1. 되풀이", repeated("1.")], ["16진만", repeated("f")], ["eyJ 되풀이", repeated("eyJ")],
    ["Bearer 되풀이", repeated("Bearer ")], ["://a: 되풀이", repeated("://a:")], ["<password> 되풀이", repeated("<password>")],
    ["--password 되풀이", repeated("--password ")], ["docker login -p 되풀이", repeated("docker login -p ")], ["fd00: 되풀이", repeated("fd00:")],
    ["따옴표 이스케이프 되풀이", repeated("\"password\":\"\\")], ["gh" + "p_ 되풀이", repeated("gh" + "p_")],
  ])("%s — 256KB 가 1.5초 안", (_label, text) => {
    const started = performance.now();
    const masked = maskForAnalysis(text);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(masked.text.length).toBeGreaterThan(0);
  });
});
