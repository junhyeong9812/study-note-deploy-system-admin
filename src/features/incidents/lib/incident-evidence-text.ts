/** 근거 묶음 → 글(순수) — 다음 조각(12-4)이 Claude 에게 넘길 글. 화면과 **같은 내용**이다: 화면도 글도 같은 묶음(fitIncidentEvidence 를 거친 것)에서 만든다.
 *
 * 글의 꼴(줄 단위, `\n` 으로 잇는다):
 * ```
 * # 문제: <종류 이름> — <대상>
 * - 식별자: <id>
 * - 심한 정도: <위험|경고>
 * - 언제부터: <since 글자 | 모름>
 *
 * ## 무엇이 · 언제부터
 * - <label>: <value>            (facts 순서)
 *
 * ## 관련 알림
 * <칸의 글>
 * ## 로그
 * ## 배포
 * ## 자원
 * ## 줄인 것                     (reductions 가 있을 때만 — 줄마다 `- <글>`)
 * ```
 * 칸이 값이 아니면 그 칸의 글은 evidenceCellNotice 한 줄. 값의 줄(빠짐없이 — 화면에 보이는 것은 글에도 있다):
 * - 관련 알림: `기간: <from> ~ <to>` · 기록마다 `- <at> <kind> <key> <title>` · 없으면 `없음` · coversWindow false 면 EVIDENCE_TEXT.alertNotCovered.
 * - 로그: `기간: <from> ~ <to>` · 서비스 거름 · 요청 ID · 줄마다 `- <at> <level> <service> <requestId|-> <message>` · noticeText.
 * - 배포(window): `기간` · 배포마다 `- <acceptedAt> <service> <commitSha> <state>[ <failedStage>] <requestId>` · coversWindow false 면 deployNotCovered.
 *   배포(range): `앞 성공 배포: <requestId> <commitSha>` 또는 noPreviousDeploy · 같은 커밋이면 sameCommit · 커밋마다 `- <sha> <subject>` · truncated 면 `(더 있음)`.
 * - 자원(trace): 서버(또는 위치를 못 찾은 사유 — 어느 서버였는지 확인하지 못함이면 unknownLocationText)와 값마다 `- <label>: 그때 <atLogText> · 창의 최대 <maximumText>`,
 *   그 뒤 화면(TraceResourcesBlock)과 같은 판정 · 문구로 — readsRollup 이면 TRACE_ROLLUP_TEXT, foundLocationNotes 의 줄마다 한 줄.
 *   자원(server): `서버 <server>: CPU <cpuText> · 메모리 <memoryText> · 디스크 <diskText>` · 목록에 없으면 그 줄 · `마지막 수신: <receivedAt | 없음>`.
 *
 * 글의 구조는 다른 서버에서 온 글자가 꾸며 낼 수 없다: 글의 줄은 모두 textLine(태그 템플릿 — 반환형 TextLine)으로만 만들고, 끼워 넣는 값은 모두
 * 그 안에서 한 번 거른다(칸마다 따로 처리하지 않는다 — 새 칸도 TextLine 이 아니면 형 검사를 통과하지 못한다):
 * - 한 줄짜리 값: `\r\n` 은 빈칸 하나, 그 밖의 줄 끝(`\r` · `\n` · U+2028 · U+2029 · U+0085 · `\v` · `\f`)과 제어 문자(C0 · DEL · C1)는 글자마다 빈칸 하나.
 * - 여러 줄을 보이는 값(로그의 글 — multiLine): 같은 줄 끝 전부로 나눠 첫 줄은 그 로그 줄에 그대로 잇고, 이어지는 줄마다 앞에 `| `(줄마다 위의 한 줄 거름).
 * 그래서 `#` 로 시작하는 줄(앞 공백 0~3칸 포함 — 마크다운의 제목)은 직렬화가 쓴 머리뿐이다. 글은 `\n` 으로만 잇는다.
 * 가리기 · 지시문 처리는 다음 조각의 몫. 화면은 같은 묶음을 그리되 React 의 글자 출력(이스케이프)으로만 — 이 거름을 쓰지 않는다.
 *
 * 크기 상한(fitIncidentEvidence): 글의 UTF-8 바이트가 INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES 를 넘으면 아래 차례로 줄이고, 줄인 것을 reductions 에 한 줄씩 적는다
 * (글의 "줄인 것" · 화면에 그대로 보인다 — 조용히 자르지 않는다):
 * 0. 글에 싣는 값(로그의 글은 빼고) 가운데 EVIDENCE_VALUE_MAXIMUM_LENGTH 자(코드 포인트)를 넘는 것을 모두 앞 그만큼으로(표시 없이 — 묶음의 valueMaximumLength).
 * 1. 로그 줄 — 오래된 줄부터 하나씩 뺀다(최신 줄을 남긴다). 단 EVIDENCE_LOG_MINIMUM_LINES 줄까지만.
 * 2. 그래도 넘으면 로그 한 줄의 글(message)이 EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH 자(코드 포인트)를 넘는 줄을 모두 앞 그만큼으로 자른다.
 * 3. 그래도 넘으면 관련 알림 기록 — 오래된 것(뒤)부터 뺀다(0건까지).
 * 4. 그래도 넘으면 배포의 커밋 목록(range) — 뒤(오래된 쪽)부터 뺀다(0개까지).
 * 5. 그래도 넘으면 남은 로그 줄도 오래된 것부터 뺀다(0줄까지).
 * 6. 그래도 넘으면 "줄인 것" 구역 앞의 글을 코드 포인트 경계에서 끝을 잘라 상한에 맞춘다(묶음의 textMaximumBytes — "줄인 것" 구역은 글 끝에 남는다).
 * reductions(이 차례, 해당하는 것만 한 줄씩):
 *   `값 <자른 수>개를 앞 <상한>자로 잘랐습니다(크기 상한)` · `로그 <원래>줄 중 오래된 <뺀 합>줄을 뺐습니다(크기 상한)` · `로그 <자른 수>줄의 글을 앞 <상한>자로 잘랐습니다(크기 상한)` ·
 *   `관련 알림 <원래>건 중 오래된 <뺀>건을 뺐습니다(크기 상한)` · `커밋 <원래>개 중 <뺀>개를 뺐습니다(크기 상한)` · `상한을 넘어 끝을 잘랐습니다(크기 상한)`.
 * 줄인 뒤의 글(줄인 것 포함)은 언제나 상한 이하다. 상한 이하면 받은 묶음과 같은 값(reductions []). 받은 묶음은 바꾸지 않는다. */
