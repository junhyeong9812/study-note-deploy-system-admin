/** 상태 한눈에 화면의 본문(서버 컴포넌트) — 한 줄 요약 · 조회 시각 · 새로 고침 링크 + 칸마다 카드 하나(감시 대상 · 알림 서버 · 관측 서버 · backend 의존성 · 배포 서버).
 * 받은 값(진입 함수가 다섯 칸을 모은 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 한 칸이 실패해도 나머지 카드는 그린다 — 실패한 카드에만 "<출처>: <가린 이유>"(고정 글자와 HTTP 상태만). 새로 고침은 같은 주소로 가는 링크(자동 새로 고침 없음).
 * 상태는 색 + 기호 + 글자로 보인다. 다른 서버의 글자(대상 이름 · 가린 사유)는 React 의 글자 출력이라 HTML 로 해석되지 않는다. */
import type { ReactNode } from "react";
import type {
  AlertMonitorsView, BackendDependenciesView, ObserveHealthView, ServiceHealthView, StatusCheckName, StatusOverview,
} from "@/features/status/lib/status-overview";
import { formatDuration, formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import { monitorIncidentId } from "@/features/incidents/lib/incident-id";
import { incidentHref } from "@/features/incidents/lib/incidents-query";
import {
  ALERT_HEALTH_WORDS, BACKEND_DEPENDENCY_LABELS, CARD_SERVICES, DEPLOY_MASTER_HEALTH_WORDS, OBSERVE_HEALTH_WORDS, STATUS_CARD_LABELS,
  STATUS_CARD_ORDER, STATUS_PATH, TONE_LABELS, TONE_MARKS, describeMonitor, healthTone, serviceLinksOf, sortMonitors, summarizeStatus,
  type HealthWordDescription, type StatusSummary, type StatusTone,
} from "@/features/status/ui/status-view";
import { statusResourceSummaryItems, type StatusResourcesSummary } from "@/features/status/lib/status-resources";
import { StatusResourcesCard } from "@/features/status/ui/StatusResourcesCard";
import type { UpstreamFailure, UpstreamResult } from "@/shared/lib/upstream-result";
import parts from "@/shared/ui/screen-parts.module.css";
import styles from "@/features/status/ui/StatusScreen.module.css";

const TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  healthy: styles.toneHealthy, problem: styles.toneProblem, pending: styles.tonePending, unknown: styles.toneUnknown, caution: styles.toneCaution,
};

function KoreanTime({ value }: { value: string }) {
  return <time dateTime={value} title={`UTC ${value}`}>{formatKoreanTime(value)}</time>;
}

export function ToneBadge({ tone, label = TONE_LABELS[tone] }: { tone: StatusTone; label?: string }) {
  return (
    <span className={`${styles.badge} ${TONE_CLASS[tone]}`}>
      <span aria-hidden="true" className={styles.badgeMark}>{TONE_MARKS[tone]}</span>
      {label}
    </span>
  );
}

function ServiceLinks({ name }: { name: string }) {
  const links = serviceLinksOf(name);
  if (links === null) return null;
  return (
    <span className={styles.links}>
      <a href={links.logsHref} aria-label={`${name} 의 오류 로그 보기`}>로그 보기</a>
      <a href={links.deploysHref} aria-label={`${name} 의 배포 이력 보기`}>배포 이력</a>
    </span>
  );
}

function joinLabels(items: { label: string }[]): string {
  return items.map((item) => item.label).join(" · ");
}

