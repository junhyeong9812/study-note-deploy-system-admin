/** 문제 화면의 본문(서버 컴포넌트 — 스크립트 · 폼 · 단추 없음, 읽기 전용). 받은 값만 그린다 — 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 목록: 문제마다 종류 · 대상 · 언제부터 · 심한 정도를 글로(색만으로 전하지 않는다) + 그 문제로 가는 링크. 목록 위에 확인하지 못한 출처의 줄 · 빈 목록의 말.
 * 문제 하나: 칸마다 제목(EVIDENCE_SECTION_TITLES)이 있는 구역 — 로그 줄은 로그 화면의 그 줄로, 배포는 배포 이력의 그 배포로, 자원은 서버 자원 화면의 그 서버로 가는 링크.
 * 글(로그 · 알림 · 커밋)은 React 의 글자 출력(이스케이프)으로만. 근거 묶음은 fitIncidentEvidence 를 거친 것 — 글(incidentEvidenceText)과 같은 내용이다.
 *
 * 테스트가 고정한 꼴(app/incidents/incidents-page.test.ts):
 * - 본문은 `<main>` 하나. 목록은 `<section aria-labelledby="incident-list">` 안의 표 — 머리 칸 `<th scope="col">` 종류 · 대상 · 언제부터 · 심한 정도.
 *   줄마다 대상 칸에 그 문제로 가는 링크(incidentHref). 언제부터 = formatKoreanTime(since), since 가 없으면 감시 대상은 "모름" · 오류 로그는 "최근 10분".
 *   오류 로그의 대상 칸은 `<서비스> — <errorCountText>`. 확인하지 못한 출처의 줄(text) · errorLogsTruncated 글 · 확인한 범위의 줄(scopeNotes) · emptyText 는 표 위에.
 * - 문제 하나: 구역마다 `<section aria-labelledby="evidence-<칸>">` + `<h2 id="evidence-<칸>">` — 칸 = facts · alertHistory · logs · deployments · resources
 *   (이 차례), 줄인 것이 있으면 그 뒤에 evidence-reductions. facts 의 값 · 시각은 글과 같은 글자 그대로(KST 는 덧붙여도 된다). 커밋 · 요청 ID 는 전체 글자.
 * - 조치(명세 ⑫ §24): `<section aria-labelledby="incident-actions">` — 서비스가 하나로 정해지면 조치마다 ⑥ 의 확인 화면으로 가는 링크
 *   (`/deploys/redeploy?service=&incident=&action=` — 판은 글에만 보이고 주소에 싣지 않는다 · 판을 정할 수 없으면 링크 대신 까닭) · "Claude 가 권함"은 표시일 뿐 ·
 *   이 문제에서 접수한 배포(배포 이력의 그 배포로). 폼 · 단추는 두지 않는다(첫 걸음은 GET 링크).
 * - 근거 묶음의 머리에 그 문제의 분석 화면(`/incidents/analysis?incident=<식별자>` — 저장된 분석 · 분석 요청)으로 가는 링크 "분석".
 * - 닫힘 · 확인하지 못함 · 입력 거절(UPSTREAM_FAILURE_MESSAGES.invalid_input)에는 `<a href="/incidents">문제 목록으로</a>`.
 * - 본문의 링크는 /incidents(· /incidents/analysis) · /logs · /deploys · /resources 로만(요청 추적 화면은 아직 없다). 폼 · 단추 · 입력 칸 · on* 속성 없음. */