import {
  EVIDENCE_SECTION_TITLES, EVIDENCE_TEXT, evidenceCellNotice,
  type AlertHistoryView, type EvidenceCell, type EvidenceDeploymentsView, type EvidenceLogsView, type EvidenceResourcesView, type IncidentEvidence,
} from "@/features/incidents/lib/incident-evidence";
import {
  TRACE_RESOURCE_TEXT, TRACE_ROLLUP_TEXT, foundLocationNotes, readsRollup, unknownLocationText, type TraceSeriesView,
} from "@/features/log-trace/lib/trace-resources";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

/** Claude 실행 자리의 입력 상한(60KB — findings.md 4절)에서 분석의 지시문 몫을 남긴 크기. */
export const INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES = 48_000;
export const EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH = 1_000;
export const EVIDENCE_LOG_MINIMUM_LINES = 10;
/** 크기 상한을 넘을 때 글에 싣는 값 하나의 길이(코드 포인트) — 로그의 글은 EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH. */
export const EVIDENCE_VALUE_MAXIMUM_LENGTH = 500;
/** 글 · 화면의 "줄인 것" 구역 제목. */
export const EVIDENCE_REDUCTIONS_TITLE = "줄인 것";

// ── 글의 줄 — 끼워 넣는 값은 모두 여기서 거른다 ────────────────────────

