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
 * - 자원(trace): 서버(또는 위치를 못 찾은 사유)와 값마다 `- <label>: 그때 <atLogText> · 창의 최대 <maximumText>`.
 *   자원(server): `서버 <server>: CPU <cpuText> · 메모리 <memoryText> · 디스크 <diskText>`.
 * 로그 · 알림의 글(message · title · key)은 믿을 수 없는 입력이다 — 이 함수는 그대로 옮기기만 한다(가리기 · 지시문 처리는 다음 조각의 몫).
 *
 * 크기 상한(fitIncidentEvidence): 글의 UTF-8 바이트가 INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES 를 넘으면 아래 차례로 줄이고, 줄인 것을 reductions 에 한 줄씩 적는다
 * (글의 "줄인 것" · 화면에 그대로 보인다 — 조용히 자르지 않는다):
 * 1. 로그 줄 — 오래된 줄부터 하나씩 뺀다(최신 줄을 남긴다). 단 EVIDENCE_LOG_MINIMUM_LINES 줄까지만.
 * 2. 그래도 넘으면 로그 한 줄의 글(message)이 EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH 자(코드 포인트)를 넘는 줄을 모두 앞 그만큼으로 자른다.
 * 3. 그래도 넘으면 관련 알림 기록 — 오래된 것(뒤)부터 뺀다(0건까지).
 * 4. 그래도 넘으면 배포의 커밋 목록(range) — 뒤(오래된 쪽)부터 뺀다(0개까지).
 * 5. 그래도 넘으면 남은 로그 줄도 오래된 것부터 뺀다(0줄까지).
 * reductions(이 차례, 해당하는 것만 한 줄씩):
 *   `로그 <원래>줄 중 오래된 <뺀 합>줄을 뺐습니다(크기 상한)` · `로그 <자른 수>줄의 글을 앞 <상한>자로 잘랐습니다(크기 상한)` ·
 *   `관련 알림 <원래>건 중 오래된 <뺀>건을 뺐습니다(크기 상한)` · `커밋 <원래>개 중 <뺀>개를 뺐습니다(크기 상한)`.
 * 줄인 뒤의 글(줄인 것 포함)은 상한 이하다. 상한 이하면 받은 묶음과 같은 값(reductions []). 받은 묶음은 바꾸지 않는다.
 *
 * 줄바꿈이 든 글(스택 등)은 이어지는 줄마다 앞에 두 칸(`  `)을 붙인다 — 글의 `## ` 제목 구조를 로그 글이 흉내 내지 못하게. */
import {
  EVIDENCE_SECTION_TITLES, EVIDENCE_TEXT, evidenceCellNotice,
  type AlertHistoryView, type EvidenceCell, type EvidenceDeploymentsView, type EvidenceLogsView, type EvidenceResourcesView, type IncidentEvidence,
} from "@/features/incidents/lib/incident-evidence";
import { TRACE_RESOURCE_TEXT, type TraceSeriesView } from "@/features/log-trace/lib/trace-resources";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

/** Claude 실행 자리의 입력 상한(60KB — findings.md 4절)에서 분석의 지시문 몫을 남긴 크기. */
export const INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES = 48_000;
export const EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH = 1_000;
export const EVIDENCE_LOG_MINIMUM_LINES = 10;
/** 글 · 화면의 "줄인 것" 구역 제목. */
export const EVIDENCE_REDUCTIONS_TITLE = "줄인 것";

/** 줄바꿈이 든 글은 이어지는 줄마다 앞에 두 칸 — 받은 글이 글의 `## ` 제목 · `- ` 줄을 흉내 내지 못하게. */
function indented(text: string): string {
  return text.split("\n").join("\n  ");
}

function alertHistoryLines(view: AlertHistoryView): string[] {
  return [
    `기간: ${view.from} ~ ${view.to}`,
    ...(view.records.length === 0 ? [EVIDENCE_TEXT.noRecords] : view.records.map((record) => `- ${record.at} ${record.kind} ${indented(record.key)} ${indented(record.title)}`)),
    ...(view.coversWindow ? [] : [EVIDENCE_TEXT.alertNotCovered]),
  ];
}

function logsLines(view: EvidenceLogsView): string[] {
  return [
    `기간: ${view.from} ~ ${view.to}`,
    ...(view.services === null ? [] : [`서비스: ${view.services.length === 0 ? EVIDENCE_TEXT.noRecords : view.services.join(", ")}`]),
    ...(view.requestId === null ? [] : [`요청 ID: ${view.requestId}`]),
    ...(view.lines.length === 0 ? [EVIDENCE_TEXT.noRecords]
      : view.lines.map((line) => `- ${line.at} ${line.level} ${line.service} ${line.requestId === "" ? "-" : line.requestId} ${indented(line.message)}`)),
    ...(view.noticeText === null ? [] : [view.noticeText]),
  ];
}