import type { ReactNode } from "react";
import { failedStageLabel, formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import { StateBadge } from "@/features/deploys/ui/DeployHistoryTable";
import { DEPLOY_HISTORY_DEFAULT_LIMIT, DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import { deploysHref } from "@/features/deploys/ui/deploys-address";
import { incidentRedeployPreviewHref } from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import {
  INCIDENT_ACTION_KINDS, INCIDENT_ACTION_LABELS, INCIDENT_ACTION_TEXT, type IncidentActionsView,
} from "@/features/incidents/lib/incident-actions";
import {
  EVIDENCE_SECTION_TITLES, EVIDENCE_TEXT, evidenceCellNotice,
  type AlertHistoryView, type EvidenceCell, type EvidenceDeploymentsView, type EvidenceLogsView, type EvidenceResourcesView, type EvidenceSection,
  type IncidentEvidence,
} from "@/features/incidents/lib/incident-evidence";
import { EVIDENCE_REDUCTIONS_TITLE } from "@/features/incidents/lib/incident-evidence-text";
import { incidentAnalysisHref } from "@/features/incident-analysis/lib/incident-analysis-screen";
import { INCIDENT_LIST_TEXT, errorCountText, type IncidentList, type OpenIncident } from "@/features/incidents/lib/incident-list";
import { INCIDENTS_PATH, incidentHref } from "@/features/incidents/lib/incidents-query";
import { SELECTED_INCIDENT_TEXT, type IncidentsScreenData, type SelectedIncident } from "@/features/incidents/lib/incidents-screen";
import type { IncidentsScreenOutcome } from "@/features/incidents/server/incidents-screen";
import { TraceResourcesBlock } from "@/features/log-trace/ui/TraceResourcesBlock";
import { LevelBadge, formatKoreanLogTime } from "@/features/logs/ui/LogTable";
import { UPSTREAM_FAILURE_MESSAGES } from "@/shared/lib/upstream-result";
import parts from "@/shared/ui/screen-parts.module.css";
import styles from "@/features/incidents/ui/IncidentsScreen.module.css";

export interface IncidentsScreenProps {
  outcome: IncidentsScreenOutcome;
}

const SEVERITY_CLASS: Readonly<Record<OpenIncident["severity"], string>> = { critical: styles.critical, warning: styles.warning };
const ROW_CLASS: Readonly<Record<OpenIncident["severity"], string>> = { critical: styles.rowCritical, warning: styles.rowWarning };

function KoreanTime({ value }: { value: string }) {
  return <time dateTime={value} title={`UTC ${value}`}>{formatKoreanTime(value)}</time>;
}

function RangeNote({ from, to, children }: { from: string; to: string; children?: ReactNode }) {
  return <p className={styles.rangeNote}>기간(KST) <KoreanTime value={from} /> ~ <KoreanTime value={to} />{children}</p>;
}

function BackToList() {
  return <a href={INCIDENTS_PATH}>{SELECTED_INCIDENT_TEXT.toList}</a>;
}

// ── 목록 ───────────────────────────────────────────────────

function targetText(incident: OpenIncident): string {
  return incident.kind === "error_logs" ? `${incident.service} — ${errorCountText(incident.errorCount, incident.countIsLowerBound)}` : incident.target;
}

function SinceCell({ incident }: { incident: OpenIncident }) {
  if (incident.since !== null) return <td className={styles.time}><KoreanTime value={incident.since} /></td>;
  return <td className={styles.time}>{incident.kind === "error_logs" ? INCIDENT_LIST_TEXT.errorLogsSince : "모름"}</td>;
}

function IncidentListSection({ list, selectedId }: { list: IncidentList; selectedId: string | null }) {
  return (
    <section className={styles.section} aria-labelledby="incident-list">
      <h2 id="incident-list" className={styles.sectionTitle}>열린 문제</h2>
      {list.unchecked.map((failure) => <p key={failure.source} className={styles.failure}>{failure.text}</p>)}
      {list.errorLogsTruncated && <p className={styles.note} role="note">{INCIDENT_LIST_TEXT.errorLogsTruncated}</p>}
      {list.scopeNotes.map((note) => <p key={note} className={styles.note} role="note">{note}</p>)}
      {list.emptyText !== null ? <p className={parts.empty}>{list.emptyText}</p> : (
        <div className={styles.scroller} tabIndex={0} role="region" aria-label="열린 문제 표">
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">종류</th>
                <th scope="col">대상</th>
                <th scope="col">언제부터</th>
                <th scope="col">심한 정도</th>
              </tr>
            </thead>
            <tbody>
              {list.incidents.map((incident) => (
                <tr key={incident.id} className={`${ROW_CLASS[incident.severity]}${incident.id === selectedId ? ` ${styles.rowSelected}` : ""}`}>
                  <td>{incident.kindLabel}</td>
                  <td><a href={incidentHref(incident.id)} aria-current={incident.id === selectedId ? "page" : undefined}>{targetText(incident)}</a></td>
                  <SinceCell incident={incident} />
                  <td><span className={SEVERITY_CLASS[incident.severity]}>{incident.severityLabel}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.meta}>오류 로그는 최근 10분의 오류 줄을 서비스마다 센 수입니다(판정 없음).</p>
    </section>
  );
}

// ── 근거 묶음 ──────────────────────────────────────────────

function EvidenceSectionBlock({ section, children }: { section: EvidenceSection | "reductions"; children: ReactNode }) {
  const id = `evidence-${section}`;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>{section === "reductions" ? EVIDENCE_REDUCTIONS_TITLE : EVIDENCE_SECTION_TITLES[section]}</h2>
      {children}
    </section>
  );
}

/** 값이면 그 칸을, 아니면 한 줄(확인하지 못함 · 대응 표에 없음 · 해당 없음 — 글과 같은 글자). */
function CellBody<Value>({ cell, render }: { cell: EvidenceCell<Value>; render: (value: Value) => ReactNode }) {
  if (cell.state === "value") return <>{render(cell.value)}</>;
  return <p className={cell.state === "failed" ? styles.failure : styles.muted}>{evidenceCellNotice(cell)}</p>;
}

function AlertHistoryBody({ view }: { view: AlertHistoryView }) {
  return (
    <>
      <RangeNote from={view.from} to={view.to} />
      {view.records.length === 0 ? <p className={styles.muted}>{EVIDENCE_TEXT.noRecords}</p> : (
        <ul className={styles.entries}>
          {view.records.map((record, index) => (
            <li key={`${record.at}-${record.key}-${index}`}>
              <KoreanTime value={record.at} />
              <span className={styles.entryKind}>{record.kind}</span>
              <code className={styles.code}>{record.key}</code>
              <span className={styles.entryText}>{record.title}</span>
            </li>
          ))}
        </ul>
      )}
      {!view.coversWindow && <p className={styles.note} role="note">{EVIDENCE_TEXT.alertNotCovered}</p>}
    </>
  );
}

function LogsBody({ view }: { view: EvidenceLogsView }) {
  return (
    <>
      <RangeNote from={view.from} to={view.to}>
        {view.services !== null && <> · 서비스 {view.services.length === 0 ? EVIDENCE_TEXT.noRecords : view.services.join(", ")}</>}
        {view.requestId !== null && <> · 요청 ID <code className={styles.code}>{view.requestId}</code></>}
      </RangeNote>
      {view.noticeText !== null && <p className={styles.note} role="note">{view.noticeText}</p>}
      {view.lines.length === 0 ? <p className={styles.muted}>{EVIDENCE_TEXT.noRecords}</p> : (
        <ol className={styles.entries}>
          {view.lines.map((line) => (
            <li key={line.id}>
              <a href={line.href} aria-label={`${formatKoreanLogTime(line.at)} ${line.service} ${line.level} 로그 화면에서 보기`}>
                <time dateTime={line.at} title={`UTC ${line.at}`}>{formatKoreanLogTime(line.at)}</time>
              </a>
              <span>{line.service}</span>
              <LevelBadge level={line.level} />
              {line.requestId !== "" && <code className={styles.code}>{line.requestId}</code>}
              <span className={styles.message}>{line.message}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function FailedStageText({ stage }: { stage: string }) {
  const label = failedStageLabel(stage);
  return <span>{stage}{label !== null && `(${label})`}</span>;
}

function DeploymentsBody({ view }: { view: EvidenceDeploymentsView }) {
  if (view.kind === "window") {
    return (
      <>
        <RangeNote from={view.from} to={view.to} />
        {view.deployments.length === 0 ? <p className={styles.muted}>{EVIDENCE_TEXT.noRecords}</p> : (
          <ul className={styles.entries}>
            {view.deployments.map((deployment) => (
              <li key={deployment.requestId}>
                <a href={deployment.href} aria-label={`${formatKoreanTime(deployment.acceptedAt)} ${deployment.service} 배포 상세 보기`}>
                  <KoreanTime value={deployment.acceptedAt} />
                </a>
                <span>{deployment.service}</span>
                <StateBadge deployment={deployment} />
                {deployment.failedStage !== null && <FailedStageText stage={deployment.failedStage} />}
                <code className={styles.code}>{deployment.commitSha}</code>
                <code className={styles.code}>{deployment.requestId}</code>
              </li>
            ))}
          </ul>
        )}
        {!view.coversWindow && <p className={styles.note} role="note">{EVIDENCE_TEXT.deployNotCovered}</p>}
      </>
    );
  }
  return (
    <>
      <dl className={styles.summary}>
        <dt>앞 성공 배포</dt>
        <dd>{view.baseRequestId === null ? EVIDENCE_TEXT.noPreviousDeploy : <><code className={styles.code}>{view.baseRequestId}</code> <code className={styles.code}>{view.baseCommitSha}</code></>}</dd>
        <dt>이번 배포 커밋</dt><dd><code className={styles.code}>{view.headCommitSha}</code></dd>
        {view.relation !== null && view.relation !== "ancestor" && <><dt>관계</dt><dd>{view.relation}</dd></>}
      </dl>
      {view.status === "same_commit" && <p className={styles.muted}>{EVIDENCE_TEXT.sameCommit}</p>}
      {view.commits.length > 0 && (
        <ul className={styles.entries}>
          {view.commits.map((commit) => (
            <li key={commit.sha}>
              <code className={styles.code}>{commit.sha}</code>
              <span className={styles.entryText}>{commit.subject}</span>
            </li>
          ))}
        </ul>
      )}
      {view.truncated && <p className={styles.note} role="note">(더 있음)</p>}
      <p><a href={view.detailHref}>배포 이력에서 이 배포 보기 →</a></p>
    </>
  );
}

function ResourcesBody({ view, nowMilliseconds }: { view: EvidenceResourcesView; nowMilliseconds: number }) {
  if (view.kind === "trace") return <TraceResourcesBlock resources={view.trace} nowMilliseconds={nowMilliseconds} />;
  return (
    <>
      <dl className={styles.summary}>
        <dt>서버</dt><dd>{view.server}</dd>
        <dt>CPU</dt><dd>{view.cpuText}</dd>
        <dt>메모리</dt><dd>{view.memoryText}</dd>
        <dt>디스크</dt><dd>{view.diskText}</dd>
        <dt>마지막 수신(KST)</dt><dd>{view.receivedAt === null ? EVIDENCE_TEXT.noRecords : <KoreanTime value={view.receivedAt} />}</dd>
      </dl>
      {!view.found && <p className={styles.muted}>지금 지표를 보낸 서버 목록에 없음</p>}
      <p><a href={view.resourcesHref}>서버 자원 화면에서 보기 →</a></p>
    </>
  );
}

const COMMIT_PREFIX_LENGTH = 7;

/** 조치 구역 — 링크(GET)와 글만. */
function ActionsBlock({ incidentId, actions }: { incidentId: string; actions: IncidentActionsView }) {
  const { service, targets, recommended, taken } = actions;
  return (
    <section className={styles.section} aria-labelledby="incident-actions">
      <h2 id="incident-actions" className={styles.sectionTitle}>{INCIDENT_ACTION_TEXT.title}</h2>
      {!service.ok ? <p className={styles.muted}>{INCIDENT_ACTION_TEXT.serviceReasons[service.reason]}</p> : targets !== null && (
        <ul className={styles.entries}>
          {INCIDENT_ACTION_KINDS.map((kind) => {
            const target = targets[kind];
            return (
              <li key={kind}>
                {target.ok
                  ? <a href={incidentRedeployPreviewHref(service.service, incidentId, kind)}>{`${INCIDENT_ACTION_LABELS[kind]} — ${target.commitSha.slice(0, COMMIT_PREFIX_LENGTH)}`}</a>
                  : <span className={styles.muted}>{`${INCIDENT_ACTION_LABELS[kind]} — ${INCIDENT_ACTION_TEXT.targetReasons[target.reason]}`}</span>}
                {recommended === kind && <> · <strong>{INCIDENT_ACTION_TEXT.recommended}</strong></>}
              </li>
            );
          })}
        </ul>
      )}
      <h3 className={styles.meta}>{INCIDENT_ACTION_TEXT.actionsTitle}</h3>
      {!taken.ok ? <p className={styles.muted}>{INCIDENT_ACTION_TEXT.actionsUnavailable}</p>
        : taken.deployments.length === 0 ? <p className={styles.muted}>{INCIDENT_ACTION_TEXT.noActions}</p> : (
          <ul className={styles.entries}>
            {taken.deployments.map((deployment) => {
              const listService = (DEPLOY_SERVICES as readonly string[]).includes(deployment.service) ? deployment.service as DeployService : null;
              return (
                <li key={deployment.requestId}>
                  <a href={deploysHref({ service: listService, limit: DEPLOY_HISTORY_DEFAULT_LIMIT }, { requestId: deployment.requestId, service: deployment.service })}>
                    <KoreanTime value={deployment.acceptedAt} />
                  </a>
                  <span>{deployment.service}</span>
                  <StateBadge deployment={deployment} />
                  <code className={styles.code}>{deployment.commitSha.slice(0, COMMIT_PREFIX_LENGTH)}</code>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}

function EvidenceBlock({ evidence, checkedAt, actions }: { evidence: IncidentEvidence; checkedAt: string; actions?: IncidentActionsView }) {
  const { incident } = evidence;
  return (
    <div className={styles.evidence}>
      <div className={styles.evidenceHeader}>
        <p className={styles.evidenceTitle}><strong>{incident.kindLabel} — {incident.target}</strong></p>
        <a href={incidentAnalysisHref(incident.id)}>분석</a>
        <BackToList />
      </div>
      <dl className={styles.summary}>
        <dt>식별자</dt><dd><code className={styles.code}>{incident.id}</code></dd>
        <dt>심한 정도</dt><dd><span className={SEVERITY_CLASS[incident.severity]}>{incident.severityLabel}</span></dd>
        <dt>언제부터</dt><dd>{incident.since === null ? "모름" : <>{incident.since} (KST <KoreanTime value={incident.since} />)</>}</dd>
      </dl>
      {actions !== undefined && <ActionsBlock incidentId={incident.id} actions={actions} />}
      <EvidenceSectionBlock section="facts">
        <dl className={styles.summary}>
          {evidence.facts.map((fact) => <FactRow key={fact.label} label={fact.label} value={fact.value} />)}
        </dl>
      </EvidenceSectionBlock>
      <EvidenceSectionBlock section="alertHistory"><CellBody cell={evidence.alertHistory} render={(view) => <AlertHistoryBody view={view} />} /></EvidenceSectionBlock>
      <EvidenceSectionBlock section="logs"><CellBody cell={evidence.logs} render={(view) => <LogsBody view={view} />} /></EvidenceSectionBlock>
      <EvidenceSectionBlock section="deployments"><CellBody cell={evidence.deployments} render={(view) => <DeploymentsBody view={view} />} /></EvidenceSectionBlock>
      <EvidenceSectionBlock section="resources">
        <CellBody cell={evidence.resources} render={(view) => <ResourcesBody view={view} nowMilliseconds={Date.parse(checkedAt)} />} />
      </EvidenceSectionBlock>
      {evidence.reductions.length > 0 && (
        <EvidenceSectionBlock section="reductions">
          <ul className={styles.entries}>{evidence.reductions.map((reduction) => <li key={reduction}>{reduction}</li>)}</ul>
        </EvidenceSectionBlock>
      )}
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

function SelectedBlock({ selected, checkedAt }: { selected: SelectedIncident; checkedAt: string }) {
  if (selected.kind === "evidence") return <EvidenceBlock evidence={selected.evidence} checkedAt={checkedAt} actions={selected.actions} />;
  return (
    <div className={styles.evidence}>
      <p className={selected.kind === "unchecked" ? styles.failure : undefined}>
        {selected.kind === "unchecked" ? SELECTED_INCIDENT_TEXT.unchecked : SELECTED_INCIDENT_TEXT.closed}
      </p>
      <p className={styles.meta}>식별자 <code className={styles.code}>{selected.incidentId}</code></p>
      <p><BackToList /></p>
    </div>
  );
}

function ScreenBody({ data }: { data: IncidentsScreenData }) {
  const selectedId = data.selected === null ? null : data.selected.kind === "evidence" ? data.selected.evidence.incident.id : data.selected.incidentId;
  return (
    <>
      <p className={styles.meta}>
        조회 시각(KST) <KoreanTime value={data.checkedAt} /> · <a href={incidentHref(selectedId)}>새로 고침</a> · 읽기 전용 — 자동으로 새로 고치지 않습니다.
      </p>
      {data.selected !== null && <SelectedBlock selected={data.selected} checkedAt={data.checkedAt} />}
      <IncidentListSection list={data.list} selectedId={selectedId} />
    </>
  );
}

export function IncidentsScreen({ outcome }: IncidentsScreenProps) {
  return (
    <main className={styles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>문제</h1>
        {outcome.kind === "screen" && <p className={parts.count}>열린 문제 <strong>{outcome.data.list.incidents.length}</strong>건</p>}
      </div>
      {outcome.kind === "invalid_input" ? (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>{UPSTREAM_FAILURE_MESSAGES.invalid_input}</p>
          <p className={parts.problemDetail}>문제의 식별자가 맞지 않습니다 — 목록에서 다시 고르세요. <BackToList /></p>
        </div>
      ) : <ScreenBody data={outcome.data} />}
    </main>
  );
}