function Summary({ summary, checkedAt }: { summary: StatusSummary; checkedAt: string }) {
  const tone: StatusTone = summary.problems.length > 0 ? "problem" : summary.unreachable.length > 0 ? "unknown" : summary.pending.length > 0 ? "pending" : "healthy";
  return (
    <div className={`${styles.summary} ${TONE_CLASS[tone]}`} role="status">
      <p className={styles.summaryLine}>
        <span aria-hidden="true" className={styles.summaryMark}>{TONE_MARKS[tone]}</span>
        {summary.allHealthy ? <strong>전부 정상</strong> : (
          <span className={styles.summaryParts}>
            {summary.problems.length > 0
              ? <span><strong>문제 {summary.problems.length}건</strong> — {joinLabels(summary.problems)}</span>
              : <span><strong>문제 없음</strong></span>}
            {summary.unreachable.length > 0 && <span><strong>확인 못 함 {summary.unreachable.length}건</strong> — {joinLabels(summary.unreachable)}</span>}
            {summary.pending.length > 0 && <span><strong>확인 중 {summary.pending.length}건</strong> — {joinLabels(summary.pending)}</span>}
          </span>
        )}
      </p>
      <p className={styles.summaryMeta}>
        조회 시각(KST) <KoreanTime value={checkedAt} /> · <a className={styles.refresh} href={STATUS_PATH}>새로 고침</a>
        <span className={styles.summaryNote}>자동으로 새로 고치지 않습니다.</span>
      </p>
    </div>
  );
}

function FailureLine({ name, failure }: { name: StatusCheckName; failure: UpstreamFailure }) {
  return (
    <p className={styles.failure}>
      {STATUS_CARD_LABELS[name].source}: {failure.message}{failure.status !== undefined && <> · HTTP {failure.status}</>}
    </p>
  );
}

function Card({ name, tone, children }: { name: StatusCheckName; tone: StatusTone; children: ReactNode }) {
  const headingId = `status-card-${name}`;
  const service = CARD_SERVICES[name];
  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <div className={styles.cardHeading}>
        <h2 id={headingId} className={styles.cardTitle}>{STATUS_CARD_LABELS[name].title}</h2>
        <ToneBadge tone={tone} />
        {service !== undefined && <ServiceLinks name={service} />}
      </div>
      {children}
    </section>
  );
}

function HealthWord({ health, words }: { health: ServiceHealthView; words: Readonly<Record<string, HealthWordDescription>> }) {
  const word = words[health.status];
  return (
    <div className={styles.health}>
      <p>
        <code className={styles.code}>{health.status}</code>
        {word !== undefined && <> <strong>{word.label}</strong> — {word.meaning}</>}
      </p>
      {health.failure !== null && <p className={styles.reason}>사유: <span className={styles.reasonText}>{health.failure}</span></p>}
    </div>
  );
}

function HealthCard({ name, cell, words }: { name: StatusCheckName; cell: StatusOverview["alertHealth"]; words: Readonly<Record<string, HealthWordDescription>> }) {
  if (!cell.ok) return <Card name={name} tone="unknown"><FailureLine name={name} failure={cell} /></Card>;
  return <Card name={name} tone={healthTone(cell.value, words)}><HealthWord health={cell.value} words={words} /></Card>;
}

/** 관측 서버 카드의 두 줄 — 밀린 건수와 최근 로그 시각(KST, 조회 시각보다 앞이면 얼마 전인지). 값이 없으면 "—". 판정에는 쓰지 않는다. */
function ObserveProgress({ health, checkedAt }: { health: ObserveHealthView; checkedAt: string }) {
  const now = Date.parse(checkedAt);
  const lastLog = health.lastLogAt === null ? Number.NaN : Date.parse(health.lastLogAt);
  return (
    <div className={styles.health}>
      <p>밀린 건수 {health.backlog === null ? <span className={styles.none}>—</span> : `${health.backlog}건`}</p>
      <p>
        최근 로그 시각(KST) {health.lastLogAt === null ? <span className={styles.none}>—</span> : (
          <>
            <KoreanTime value={health.lastLogAt} />
            {Number.isFinite(lastLog) && Number.isFinite(now) && now > lastLog && <span className={styles.ago}> ({formatDuration(now - lastLog)} 전)</span>}
          </>
        )}
      </p>
    </div>
  );
}

