/** 근거 묶음 → 글의 구조(명세 ⑫ §11 1) — 다른 서버에서 온 글자는 글의 줄 구조(`# 문제:` 머리 · `## ` 구역)를 꾸며 낼 수 없다.
 * - 한 줄짜리 칸: 줄 끝 글자 여덟 가지(`\r\n` · `\r` · `\n` · U+2028 · U+2029 · U+0085 · `\v` · `\f` — `\r\n` 은 하나로 친다)와 그 밖의 제어 문자(Cc)는 빈칸 하나로.
 * - 여러 줄을 보이는 칸(로그의 글): 첫 줄은 그 로그 줄(`- <at> …`)에 그대로 잇고, 이어지는 줄은 줄마다 앞에 `| ` 를 붙인다(같은 여덟 가지로 나눈다).
 * 글을 같은 여덟 가지 줄 끝으로 나눈 모든 줄에서 `#` 로 시작하는 줄(앞 공백 0~3칸 포함)은 직렬화가 스스로 쓴 머리뿐이다.
 * 다른 서버에서 온 칸은 incident-evidence.ts · incident-list.ts 를 읽어 모두 적었다(아래 FIELD_CASES). 검사를 거친 칸(로그 수준 · 배포 상태 · 커밋 관계)과
 * 이 서버가 만든 글자(기간 · 값의 글 · 실패의 고정 글)는 넣지 않았다. */
import { describe, expect, it } from "vitest";
import { incidentEvidenceText } from "@/features/incidents/lib/incident-evidence-text";
import type {
  AlertHistoryView, EvidenceDeploymentsView, EvidenceLogLine, EvidenceLogsView, EvidenceResourcesView, IncidentEvidence,
} from "@/features/incidents/lib/incident-evidence";
import { openIncidentsFrom } from "@/features/incidents/lib/incident-list";
import type { TraceResourcesView, TraceServerLocation } from "@/features/log-trace/lib/trace-resources";
import { HOUR, MINUTE, NOW, alertRecord, deployment, iso, monitor, monitors, ok, quietSources } from "@/features/incidents/lib/incidents-test-fakes";

const DOWN_AT = NOW - 20 * MINUTE;

const LINE_TERMINATORS = [
  ["CR LF", "\r\n"], ["CR", "\r"], ["LF", "\n"], ["LS(U+2028)", "\u2028"], ["PS(U+2029)", "\u2029"], ["NEL(U+0085)", "\u0085"], ["VT", "\v"], ["FF", "\f"],
] as const;
/** 글을 나누는 줄 끝 — `\r\n` 을 먼저(하나로 친다). */
const ANY_LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029\u0085\v\f]/;
/** `\n` 밖의 줄 끝 글자 — 글은 `\n` 으로만 잇는다. */
const OTHER_LINE_TERMINATOR = /[\r\u2028\u2029\u0085\v\f]/;
const HEADING_LINE = /^ {0,3}#/;

const CLEAN_VALUE = "깨끗한값";
/** 가짜 머리를 심은 값 — 가짜 구역 · 가짜 문제 머리 · 세 칸 들여 쓴 가짜 구역. */
function injectedValue(terminator: string): string {
  return ["앞", "## 가짜 구역", "# 문제: 가짜", "   ## 세 칸 가짜", "뒤"].join(terminator);
}
/** 한 줄짜리 칸에 실린 모습 — 줄 끝 하나가 빈칸 하나. */
const FLATTENED_VALUE = "앞 ## 가짜 구역 # 문제: 가짜    ## 세 칸 가짜 뒤";
/** 로그의 글에 실린 모습 — 첫 줄은 로그 줄 끝에, 이어지는 줄마다 `| `. */
const CONTINUATION_LINES = ["| ## 가짜 구역", "| # 문제: 가짜", "|    ## 세 칸 가짜", "| 뒤"];

// ── 바탕 묶음(칸이 모두 값) ───────────────────────────────

function downIncident() {
  const list = openIncidentsFrom(quietSources({ monitors: ok(monitors([monitor({ name: "front", status: "DOWN", downSince: iso(DOWN_AT), reason: "status 502" })])) }));
  return list.incidents[0];
}

function logLineOf(overrides: Partial<EvidenceLogLine> = {}): EvidenceLogLine {
  const at = iso(DOWN_AT - MINUTE);
  return { id: `${Date.parse(at)}-0`, at, level: "error", service: "front", requestId: "req-1", message: "한 줄 메시지", href: "/logs?selected=1", ...overrides };
}

function alertView(recordOverrides: Parameters<typeof alertRecord>[0] = {}): AlertHistoryView {
  return { from: iso(DOWN_AT - HOUR), to: iso(DOWN_AT + HOUR), coversWindow: true, records: [alertRecord({ at: iso(DOWN_AT), key: "front", title: "응답 없음: front", ...recordOverrides })] };
}