/** 줄 끝 — `\r\n` 을 먼저(하나로 친다). */
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029\u0085\v\f]/;
/** 한 줄짜리 값에서 빈칸 하나가 되는 것 — `\r\n` 한 쌍, 그 밖의 줄 끝과 제어 문자(C0 · DEL · C1)는 글자마다. */
const ONE_LINE_BREAK = /\r\n|[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

declare const TEXT_LINE: unique symbol;
/** 글의 한 줄 — textLine 으로만 만든다(끼워 넣은 값이 걸러졌다는 표시). */
type TextLine = string & { readonly [TEXT_LINE]: true };

/** 여러 줄을 보이는 값(로그의 글) — 이어지는 줄마다 `| `. */
interface MultiLineValue {
  multiLine: string;
}

function multiLine(text: string): MultiLineValue {
  return { multiLine: text };
}

/** 한 줄짜리 값의 거름(textLine 이 값마다 쓰는 것) — 분석의 글(incident-analysis/lib/analysis-prompt.ts)도 같은 거름을 쓴다. */
export function oneLine(text: string): string {
  return text.replace(ONE_LINE_BREAK, " ");
}

/** 글을 줄 끝 글자 여덟 가지(`\r\n` 은 하나로)로 나눈 줄들 — 줄마다 거르지는 않는다(여러 줄 값과 같은 나눔). */
export function splitTextLines(text: string): string[] {
  return text.split(LINE_TERMINATOR);
}

/** 글을 만드는 동안의 거름 — 값 하나의 길이 상한(없으면 null)과 그 상한으로 자른 값의 수. */
interface TextFilter {
  valueMaximumLength: number | null;
  cutValueCount: number;
}

type TextLineWriter = (template: TemplateStringsArray, ...values: (string | number | MultiLineValue)[]) => TextLine;

function textLineWriter(filter: TextFilter): TextLineWriter {
  const filtered = (value: string | number | MultiLineValue): string => {
    if (typeof value === "object") return splitTextLines(value.multiLine).map(oneLine).join("\n| ");
    const text = oneLine(String(value));
    if (filter.valueMaximumLength === null) return text;
    const codePoints = Array.from(text);
    if (codePoints.length <= filter.valueMaximumLength) return text;
    filter.cutValueCount += 1;
    return codePoints.slice(0, filter.valueMaximumLength).join("");
  };
  return (template, ...values) => template.reduce((line, part, index) => line + (index === 0 ? "" : filtered(values[index - 1])) + part, "") as TextLine;
}

// ── 칸마다의 줄 ────────────────────────────────────────────

function alertHistoryLines(textLine: TextLineWriter, view: AlertHistoryView): TextLine[] {
  return [
    textLine`기간: ${view.from} ~ ${view.to}`,
    ...(view.records.length === 0 ? [textLine`${EVIDENCE_TEXT.noRecords}`] : view.records.map((record) => textLine`- ${record.at} ${record.kind} ${record.key} ${record.title}`)),
    ...(view.coversWindow ? [] : [textLine`${EVIDENCE_TEXT.alertNotCovered}`]),
  ];
}

function logsLines(textLine: TextLineWriter, view: EvidenceLogsView): TextLine[] {
  return [
    textLine`기간: ${view.from} ~ ${view.to}`,
    ...(view.services === null ? [] : [textLine`서비스: ${view.services.length === 0 ? EVIDENCE_TEXT.noRecords : view.services.join(", ")}`]),
    ...(view.requestId === null ? [] : [textLine`요청 ID: ${view.requestId}`]),
    ...(view.lines.length === 0 ? [textLine`${EVIDENCE_TEXT.noRecords}`]
      : view.lines.map((line) => textLine`- ${line.at} ${line.level} ${line.service} ${line.requestId === "" ? "-" : line.requestId} ${multiLine(line.message)}`)),
    ...(view.noticeText === null ? [] : [textLine`${view.noticeText}`]),
  ];
}

function deploymentsLines(textLine: TextLineWriter, view: EvidenceDeploymentsView): TextLine[] {
  if (view.kind === "window") {
    return [
      textLine`기간: ${view.from} ~ ${view.to}`,
      ...(view.deployments.length === 0 ? [textLine`${EVIDENCE_TEXT.noRecords}`] : view.deployments.map((deployment) => (deployment.failedStage === null
        ? textLine`- ${deployment.acceptedAt} ${deployment.service} ${deployment.commitSha} ${deployment.state} ${deployment.requestId}`
        : textLine`- ${deployment.acceptedAt} ${deployment.service} ${deployment.commitSha} ${deployment.state} ${deployment.failedStage} ${deployment.requestId}`))),
      ...(view.coversWindow ? [] : [textLine`${EVIDENCE_TEXT.deployNotCovered}`]),
    ];
  }
  return [
    view.baseRequestId === null ? textLine`${EVIDENCE_TEXT.noPreviousDeploy}` : textLine`앞 성공 배포: ${view.baseRequestId} ${view.baseCommitSha ?? ""}`,
    textLine`이번 배포 커밋: ${view.headCommitSha}`,
    ...(view.status === "same_commit" ? [textLine`${EVIDENCE_TEXT.sameCommit}`] : []),
    ...(view.relation !== null && view.relation !== "ancestor" ? [textLine`관계: ${view.relation}`] : []),
    ...view.commits.map((commit) => textLine`- ${commit.sha} ${commit.subject}`),
    ...(view.truncated ? [textLine`(더 있음)`] : []),
  ];
}

function seriesLines(textLine: TextLineWriter, group: string, series: UpstreamResult<TraceSeriesView> | null, emptyText: string): TextLine[] {
  if (series === null) return [textLine`${group}: ${emptyText}`];
  if (!series.ok) return [textLine`${group}: ${EVIDENCE_TEXT.failed}${series.message}`];
  if (series.value.noRecord) return [textLine`${group}: ${TRACE_RESOURCE_TEXT.noRecord}`];
  return [textLine`${group}:`, ...series.value.values.map((value) => textLine`- ${value.label}: 그때 ${value.atLogText} · 창의 최대 ${value.maximumText}`)];
}

function resourcesLines(textLine: TextLineWriter, view: EvidenceResourcesView): TextLine[] {
  if (view.kind === "server") {
    return [
      textLine`서버 ${view.server}: CPU ${view.cpuText} · 메모리 ${view.memoryText} · 디스크 ${view.diskText}`,
      ...(view.found ? [] : [textLine`지금 지표를 보낸 서버 목록에 없음`]),
      textLine`마지막 수신: ${view.receivedAt ?? EVIDENCE_TEXT.noRecords}`,
    ];
  }
  const { trace } = view;
  const header = textLine`서비스 ${trace.service} · 기준 시각 ${new Date(trace.atMilliseconds).toISOString()} · 앞뒤 5분`;
  if (!trace.location.ok) return [header, textLine`${EVIDENCE_TEXT.failed}${trace.location.message}`];
  const location = trace.location.value;
  if (location.kind === "none") return [header, textLine`${TRACE_RESOURCE_TEXT.noRecord} — 그 시각에 ${trace.service} 컨테이너를 본 서버가 없습니다`];
  if (location.kind === "unknown") return [header, textLine`${unknownLocationText(location)}`];
  return [
    header,
    location.serviceContainer === null ? textLine`서버 ${location.server}` : textLine`서버 ${location.server} (${location.serviceContainer})`,
    ...seriesLines(textLine, "서버 값", trace.host, TRACE_RESOURCE_TEXT.noRecord),
    ...seriesLines(textLine, "컨테이너 값", trace.container, location.matchedBy === "serverName" ? EVIDENCE_TEXT.notApplicable : TRACE_RESOURCE_TEXT.noRecord),
    ...(readsRollup(trace) ? [textLine`${TRACE_ROLLUP_TEXT}`] : []),
    ...foundLocationNotes(location).map((note) => textLine`${note}`),
  ];
}

function cellLines<Value>(textLine: TextLineWriter, cell: EvidenceCell<Value>, lines: (textLine: TextLineWriter, value: Value) => TextLine[]): TextLine[] {
  return cell.state === "value" ? lines(textLine, cell.value) : [textLine`${evidenceCellNotice(cell) ?? ""}`];
}

/** 글과 그 글을 만들며 값 상한으로 자른 값의 수. */
function serializedEvidence(evidence: IncidentEvidence, valueMaximumLength: number | null): { text: string; cutValueCount: number } {
  const filter: TextFilter = { valueMaximumLength, cutValueCount: 0 };
  const textLine = textLineWriter(filter);
  const { incident } = evidence;
  const section = (title: string, lines: TextLine[]): TextLine[] => [textLine``, textLine`## ${title}`, ...lines];
  const bodyLines: TextLine[] = [
    textLine`# 문제: ${incident.kindLabel} — ${incident.target}`,
    textLine`- 식별자: ${incident.id}`,
    textLine`- 심한 정도: ${incident.severityLabel}`,
    textLine`- 언제부터: ${incident.since ?? "모름"}`,
    ...section(EVIDENCE_SECTION_TITLES.facts, evidence.facts.map((fact) => textLine`- ${fact.label}: ${fact.value}`)),
    ...section(EVIDENCE_SECTION_TITLES.alertHistory, cellLines(textLine, evidence.alertHistory, alertHistoryLines)),
    ...section(EVIDENCE_SECTION_TITLES.logs, cellLines(textLine, evidence.logs, logsLines)),
    ...section(EVIDENCE_SECTION_TITLES.deployments, cellLines(textLine, evidence.deployments, deploymentsLines)),
    ...section(EVIDENCE_SECTION_TITLES.resources, cellLines(textLine, evidence.resources, resourcesLines)),
  ];
  const body = bodyLines.join("\n");
  const reductionLines: TextLine[] = evidence.reductions.length === 0 ? [] : section(EVIDENCE_REDUCTIONS_TITLE, evidence.reductions.map((reduction) => textLine`- ${reduction}`));
  const tail = reductionLines.map((line) => `\n${line}`).join("");
  const fittedBody = evidence.textMaximumBytes === undefined ? body : cutToBytes(body, evidence.textMaximumBytes - evidenceTextBytes(tail));
  return { text: fittedBody + tail, cutValueCount: filter.cutValueCount };
}

export function incidentEvidenceText(evidence: IncidentEvidence): string {
  return serializedEvidence(evidence, evidence.valueMaximumLength ?? null).text;
}

/** 글의 앞에서 maximumBytes(UTF-8) 안에 드는 만큼 — 코드 포인트 경계에서 자른다(encodeInto 는 글자를 쪼개 쓰지 않는다). 안에 들면 그대로. */
function cutToBytes(text: string, maximumBytes: number): string {
  if (evidenceTextBytes(text) <= maximumBytes) return text;
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(Math.max(0, maximumBytes)));
  return text.slice(0, read);
}