function deploymentsLines(view: EvidenceDeploymentsView): string[] {
  if (view.kind === "window") {
    return [
      `기간: ${view.from} ~ ${view.to}`,
      ...(view.deployments.length === 0 ? [EVIDENCE_TEXT.noRecords] : view.deployments.map((deployment) =>
        `- ${deployment.acceptedAt} ${deployment.service} ${deployment.commitSha} ${deployment.state}${deployment.failedStage === null ? "" : ` ${deployment.failedStage}`} ${deployment.requestId}`)),
      ...(view.coversWindow ? [] : [EVIDENCE_TEXT.deployNotCovered]),
    ];
  }
  return [
    view.baseRequestId === null ? EVIDENCE_TEXT.noPreviousDeploy : `앞 성공 배포: ${view.baseRequestId} ${view.baseCommitSha}`,
    `이번 배포 커밋: ${view.headCommitSha}`,
    ...(view.status === "same_commit" ? [EVIDENCE_TEXT.sameCommit] : []),
    ...(view.relation !== null && view.relation !== "ancestor" ? [`관계: ${view.relation}`] : []),
    ...view.commits.map((commit) => `- ${commit.sha} ${indented(commit.subject)}`),
    ...(view.truncated ? ["(더 있음)"] : []),
  ];
}

function seriesLines(group: string, series: UpstreamResult<TraceSeriesView> | null, emptyText: string): string[] {
  if (series === null) return [`${group}: ${emptyText}`];
  if (!series.ok) return [`${group}: ${EVIDENCE_TEXT.failed}${series.message}`];
  if (series.value.noRecord) return [`${group}: ${TRACE_RESOURCE_TEXT.noRecord}`];
  return [`${group}:`, ...series.value.values.map((value) => `- ${value.label}: 그때 ${value.atLogText} · 창의 최대 ${value.maximumText}`)];
}

function resourcesLines(view: EvidenceResourcesView): string[] {
  if (view.kind === "server") {
    return [
      `서버 ${view.server}: CPU ${view.cpuText} · 메모리 ${view.memoryText} · 디스크 ${view.diskText}`,
      ...(view.found ? [] : ["지금 지표를 보낸 서버 목록에 없음"]),
      ...(view.receivedAt === null ? [] : [`마지막 수신: ${view.receivedAt}`]),
    ];
  }
  const { trace } = view;
  const header = `서비스 ${trace.service} · 기준 시각 ${new Date(trace.atMilliseconds).toISOString()} · 앞뒤 5분`;
  if (!trace.location.ok) return [header, `${EVIDENCE_TEXT.failed}${trace.location.message}`];
  const location = trace.location.value;
  if (location.kind === "none") return [header, `${TRACE_RESOURCE_TEXT.noRecord} — 그 시각에 ${trace.service} 컨테이너를 본 서버가 없습니다`];
  if (location.kind === "unknown") return [header, TRACE_RESOURCE_TEXT.unknownServer];
  return [
    header,
    `서버 ${location.server}${location.serviceContainer === null ? "" : ` (${location.serviceContainer})`}`,
    ...seriesLines("서버 값", trace.host, TRACE_RESOURCE_TEXT.noRecord),
    ...seriesLines("컨테이너 값", trace.container, location.matchedBy === "serverName" ? EVIDENCE_TEXT.notApplicable : TRACE_RESOURCE_TEXT.noRecord),
  ];
}

function cellLines<Value>(cell: EvidenceCell<Value>, lines: (value: Value) => string[]): string[] {
  return cell.state === "value" ? lines(cell.value) : [evidenceCellNotice(cell) ?? ""];
}

export function incidentEvidenceText(evidence: IncidentEvidence): string {
  const { incident } = evidence;
  const section = (title: string, lines: string[]) => ["", `## ${title}`, ...lines];
  return [
    `# 문제: ${incident.kindLabel} — ${indented(incident.target)}`,
    `- 식별자: ${incident.id}`,
    `- 심한 정도: ${incident.severityLabel}`,
    `- 언제부터: ${incident.since ?? "모름"}`,
    ...section(EVIDENCE_SECTION_TITLES.facts, evidence.facts.map((fact) => `- ${fact.label}: ${indented(fact.value)}`)),
    ...section(EVIDENCE_SECTION_TITLES.alertHistory, cellLines(evidence.alertHistory, alertHistoryLines)),
    ...section(EVIDENCE_SECTION_TITLES.logs, cellLines(evidence.logs, logsLines)),
    ...section(EVIDENCE_SECTION_TITLES.deployments, cellLines(evidence.deployments, deploymentsLines)),
    ...section(EVIDENCE_SECTION_TITLES.resources, cellLines(evidence.resources, resourcesLines)),
    ...(evidence.reductions.length === 0 ? [] : section(EVIDENCE_REDUCTIONS_TITLE, evidence.reductions.map((reduction) => `- ${reduction}`))),
  ].join("\n");
}

/** UTF-8 바이트 수. */
export function evidenceTextBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 줄이는 정도 — 각 차례에서 뺀 수와 글을 잘랐는가. */
interface Reduction {
  logLinesRemoved: number;
  messagesCut: boolean;
  alertRecordsRemoved: number;
  commitsRemoved: number;
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
  return { ...evidence, logs, alertHistory, deployments, reductions };
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
  let reduction: Reduction = { logLinesRemoved: 0, messagesCut: false, alertRecordsRemoved: 0, commitsRemoved: 0 };

  /** 한 차례 — 그 차례에서 맞는 가장 작은 수를 찾으면 끝(true), 못 찾으면 그 차례의 끝까지 줄이고 다음 차례로(false). */
  const step = (low: number, high: number, apply: (count: number) => Reduction): boolean => {
    const count = smallestFitting(low, high, (candidate) => fitsWith(apply(candidate)));
    reduction = apply(count ?? high);
    return count !== null;
  };

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
  if (logCount - removedBefore > 0) step(removedBefore + 1, logCount, (count) => ({ ...reduction, logLinesRemoved: count }));
  return reduced(evidence, reduction);
}