function logsView(overrides: Partial<EvidenceLogsView> = {}, lineOverrides: Partial<EvidenceLogLine> = {}): EvidenceLogsView {
  return {
    scope: "levels", from: iso(DOWN_AT - 10 * MINUTE), to: iso(DOWN_AT + 10 * MINUTE), services: ["front"], requestId: null,
    lines: [logLineOf(lineOverrides)], truncated: false, noticeText: null, ...overrides,
  };
}

function windowView(deploymentOverrides: Parameters<typeof deployment>[0] = {}): EvidenceDeploymentsView {
  const recent = deployment({ requestId: "req-deploy-7", service: "backend", commitSha: "e".repeat(40), state: "failed", failedStage: "cd_health", acceptedAt: iso(DOWN_AT - 30 * MINUTE), ...deploymentOverrides });
  return { kind: "window", from: iso(DOWN_AT - HOUR), to: iso(DOWN_AT), coversWindow: true, deployments: [{ ...recent, href: "/deploys?selected=req-deploy-7" }] };
}

function rangeView(overrides: { baseRequestId?: string; baseCommitSha?: string; headCommitSha?: string; sha?: string; subject?: string } = {}): EvidenceDeploymentsView {
  return {
    kind: "range", status: "range", baseRequestId: overrides.baseRequestId ?? "req-ok-1", baseCommitSha: overrides.baseCommitSha ?? "c".repeat(40),
    headCommitSha: overrides.headCommitSha ?? "b".repeat(40),
    commits: [{ sha: overrides.sha ?? "b".repeat(40), authorName: "jun", authoredAt: iso(NOW - HOUR), subject: overrides.subject ?? "커밋 제목", body: "", bodyTruncated: false }],
    truncated: false, relation: "ancestor", detailHref: "/deploys?selected=req-failed-1",
  };
}

function foundLocation(overrides: Partial<Extract<TraceServerLocation, { kind: "found" }>> = {}): TraceServerLocation {
  return {
    kind: "found", server: "s158", matchedBy: "container", serviceContainer: "front-app", containers: ["front-app"], alsoSeenOn: ["s9"], uncheckedServers: ["s7"],
    skippedServerCount: 0, unreadableServerNameCount: 0, ...overrides,
  };
}

function traceView(location: TraceServerLocation, service = "front"): EvidenceResourcesView {
  const trace: TraceResourcesView = {
    service, atMilliseconds: DOWN_AT, fromMilliseconds: DOWN_AT - 5 * MINUTE, toMilliseconds: DOWN_AT + 5 * MINUTE, location: ok(location),
    host: ok({ source: "raw", stepMilliseconds: 30_000, pointCount: 20, noRecord: false, values: [
      { label: "CPU", unit: "percent", atLogValue: 97.5, atLogText: "97.5%", maximumValue: 99, maximumText: "99.0%" },
    ] }),
    container: null,
  };
  return { kind: "trace", trace };
}

function serverView(overrides: { server?: string; receivedAt?: string } = {}): EvidenceResourcesView {
  return {
    kind: "server", server: overrides.server ?? "s158", found: true, cpuText: "3.4%", memoryText: "12.5%", diskText: "86.0%",
    receivedAt: overrides.receivedAt ?? iso(NOW - 19_000), resourcesHref: "/resources?range=1h#resource-server-s158",
  };
}

function baseEvidence(overrides: Partial<IncidentEvidence> = {}): IncidentEvidence {
  return {
    incident: downIncident(),
    facts: [{ label: "대상", value: "front" }, { label: "상태", value: "DOWN" }],
    alertHistory: { state: "value", value: alertView() },
    logs: { state: "value", value: logsView() },
    deployments: { state: "value", value: windowView() },
    resources: { state: "value", value: traceView(foundLocation()) },
    reductions: [],
    ...overrides,
  };
}

// ── 다른 서버에서 온 칸 ──────────────────────────────────

interface FieldCase {
  /** 어디서 온 칸인가 → 글의 어디에 실리는가 */
  field: string;
  shape: "한 줄" | "여러 줄";
  evidence: (value: string) => IncidentEvidence;
}

/** 무엇이 · 언제부터 — 종류마다 다른 서버에서 온 값의 칸(factsOf). */
const FACT_LABELS: readonly [kind: string, labels: string[]][] = [
  ["감시 대상 DOWN", ["대상", "이유", "DOWN 시각"]],
  ["배포 실패", ["서비스", "커밋", "요청 ID", "실패 단계", "접수 시각", "끝난 시각"]],
  ["자원 임계값", ["서버", "규칙", "대상", "심각도", "언제부터"]],
  ["오류 로그", ["서비스"]],
];