/** UTF-8 바이트 수. */
export function evidenceTextBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 줄이는 정도 — 각 차례에서 뺀 수와 글을 잘랐는가. */
interface Reduction {
  /** 0. 값 상한으로 자른 값의 수(0 이면 자르지 않는다) */
  valuesCut: number;
  logLinesRemoved: number;
  messagesCut: boolean;
  alertRecordsRemoved: number;
  commitsRemoved: number;
  /** 6. 끝을 잘라 맞출 바이트(null 이면 자르지 않는다) */
  endCutBytes: number | null;
}

function cutMessage(message: string): string {
  const codePoints = Array.from(message);
  return codePoints.length > EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH ? codePoints.slice(0, EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH).join("") : message;
}

function isLongMessage(message: string): boolean {
  return Array.from(message).length > EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH;
}

/** 받은 묶음에 줄이는 정도를 적용한 새 묶음(받은 묶음은 바꾸지 않는다) — reductions 도 이 정도에서 만든다. */
function reduced(evidence: IncidentEvidence, reduction: Reduction): IncidentEvidence {
  const reductions: string[] = [];
  if (reduction.valuesCut > 0) reductions.push(`값 ${reduction.valuesCut}개를 앞 ${EVIDENCE_VALUE_MAXIMUM_LENGTH}자로 잘랐습니다(크기 상한)`);
  let { logs, alertHistory, deployments } = evidence;
  if (logs.state === "value") {
    const original = logs.value.lines;
    const keptLines = original.slice(reduction.logLinesRemoved);
    const cutCount = reduction.messagesCut ? keptLines.filter((line) => isLongMessage(line.message)).length : 0;
    if (reduction.logLinesRemoved > 0) reductions.push(`로그 ${original.length}줄 중 오래된 ${reduction.logLinesRemoved}줄을 뺐습니다(크기 상한)`);
    if (cutCount > 0) reductions.push(`로그 ${cutCount}줄의 글을 앞 ${EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH}자로 잘랐습니다(크기 상한)`);
    const lines = reduction.messagesCut ? keptLines.map((line) => ({ ...line, message: cutMessage(line.message) })) : keptLines;
    logs = { state: "value", value: { ...logs.value, lines } };
  }
  if (alertHistory.state === "value" && reduction.alertRecordsRemoved > 0) {
    const records = alertHistory.value.records;
    reductions.push(`관련 알림 ${records.length}건 중 오래된 ${reduction.alertRecordsRemoved}건을 뺐습니다(크기 상한)`);
    // 알림 서버 순서(최신 먼저) — 뒤가 오래된 것
    alertHistory = { state: "value", value: { ...alertHistory.value, records: records.slice(0, records.length - reduction.alertRecordsRemoved) } };
  }
  if (deployments.state === "value" && deployments.value.kind === "range" && reduction.commitsRemoved > 0) {
    const commits = deployments.value.commits;
    reductions.push(`커밋 ${commits.length}개 중 ${reduction.commitsRemoved}개를 뺐습니다(크기 상한)`);
    // master 순서(B 쪽이 먼저) — 뒤가 오래된 쪽
    deployments = { state: "value", value: { ...deployments.value, commits: commits.slice(0, commits.length - reduction.commitsRemoved) } };
  }
  if (reduction.endCutBytes !== null) reductions.push("상한을 넘어 끝을 잘랐습니다(크기 상한)");
  return {
    ...evidence, logs, alertHistory, deployments, reductions,
    ...(reduction.valuesCut > 0 ? { valueMaximumLength: EVIDENCE_VALUE_MAXIMUM_LENGTH } : {}),
    ...(reduction.endCutBytes !== null ? { textMaximumBytes: reduction.endCutBytes } : {}),
  };
}