function ObserveHealthCard({ cell, checkedAt }: { cell: StatusOverview["observeHealth"]; checkedAt: string }) {
  if (!cell.ok) return <Card name="observeHealth" tone="unknown"><FailureLine name="observeHealth" failure={cell} /></Card>;
  return (
    <Card name="observeHealth" tone={healthTone(cell.value, OBSERVE_HEALTH_WORDS)}>
      <HealthWord health={cell.value} words={OBSERVE_HEALTH_WORDS} />
      <ObserveProgress health={cell.value} checkedAt={checkedAt} />
    </Card>
  );
}

function MonitorTable({ view, checkedAt }: { view: AlertMonitorsView; checkedAt: string }) {
  const now = Date.parse(checkedAt);
  return (
    <div className={styles.scroller} tabIndex={0} role="region" aria-label="감시 대상 표">
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">대상</th>
            <th scope="col">상태</th>
            <th scope="col">문제 시작(KST)</th>
            <th scope="col">마지막 사유</th>
            <th scope="col">이어 보기</th>
          </tr>
        </thead>
        <tbody>
          {sortMonitors(view.monitors).map((monitor, index) => {
            const described = describeMonitor(monitor);
            const since = monitor.downSince === null ? Number.NaN : Date.parse(monitor.downSince);
            return (
              <tr key={`${index}-${monitor.name}`} className={described.tone === "problem" ? styles.rowProblem : undefined}>
                <td className={styles.monitorName}>{monitor.name}</td>
                <td>
                  <ToneBadge tone={described.tone} />
                  <span className={styles.meaning}>{described.meaning}</span>
                </td>
                <td className={styles.time}>
                  {monitor.downSince === null ? <span className={styles.none}>—</span> : (
                    <>
                      <KoreanTime value={monitor.downSince} />
                      {Number.isFinite(since) && Number.isFinite(now) && now > since && <span className={styles.elapsed}>({formatDuration(now - since)}째)</span>}
                    </>
                  )}
                </td>
                <td className={styles.reasonCell}>
                  {monitor.reason === "" ? <span className={styles.none}>—</span> : <span className={styles.reasonText}>{monitor.reason}</span>}
                </td>
                <td>
                  {monitor.status !== "DOWN" ? (serviceLinksOf(monitor.name) === null ? <span className={styles.none}>—</span> : <ServiceLinks name={monitor.name} />) : (
                    <span className={styles.links}>
                      <a href={incidentHref(monitorIncidentId(monitor.name))} aria-label={`${monitor.name} 의 문제 보기`}>문제 보기</a>
                      <ServiceLinks name={monitor.name} />
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MonitorsCard({ cell, checkedAt }: { cell: StatusOverview["alertMonitors"]; checkedAt: string }) {
  if (!cell.ok) return <Card name="alertMonitors" tone="unknown"><FailureLine name="alertMonitors" failure={cell} /></Card>;
  const view = cell.value;
  const tones = view.monitors.map((monitor) => describeMonitor(monitor).tone);
  const tone: StatusTone = tones.includes("problem") || view.undelivered > 0 ? "problem" : tones.includes("pending") ? "pending" : "healthy";
  const downCount = tones.filter((value) => value === "problem").length;
  return (
    <Card name="alertMonitors" tone={tone}>
      <p className={styles.meta}>
        알림 서버가 30초마다 확인하고 3번 연속 실패하면 문제로 봅니다 · 대상 {view.monitors.length}개{downCount > 0 && <> 중 문제 {downCount}개</>}
        {" "}· 마지막 감시 바퀴(KST) {view.lastRoundAt === null ? "아직 없음" : <KoreanTime value={view.lastRoundAt} />}
        {" "}· {view.undelivered > 0 ? <strong className={styles.undelivered}>못 보낸 알림 {view.undelivered}건</strong> : "못 보낸 알림 없음"}
      </p>
      {view.monitors.length === 0 ? <p className={parts.empty}>감시 대상이 없습니다.</p> : <MonitorTable view={view} checkedAt={checkedAt} />}
    </Card>
  );
}

function DependenciesCard({ cell }: { cell: StatusOverview["backendDependencies"] }) {
  if (!cell.ok) return <Card name="backendDependencies" tone="unknown"><FailureLine name="backendDependencies" failure={cell} /></Card>;
  const view: BackendDependenciesView = cell.value;
  return (
    <Card name="backendDependencies" tone={view.status === "UP" ? "healthy" : "problem"}>
      {view.components.length === 0 ? <p className={styles.meta}>확인한 의존성이 없습니다.</p> : (
        <ul className={styles.dependencies}>
          {view.components.map((component) => (
            <li key={component.name} className={styles.dependency}>
              <span className={styles.dependencyName}>
                <code className={styles.code}>{component.name}</code>
                {BACKEND_DEPENDENCY_LABELS[component.name] !== undefined && <span className={styles.meaning}>{BACKEND_DEPENDENCY_LABELS[component.name]}</span>}
              </span>
              <ToneBadge tone={component.status === "UP" ? "healthy" : "problem"} />
              {component.detail !== null && <span className={styles.reason}>사유: <span className={styles.reasonText}>{component.detail}</span></span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export interface StatusScreenProps {
  overview: StatusOverview;
  /** 조회를 마친 시각(ISO-8601 UTC) — 요약의 조회 시각 · 문제가 이어진 시간의 기준 */
  checkedAt: string;
  /** 서버 자원 요약(loadStatusScreen) — 있으면 기존 카드들 아래에 "서버 자원" 카드, 맨 위 요약에 그 줄을 더한다. 없으면(기존 진입) 그리지 않는다. */
  resources?: UpstreamResult<StatusResourcesSummary>;
}

/** 맨 위 요약에 자원 요약의 줄을 더한다(statusResourceSummaryItems). 단 설정이 없어 부르지 않은 경우(not_configured)는 더하지 않는다 —
 * OBSERVE_SECRET 은 시작 검사의 필수 설정이라 운영에서는 생기지 않고, 그 사정은 카드 안의 "확인하지 못함 — 설정 없음"이 보인다. */
function withResourceItems(summary: StatusSummary, resources: UpstreamResult<StatusResourcesSummary> | undefined): StatusSummary {
  if (resources === undefined || (!resources.ok && resources.reason === "not_configured")) return summary;
  const items = statusResourceSummaryItems(resources);
  const merged: StatusSummary = {
    problems: [...summary.problems, ...items.problems], unreachable: [...summary.unreachable, ...items.unreachable], pending: summary.pending, allHealthy: false,
  };
  merged.allHealthy = merged.problems.length === 0 && merged.unreachable.length === 0 && merged.pending.length === 0;
  return merged;
}

export function StatusScreen({ overview, checkedAt, resources }: StatusScreenProps) {
  const cards: Record<StatusCheckName, ReactNode> = {
    alertMonitors: <MonitorsCard cell={overview.alertMonitors} checkedAt={checkedAt} />,
    alertHealth: <HealthCard name="alertHealth" cell={overview.alertHealth} words={ALERT_HEALTH_WORDS} />,
    observeHealth: <ObserveHealthCard cell={overview.observeHealth} checkedAt={checkedAt} />,
    backendDependencies: <DependenciesCard cell={overview.backendDependencies} />,
    deployMasterHealth: <HealthCard name="deployMasterHealth" cell={overview.deployMasterHealth} words={DEPLOY_MASTER_HEALTH_WORDS} />,
  };
  return (
    <main className={styles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>상태 한눈에</h1>
      </div>
      <Summary summary={withResourceItems(summarizeStatus(overview), resources)} checkedAt={checkedAt} />
      <div className={styles.cards}>
        {STATUS_CARD_ORDER.map((name) => <div key={name} className={name === "alertMonitors" ? styles.cardWide : undefined}>{cards[name]}</div>)}
        {resources !== undefined && <div className={styles.cardWide}><StatusResourcesCard resources={resources} /></div>}
      </div>
    </main>
  );
}