const FIELD_CASES: FieldCase[] = [
  // 머리
  { field: "문제의 대상(감시 대상 이름 · 배포 서비스 · `서버 <서버> <규칙>[ <firing 대상>]` · 오류 로그 서비스) → `# 문제:` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ incident: { ...downIncident(), target: value } }) },
  { field: "언제부터(감시 대상 down_since · 배포 finished_at/accepted_at · firing.since) → `- 언제부터:` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ incident: { ...downIncident(), since: value } }) },
  // 무엇이 · 언제부터
  ...FACT_LABELS.flatMap(([kind, labels]) => labels.map((label): FieldCase => ({
    field: `무엇이 · 언제부터 — ${kind}의 ${label} → \`- ${label}:\` 줄`, shape: "한 줄",
    evidence: (value) => baseEvidence({ facts: labels.map((candidate) => ({ label: candidate, value: candidate === label ? value : "x" })) }),
  }))),
  // 관련 알림(알림 서버 /incidents)
  ...(["at", "kind", "key", "title"] as const).map((name): FieldCase => ({
    field: `관련 알림 — 기록의 ${name} → 기록 줄`, shape: "한 줄",
    evidence: (value) => baseEvidence({ alertHistory: { state: "value", value: alertView({ [name]: value }) } }),
  })),
  // 로그(관측 서버 /logs)
  { field: "로그 — 서비스 거름(오류 로그 문제의 서비스 = 로그 줄의 service) → `서비스:` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ logs: { state: "value", value: logsView({ services: [value, "backend"] }) } }) },
  { field: "로그 — 요청 ID 거름(배포의 request_id) → `요청 ID:` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ logs: { state: "value", value: logsView({ requestId: value }) } }) },
  ...(["at", "service", "requestId"] as const).map((name): FieldCase => ({
    field: `로그 — 줄의 ${name} → 로그 줄`, shape: "한 줄",
    evidence: (value) => baseEvidence({ logs: { state: "value", value: logsView({}, { [name]: value }) } }),
  })),
  { field: "로그 — 줄의 message → 로그 줄 + 이어지는 `| ` 줄들", shape: "여러 줄",
    evidence: (value) => baseEvidence({ logs: { state: "value", value: logsView({}, { message: value }) } }) },
  // 배포 — 창(배포 마스터 /deploys)
  ...(["acceptedAt", "service", "commitSha", "failedStage", "requestId"] as const).map((name): FieldCase => ({
    field: `배포(창) — 배포의 ${name} → 배포 줄`, shape: "한 줄",
    evidence: (value) => baseEvidence({ deployments: { state: "value", value: windowView({ [name]: value }) } }),
  })),
  // 배포 — 범위(배포 마스터 /deploys · /deploys/git/commits)
  ...(["baseRequestId", "baseCommitSha", "headCommitSha", "sha", "subject"] as const).map((name): FieldCase => ({
    field: `배포(범위) — ${name} → 앞 성공 배포 · 이번 배포 커밋 · 커밋 줄`, shape: "한 줄",
    evidence: (value) => baseEvidence({ deployments: { state: "value", value: rangeView({ [name]: value }) } }),
  })),
  // 자원 — 서버(관측 서버 /metrics/latest)
  { field: "자원(서버) — firing 의 서버 → `서버 …:` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ resources: { state: "value", value: serverView({ server: value }) } }) },
  { field: "자원(서버) — received_at → `마지막 수신:` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ resources: { state: "value", value: serverView({ receivedAt: value }) } }) },
  // 자원 — 그때 값(관측 서버 /metrics/latest · /metrics/containers)
  { field: "자원(그때) — 서비스 → `서비스 … · 기준 시각` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ resources: { state: "value", value: traceView(foundLocation(), value) } }) },
  { field: "자원(그때) — 고른 서버 이름 → `서버 …` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ resources: { state: "value", value: traceView(foundLocation({ server: value })) } }) },
  { field: "자원(그때) — 그 서비스 컨테이너 이름 → `서버 … (<컨테이너>)` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ resources: { state: "value", value: traceView(foundLocation({ serviceContainer: value })) } }) },
  { field: "자원(그때) — 같은 서비스가 보인 다른 서버 → `같은 서비스가 서버 … 에도 보였습니다` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ resources: { state: "value", value: traceView(foundLocation({ alsoSeenOn: [value] })) } }) },
  { field: "자원(그때) — 확인하지 못한 서버 → `서버 … 는 확인하지 못함` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ resources: { state: "value", value: traceView(foundLocation({ uncheckedServers: [value] })) } }) },
  { field: "자원(그때) — 어느 서버였는지 모를 때 묻지 못한 서버 → `어느 서버였는지 확인하지 못함 — 서버 … 에 묻지 못했습니다` 줄", shape: "한 줄",
    evidence: (value) => baseEvidence({ resources: { state: "value", value: traceView({ kind: "unknown", failedServers: [value], skippedServerCount: 0, unreadableServerNameCount: 0 }) } }) },
];

function linesOf(text: string): string[] {
  return text.split(ANY_LINE_TERMINATOR);
}

function headingLines(text: string): string[] {
  return linesOf(text).filter((line) => HEADING_LINE.test(line));
}

describe("다른 서버에서 온 칸은 글의 머리를 만들 수 없다 — 칸 × 줄 끝 글자 여덟 가지", () => {
  it("칸 표가 비지 않았다(다른 서버에서 온 칸을 모두 적었다)", () => {
    expect(FIELD_CASES.length).toBeGreaterThanOrEqual(40);
  });

  for (const fieldCase of FIELD_CASES) {
    describe(fieldCase.field, () => {
      const cleanText = incidentEvidenceText(fieldCase.evidence(CLEAN_VALUE));
      const cleanHeadings = headingLines(cleanText);

      it("깨끗한 값은 그 칸에 그대로 실린다(이 칸이 글에 실린다)", () => {
        expect(cleanText).toContain(CLEAN_VALUE);
        expect(cleanHeadings[0]).toMatch(/^# 문제: /);
      });

      it.each(LINE_TERMINATORS)("%s — `#` 로 시작하는 줄은 직렬화가 쓴 머리뿐(수와 `## ` 구역의 글자가 깨끗한 값 때와 같다) · 글은 `\\n` 으로만 잇는다", (_name, terminator) => {
        const text = incidentEvidenceText(fieldCase.evidence(injectedValue(terminator)));
        const headings = headingLines(text);
        expect(headings).toHaveLength(cleanHeadings.length);
        expect(headings[0]).toBe(linesOf(text)[0]);
        expect(headings[0]).toMatch(/^# 문제: /);
        expect(headings.slice(1)).toEqual(cleanHeadings.slice(1));
        expect(text).not.toMatch(OTHER_LINE_TERMINATOR);
        if (fieldCase.shape === "한 줄") {
          expect(text).toContain(FLATTENED_VALUE);
        } else {
          const lines = linesOf(text);
          const start = lines.findIndex((line) => line.startsWith("- ") && line.endsWith(" 앞"));
          expect(start, "로그 줄(첫 줄이 이어진 줄)이 없다").toBeGreaterThanOrEqual(0);
          expect(lines.slice(start + 1, start + 1 + CONTINUATION_LINES.length)).toEqual(CONTINUATION_LINES);
        }
      });
    });
  }
});

describe("한 줄짜리 칸의 그 밖의 제어 문자도 빈칸 하나로", () => {
  const CONTROL_CHARACTERS = [["NUL", "\u0000"], ["TAB", "\t"], ["ESC", "\u001b"], ["DEL", "\u007f"], ["CSI(U+009B)", "\u009b"]] as const;
  const singleLineCases = FIELD_CASES.filter((fieldCase) => fieldCase.shape === "한 줄");
  for (const fieldCase of singleLineCases) {
    it.each(CONTROL_CHARACTERS)(`${fieldCase.field} — %s`, (_name, character) => {
      const text = incidentEvidenceText(fieldCase.evidence(`앞${character}${character}뒤`));
      expect(text).toContain("앞  뒤");
      expect(text).not.toContain(character);
    });
  }
});

describe("여러 줄의 로그 글", () => {
  it("줄 끝이 섞여 있어도 이어지는 줄마다 `| ` — 빈 줄도 `|` 로 시작한다", () => {
    const message = "첫 줄\r\n\tat a.b(C.kt:1)\u2028## 가짜 구역\n\n끝";
    const text = incidentEvidenceText(baseEvidence({ logs: { state: "value", value: logsView({}, { message }) } }));
    const lines = linesOf(text);
    const start = lines.findIndex((line) => line.startsWith("- ") && line.endsWith(" 첫 줄"));
    expect(start).toBeGreaterThanOrEqual(0);
    const continuation = lines.slice(start + 1, start + 5);
    expect(continuation.map((line) => line.startsWith("|"))).toEqual([true, true, true, true]);
    expect(continuation[1]).toBe("| ## 가짜 구역");
    expect(continuation[3]).toBe("| 끝");
    expect(headingLines(text).filter((line) => line.includes("가짜"))).toEqual([]);
  });

  it("한 줄짜리 로그 글은 지금처럼 로그 줄 끝에 그대로(`| ` 줄이 없다)", () => {
    const text = incidentEvidenceText(baseEvidence());
    expect(text).toContain(`- ${iso(DOWN_AT - MINUTE)} error front req-1 한 줄 메시지`);
    expect(linesOf(text).filter((line) => line.startsWith("|"))).toEqual([]);
  });
});