/** [low, high] 에서 fits 가 참인 가장 작은 수(없으면 null) — 더 많이 뺄수록 글이 짧아진다. */
function smallestFitting(low: number, high: number, fits: (count: number) => boolean): number | null {
  if (low > high || !fits(high)) return null;
  let lower = low;
  let upper = high;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (fits(middle)) upper = middle;
    else lower = middle + 1;
  }
  return lower;
}

/** 크기 상한에 맞춘 묶음(새 객체 — 받은 묶음을 바꾸지 않는다). maximumBytes 는 테스트용(기본 INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES). */
export function fitIncidentEvidence(evidence: IncidentEvidence, maximumBytes: number = INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES): IncidentEvidence {
  if (evidenceTextBytes(incidentEvidenceText(evidence)) <= maximumBytes) return evidence;
  const fitsWith = (reduction: Reduction) => evidenceTextBytes(incidentEvidenceText(reduced(evidence, reduction))) <= maximumBytes;
  const logCount = evidence.logs.state === "value" ? evidence.logs.value.lines.length : 0;
  const alertCount = evidence.alertHistory.state === "value" ? evidence.alertHistory.value.records.length : 0;
  const commitCount = evidence.deployments.state === "value" && evidence.deployments.value.kind === "range" ? evidence.deployments.value.commits.length : 0;
  let reduction: Reduction = { valuesCut: 0, logLinesRemoved: 0, messagesCut: false, alertRecordsRemoved: 0, commitsRemoved: 0, endCutBytes: null };

  /** 한 차례 — 그 차례에서 맞는 가장 작은 수를 찾으면 끝(true), 못 찾으면 그 차례의 끝까지 줄이고 다음 차례로(false). */
  const step = (low: number, high: number, apply: (count: number) => Reduction): boolean => {
    const count = smallestFitting(low, high, (candidate) => fitsWith(apply(candidate)));
    reduction = apply(count ?? high);
    return count !== null;
  };

  // 0. 글에 싣는 값(로그의 글 밖)을 앞 EVIDENCE_VALUE_MAXIMUM_LENGTH 자로
  const valuesCut = serializedEvidence(evidence, EVIDENCE_VALUE_MAXIMUM_LENGTH).cutValueCount;
  if (valuesCut > 0) {
    reduction = { ...reduction, valuesCut };
    if (fitsWith(reduction)) return reduced(evidence, reduction);
  }
  // 1. 오래된 로그 줄 — EVIDENCE_LOG_MINIMUM_LINES 줄까지
  const firstStop = Math.max(0, logCount - EVIDENCE_LOG_MINIMUM_LINES);
  if (firstStop > 0 && step(1, firstStop, (count) => ({ ...reduction, logLinesRemoved: count }))) return reduced(evidence, reduction);
  // 2. 긴 글을 앞 EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH 자로
  if (evidence.logs.state === "value" && evidence.logs.value.lines.slice(reduction.logLinesRemoved).some((line) => isLongMessage(line.message))) {
    reduction = { ...reduction, messagesCut: true };
    if (fitsWith(reduction)) return reduced(evidence, reduction);
  }
  // 3. 오래된 알림 기록 · 4. 커밋 목록의 뒤 · 5. 남은 로그 줄
  const removedBefore = reduction.logLinesRemoved;
  if (alertCount > 0 && step(1, alertCount, (count) => ({ ...reduction, alertRecordsRemoved: count }))) return reduced(evidence, reduction);
  if (commitCount > 0 && step(1, commitCount, (count) => ({ ...reduction, commitsRemoved: count }))) return reduced(evidence, reduction);
  if (logCount - removedBefore > 0 && step(removedBefore + 1, logCount, (count) => ({ ...reduction, logLinesRemoved: count }))) return reduced(evidence, reduction);
  // 6. 그래도 넘으면 끝을 잘라 맞춘다("줄인 것" 구역은 남는다)
  if (!fitsWith(reduction)) reduction = { ...reduction, endCutBytes: maximumBytes };
  return reduced(evidence, reduction);
}
