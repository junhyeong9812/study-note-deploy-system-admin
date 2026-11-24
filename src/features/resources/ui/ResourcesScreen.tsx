/** 서버 자원 화면의 본문(서버 컴포넌트) — 서버마다 한 묶음(이름 · 받은 때 → 현재 값 → 지금 울리는 임계값 → 그래프 → 컨테이너 표 → 고른 컨테이너의 그래프).
 * 2단계(명세 §17): CPU · 메모리 · 디스크 그래프는 늘 보이고, 네트워크 · 디스크 입출력 · GPU 는 펼쳐 둔 서버(주소의 open)만 그린다 —
 * 안 펼친 서버는 "그래프 더 보기" 링크(누르면 그 서버가 open 에 더해진 주소). 펼침이 곧 주소라 자동 갱신 뒤에도 남고, 안 그린 그래프만큼 HTML 이 준다. 기간 고르기 링크.
 * 3단계: 컨테이너 표(재시작 반복 알림은 그 줄에), 이름을 누르면 그 컨테이너의 CPU · 메모리 그래프가 표 아래에 열린다(닫기 링크).
 * 카드 배치(명세 §17 끝 줄): 지표마다 카드 하나 — 이름 → 수치(값 · 세부 · 그 자리의 임계값) → 그래프. CPU · 메모리 · 디스크 카드는 늘 그래프까지,
 * 네트워크 · 디스크 입출력 · GPU 카드는 수치가 늘 보이고 그 서버를 펼쳤을 때만 카드 안에 그래프가 들어온다.
 * 자동 갱신은 스크립트 없이 `<meta http-equiv="refresh">` — 같은 주소를 다시 불러오므로 기간 · 끈 상태 · 펼친 그래프(주소의 값)가 그대로 남는다.
 * 받은 화면 모델(진입 함수가 모은 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다. 클라이언트 스크립트 없음.
 * 값이 없으면 모델의 글("없음" · "읽지 못함" · "확인하지 못함") 그대로 — 0 으로 보이지 않게. 한 구역이 실패해도 나머지는 그린다(실패는 고정 글자와 HTTP 상태만).
 * 울리는 임계값은 그 값 자리에 표식 + 글(심각도 · 규칙 · 언제부터) — 색만으로 전하지 않는다. 자리가 아직 없는 규칙(재시작 반복 · 모르는 규칙)은 묶음 끝의 목록에. */
import type { ReactNode } from "react";
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import { formatAge, formatPercent } from "@/features/resources/lib/resource-format";
import {
  RESOURCE_TEXT, type ContainerRowView, type ContainersView, type ElsewhereFiringView, type FiringView, type GpuGraphs, type GpusView, type GraphView,
  type HostGraphs, type MetricReading, type ResourcesScreen, type SelectedContainerView, type ServerFreshness, type ServerResourceView,
} from "@/features/resources/lib/resources-screen";
import {
  RESOURCE_AUTO_REFRESH_SECONDS, RESOURCE_RANGES, RESOURCE_RANGE_LABELS, resourcesScreenHref, withServerOpen, type ResourceRange, type ResourcesQuery, type ResourcesViewState,
} from "@/features/resources/lib/resources-query";
import { GraphFailure, ResourceGraph } from "@/features/resources/ui/ResourceGraph";
import type { UpstreamFailure } from "@/shared/lib/upstream-result";
import parts from "@/shared/ui/screen-parts.module.css";
import styles from "@/features/resources/ui/ResourcesScreen.module.css";

/** 값 자리에 붙는 규칙 — 그 밖의 규칙은 묶음 끝의 "그 밖의 알림"에. */
const PLACED_RULES: ReadonlySet<string> = new Set(["disk_warning", "disk_critical", "memory", "cpu", "silent"]);
/** 마지막 값이 퍼센트인 규칙. */
const PERCENT_RULES: ReadonlySet<string> = new Set(["disk_warning", "disk_critical", "memory", "cpu"]);

const SEVERITY_MARKS: Readonly<Record<string, string>> = { warning: "!", critical: "‼" };

function KoreanTime({ value }: { value: string }) {
  return <time dateTime={value} title={`UTC ${value}`}>{formatKoreanTime(value)}</time>;
}

function FailureLine({ label, failure }: { label: string; failure: UpstreamFailure }) {
  return (
    <p className={styles.failure}>
      {label}: {RESOURCE_TEXT.unknown} — 관측 서버: {failure.message}{failure.status !== undefined && <> · HTTP {failure.status}</>}
    </p>
  );
}

/** 울리는 임계값 한 건 — 표식(읽지 않음) + 심각도 · 규칙 · 대상 · 언제부터 · 마지막 값. */
function FiringBadge({ firing, server }: { firing: FiringView; server?: string }) {
  const severityClass = firing.severity === "critical" ? styles.firingCritical : styles.firingWarning;
  return (
    <span className={`${styles.firing} ${severityClass}`}>
      <span aria-hidden="true" className={styles.firingMark}>{SEVERITY_MARKS[firing.severity] ?? "?"}</span>
      <strong>{firing.severityLabel}</strong>
      <span>{server !== undefined && <>{server} · </>}{firing.ruleLabel}{firing.target !== null && <> · {firing.target}</>}</span>
      <span className={styles.firingSince}>
        <KoreanTime value={firing.since} /> 부터
        {firing.lastValue !== null && PERCENT_RULES.has(firing.rule) && <> · 마지막 {formatPercent(firing.lastValue)}</>}
      </span>
    </span>
  );
}

function ElsewhereLine({ firing }: { firing: ElsewhereFiringView[] }) {
  if (firing.length === 0) return null;
  return (
    <div className={styles.elsewhere} role="status">
      <strong>목록 밖 서버의 알림 {firing.length}건</strong>
      <ul className={styles.firingList}>
        {firing.map((view, index) => <li key={`${index}-${view.server}-${view.rule}`}><FiringBadge firing={view} server={view.server} /></li>)}
      </ul>
    </div>
  );
}

/** 받은 때 — fresh 는 "N분 전"(받은 측정 시각과 함께), stale · never · unknown 은 모델의 글. */
function FreshnessLine({ freshness, measuredAt }: { freshness: ServerFreshness; measuredAt: string | null }) {
  const label = freshness.kind === "fresh" ? `받은 때 ${formatAge(freshness.ageMilliseconds)}` : freshness.label;
  const toneClass = freshness.kind === "fresh" ? styles.freshnessFresh : styles.freshnessStale;
  return (
    <span className={styles.freshnessLine}>
      <span className={`${styles.freshness} ${toneClass}`}>
        {freshness.kind !== "fresh" && <span aria-hidden="true" className={styles.firingMark}>{freshness.kind === "never" ? "✕" : "!"}</span>}
        {label}
      </span>
      {measuredAt !== null && <span className={styles.measuredAt}>측정 <KoreanTime value={measuredAt} /></span>}
      {freshness.firing !== null && <FiringBadge firing={freshness.firing} />}
    </span>
  );
}

function ReadingValue({ reading }: { reading: MetricReading }) {
  return (
    <>
      <span className={reading.state === "value" ? styles.value : styles.noValue}>{reading.text}</span>
      {reading.detail !== null && <span className={styles.detail}>{reading.detail}</span>}
      {reading.firing !== null && <FiringBadge firing={reading.firing} />}
    </>
  );
}

function Reading({ label, reading }: { label: string; reading: MetricReading }) {
  return (
    <div className={styles.reading}>
      <dt className={styles.readingLabel}>{label}</dt>
      <dd className={styles.readingValue}><ReadingValue reading={reading} /></dd>
    </div>
  );
}

const GPU_STATE_TEXT: Readonly<Record<Exclude<GpusView["state"], "listed">, string>> = {
  unread: RESOURCE_TEXT.gpuUnread, absent: RESOURCE_TEXT.gpuAbsent, unknown: RESOURCE_TEXT.unknown,
};

/** 지표 카드 하나 — 이름 → 수치 → (있으면) 그래프. 그 카드의 수치에 임계값이 울리면 카드 테두리도 바뀐다(글 + 표식은 수치 옆). */
function MetricCard({ server, title, firing, readings, children }: {
  server: string; title: string; firing: boolean; readings: ReactNode; children?: ReactNode;
}) {
  return (
    <div className={`${styles.card} ${firing ? styles.cardFiring : ""}`} role="group" aria-label={`${server} ${title}`}>
      <p className={styles.cardTitle}>{title}</p>
      <dl className={styles.cardReadings}>{readings}</dl>
      {children}
    </div>
  );
}

/** 그래프 자리 — 계열 조회가 실패했으면 그 글. 카드 안이라 그래프 제목은 화면에서 숨긴다(카드 이름과 같다). */
function GraphSlot({ result, pick, title, range }: { result: ServerResourceView["hostGraphs"]; pick: (graphs: HostGraphs) => GraphView; title: string; range: ResourceRange }) {
  return result.ok ? <ResourceGraph graph={pick(result.value)} range={range} titleHidden /> : <GraphFailure title={title} failure={result} />;
}

function GpuGraphSlots({ gpu, range }: { gpu: GpuGraphs; range: ResourceRange }) {
  if (!gpu.graphs.ok) return <GraphFailure title={`GPU ${gpu.index}`} failure={gpu.graphs} />;
  return (
    <>
      <ResourceGraph graph={gpu.graphs.value.utilization} range={range} />
      <ResourceGraph graph={gpu.graphs.value.memory} range={range} />
    </>
  );
}

interface ScreenLinks {
  query: ResourcesQuery;
  view: ResourcesViewState;
}

/** GPU 카드 — GPU 마다 하나(사용률 · 메모리 · 온도, 펼치면 그래프). GPU 가 없거나 값을 읽지 못했으면 그 글로 카드 하나. */
function GpuCards({ server, open, range }: { server: ServerResourceView; open: boolean; range: ResourceRange }) {
  const gpus = server.gpus;
  if (gpus.state !== "listed") {
    return <MetricCard server={server.server} title="GPU" firing={false} readings={(
      <div className={styles.reading}>
        <dt className={styles.readingLabel}>GPU</dt>
        <dd className={styles.readingValue}><span className={styles.noValue}>{GPU_STATE_TEXT[gpus.state]}</span></dd>
      </div>
    )} />;
  }
  return (
    <>
      {gpus.rows.map((gpu) => {
        const graphs = server.gpuGraphs.find((candidate) => candidate.index === gpu.index);
        return (
          <MetricCard key={gpu.index} server={server.server} title={`GPU ${gpu.index}`} firing={false} readings={(
            <>
              <Reading label="사용률" reading={gpu.utilization} />
              <Reading label="메모리" reading={gpu.memory} />
              <div className={styles.reading}>
                <dt className={styles.readingLabel}>온도</dt>
                <dd className={styles.readingValue}>
                  <span className={gpu.temperatureText === RESOURCE_TEXT.none ? styles.noValue : styles.value}>{gpu.temperatureText}</span>
                </dd>
              </div>
            </>
          )}>
            {open && (graphs !== undefined ? <GpuGraphSlots gpu={graphs} range={range} />
              : <p className={styles.noValue}>그래프를 그리지 않았습니다(서버마다 GPU 앞 4개만).</p>)}
          </MetricCard>
        );
      })}
    </>
  );
}

/** 지표 카드들 — CPU · 메모리 · 디스크는 늘 그래프까지. 네트워크 · 디스크 입출력 · GPU 는 수치가 늘 보이고, 펼쳐 둔 서버(주소의 open)만 카드 안에 그래프를 그린다
 * (안 펼친 서버는 그리지 않으므로 HTML 이 준다). 펼치기 · 접기 링크는 그 카드들 묶음의 머리에. */
function MetricCards({ server, links }: { server: ServerResourceView; links: ScreenLinks }) {
  const range = links.query.range;
  const open = links.view.openServers.includes(server.server);
  const toggleHref = resourcesScreenHref(links.query, withServerOpen(links.view, server.server, !open));
  const current = server.current;
  const graphs = server.hostGraphs;
  const staleClass = server.freshness.kind === "stale" ? styles.readingsStale : "";
  return (
    <>
      <div className={`${styles.cards} ${staleClass}`}>
        <MetricCard server={server.server} title="CPU" firing={current.cpu.firing !== null} readings={<Reading label="CPU" reading={current.cpu} />}>
          <GraphSlot result={graphs} pick={(value) => value.cpu} title="CPU" range={range} />
        </MetricCard>
        <MetricCard server={server.server} title="메모리" firing={current.memory.firing !== null} readings={<Reading label="메모리" reading={current.memory} />}>
          <GraphSlot result={graphs} pick={(value) => value.memory} title="메모리" range={range} />
        </MetricCard>
        <MetricCard server={server.server} title="디스크" firing={current.disk.firing !== null} readings={<Reading label="디스크" reading={current.disk} />}>
          <GraphSlot result={graphs} pick={(value) => value.disk} title="디스크" range={range} />
        </MetricCard>
      </div>
      <div className={styles.more} role="group" aria-label={`${server.server} 네트워크 · 디스크 입출력 · GPU`}>
        <p className={styles.moreHeading}>
          {open ? (
            <><span className={styles.moreTitle}>네트워크 · 디스크 입출력 · GPU 그래프</span><a className={styles.moreLink} href={toggleHref}>접기</a></>
          ) : <a className={styles.moreLink} href={toggleHref}>그래프 더 보기 — 네트워크 · 디스크 입출력 · GPU</a>}
        </p>
        <div className={`${styles.cards} ${staleClass}`}>
          <MetricCard server={server.server} title="네트워크" firing={false} readings={(
            <><Reading label="네트워크 받기" reading={current.networkReceive} /><Reading label="네트워크 보내기" reading={current.networkTransmit} /></>
          )}>
            {open && <GraphSlot result={graphs} pick={(value) => value.network} title="네트워크" range={range} />}
          </MetricCard>
          <MetricCard server={server.server} title="디스크 입출력" firing={false} readings={(
            <><Reading label="디스크 읽기" reading={current.diskRead} /><Reading label="디스크 쓰기" reading={current.diskWrite} /></>
          )}>
            {open && <GraphSlot result={graphs} pick={(value) => value.diskIo} title="디스크 입출력" range={range} />}
          </MetricCard>
          <GpuCards server={server} open={open} range={range} />
        </div>
      </div>
    </>
  );
}

const CONTAINER_STATE_TEXT: Readonly<Record<Exclude<ContainersView["state"], "listed">, string>> = {
  unread: RESOURCE_TEXT.unread, unknown: RESOURCE_TEXT.unknown,
};

/** 컨테이너 한 줄 — 이름(계열 이름 링크 + 실제 이름) · 상태 · CPU · 메모리 · 재시작 수(울리면 표식 + 글). */
function ContainerRow({ row, server, links }: { row: ContainerRowView; server: string; links: ScreenLinks }) {
  const href = resourcesScreenHref({ range: links.query.range, container: { server, container: row.seriesName } }, links.view);
  return (
    <tr className={row.firing !== null ? styles.rowFiring : undefined}>
      <td className={styles.containerName}>
        <a href={href} aria-current={row.selected ? "true" : undefined} className={row.selected ? styles.containerSelected : undefined}>{row.seriesName}</a>
        {row.selected && <span className={styles.selectedMark}> (보는 중)</span>}
        {row.name !== row.seriesName && <span className={styles.actualName}>{row.name}</span>}
      </td>
      <td className={row.stateText === RESOURCE_TEXT.none ? styles.noValue : undefined}>{row.stateText}</td>
      <td className={styles.number}><span className={row.cpu.state === "value" ? undefined : styles.noValue}>{row.cpu.text}</span></td>
      <td className={styles.number}><span className={row.memory.state === "value" ? undefined : styles.noValue}>{row.memory.text}</span></td>
      <td className={styles.number}>
        <span className={row.restarts === null ? styles.noValue : undefined}>{row.restartsText}</span>
        {row.firing !== null && <> <FiringBadge firing={row.firing} /></>}
      </td>
    </tr>
  );
}

function ContainerTable({ server, links }: { server: ServerResourceView; links: ScreenLinks }) {
  const containers = server.containers;
  return (
    <div className={styles.containers}>
      <p className={styles.containersTitle}>
        컨테이너{containers.state === "listed" && <> {containers.rows.length}개</>}
        {containers.truncated && <span className={styles.truncated}> · 일부만 표시</span>}
      </p>
      {containers.state !== "listed" ? <p className={styles.noValue}>{CONTAINER_STATE_TEXT[containers.state]}</p>
        : containers.rows.length === 0 ? <p className={styles.noValue}>컨테이너 없음</p> : (
          <div className={styles.scroller} tabIndex={0} role="region" aria-label={`${server.server} 컨테이너 표`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">상태</th>
                  <th scope="col">CPU(코어 하나 = 100%)</th>
                  <th scope="col">메모리</th>
                  <th scope="col">재시작 수</th>
                </tr>
              </thead>
              <tbody>
                {containers.rows.map((row) => <ContainerRow key={row.name} row={row} server={server.server} links={links} />)}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

/** 고른 컨테이너의 CPU · 메모리 그래프 — 닫기 링크(기간 · 끈 상태 · 펼친 그래프는 그대로). */
function SelectedContainer({ selected, links }: { selected: SelectedContainerView; links: ScreenLinks }) {
  const range = links.query.range;
  const closeHref = resourcesScreenHref({ range, container: null }, links.view);
  const headingId = `resource-container-${selected.server}-${selected.container}`;
  return (
    <section className={styles.selected} aria-labelledby={headingId}>
      <p className={styles.moreHeading}>
        <span id={headingId} className={styles.moreTitle}>컨테이너 {selected.container}({selected.server}) 그래프</span>
        <a className={styles.moreLink} href={closeHref}>닫기</a>
      </p>
      <div className={styles.graphsTwo}>
        {selected.graphs.ok ? (
          <>
            <ResourceGraph graph={selected.graphs.value.cpu} range={range} />
            <ResourceGraph graph={selected.graphs.value.memory} range={range} />
          </>
        ) : <GraphFailure title={`${selected.container} CPU · 메모리`} failure={selected.graphs} />}
      </div>
    </section>
  );
}

/** "그 밖의 알림" — 값 자리 · 컨테이너 줄에 붙지 않은 것(모르는 규칙, 표에 없는 컨테이너의 재시작 반복). */
function unplacedFiring(server: ServerResourceView): FiringView[] {
  const rowNames = new Set(server.containers.rows.map((row) => row.name));
  return server.firing.filter((view) => !PLACED_RULES.has(view.rule) && !(view.rule === "restarts" && view.target !== null && rowNames.has(view.target)));
}

/** 값이 없는 서버(명세 §17 끝 셋째 줄) — 한 번도 안 보냈거나(수신 없음) 고른 기간에 그래프 점이 하나도 없는 서버.
 * 화면 모델의 그래프 점 수로 판단한다: 서버 전체 계열이 성공했고 점이 0 이며, GPU 계열도 점이 없을 때만. 계열 조회가 실패했으면 알 수 없으므로 카드를 그대로 그린다. */
function isEmptyServer(server: ServerResourceView): boolean {
  if (server.freshness.kind !== "never" || !server.hostGraphs.ok) return false;
  const hostPoints = Object.values(server.hostGraphs.value).reduce((total, graph) => total + graph.pointCount, 0);
  const gpuPoints = server.gpuGraphs.reduce((total, gpu) => total + (gpu.graphs.ok ? gpu.graphs.value.utilization.pointCount + gpu.graphs.value.memory.pointCount : 1), 0);
  return hostPoints === 0 && gpuPoints === 0;
}

/** 값이 없는 서버의 한 줄 — 서버 이름 · 받은 때(수신 없음 + 지표 끊김 알림) · "이 기간에 값이 없습니다". 컨테이너가 있으면 그 수만. */
function EmptyServerLine({ server, links, selected }: { server: ServerResourceView; links: ScreenLinks; selected: SelectedContainerView | null }) {
  const headingId = `resource-server-${server.server}`;
  const others = unplacedFiring(server);
  const containerCount = server.containers.state === "listed" ? server.containers.rows.length : 0;
  return (
    <section className={`${styles.server} ${styles.serverEmpty}`} aria-labelledby={headingId}>
      <div className={styles.serverHeading}>
        <h2 id={headingId} className={styles.serverName}>{server.server}</h2>
        <FreshnessLine freshness={server.freshness} measuredAt={server.measuredAt} />
        <span className={styles.noValue}>이 기간에 값이 없습니다</span>
        {containerCount > 0 && <span className={styles.noValue}>컨테이너 {containerCount}개</span>}
      </div>
      {others.length > 0 && (
        <div className={styles.others}>
          <p className={styles.othersTitle}>그 밖의 알림 {others.length}건</p>
          <ul className={styles.firingList}>
            {others.map((view, index) => <li key={`${index}-${view.rule}-${view.target ?? ""}`}><FiringBadge firing={view} /></li>)}
          </ul>
        </div>
      )}
      {selected !== null && <SelectedContainer selected={selected} links={links} />}
    </section>
  );
}

function ServerSection({ server, links, selected }: { server: ServerResourceView; links: ScreenLinks; selected: SelectedContainerView | null }) {
  if (isEmptyServer(server)) return <EmptyServerLine server={server} links={links} selected={selected} />;
  const headingId = `resource-server-${server.server}`;
  const others = unplacedFiring(server);
  return (
    <section className={styles.server} aria-labelledby={headingId}>
      <div className={styles.serverHeading}>
        <h2 id={headingId} className={styles.serverName}>{server.server}</h2>
        <FreshnessLine freshness={server.freshness} measuredAt={server.measuredAt} />
      </div>
      {server.freshness.kind === "stale" && <p className={styles.staleNote}>아래 값은 {server.freshness.label}입니다 — 지금 값이 아닐 수 있습니다.</p>}
      <MetricCards server={server} links={links} />
      {others.length > 0 && (
        <div className={styles.others}>
          <p className={styles.othersTitle}>그 밖의 알림 {others.length}건</p>
          <ul className={styles.firingList}>
            {others.map((view, index) => <li key={`${index}-${view.rule}-${view.target ?? ""}`}><FiringBadge firing={view} /></li>)}
          </ul>
        </div>
      )}
      <ContainerTable server={server} links={links} />
      {selected !== null && <SelectedContainer selected={selected} links={links} />}
    </section>
  );
}

/** 기간 링크 · 자동 갱신 켜기/끄기 — 지금 고른 것은 글(aria-current · "고름")로도 보인다. 링크는 다른 값(기간 · 끈 상태 · 펼친 그래프 · 고른 컨테이너)을 보존한다. */
function Controls({ links }: { links: ScreenLinks }) {
  const { query, view } = links;
  const seconds = RESOURCE_AUTO_REFRESH_SECONDS[query.range];
  const interval = seconds < 60 ? `${seconds}초` : `${seconds / 60}분`;
  return (
    <div className={styles.controls}>
      <nav aria-label="기간">
        <ul className={styles.ranges}>
          {RESOURCE_RANGES.map((range) => (
            <li key={range}>
              {range === query.range
                ? <a className={`${styles.range} ${styles.rangeSelected}`} href={resourcesScreenHref({ ...query, range }, view)} aria-current="page">{RESOURCE_RANGE_LABELS[range]}<span className={styles.visuallyHidden}> (고름)</span></a>
                : <a className={styles.range} href={resourcesScreenHref({ ...query, range }, view)}>{RESOURCE_RANGE_LABELS[range]}</a>}
            </li>
          ))}
        </ul>
      </nav>
      <p className={styles.meta}>
        {view.autoRefresh
          ? <>{interval}마다 자동 갱신 중 · <a className={styles.refresh} href={resourcesScreenHref(query, { ...view, autoRefresh: false })}>끄기</a></>
          : <>자동 갱신 꺼짐 · <a className={styles.refresh} href={resourcesScreenHref(query, { ...view, autoRefresh: true })}>켜기</a></>}
        {" "}· <a className={styles.refresh} href={resourcesScreenHref(query, view)}>지금 새로 고침</a>
      </p>
    </div>
  );
}

export interface ResourcesScreenProps {
  screen: ResourcesScreen;
  /** 화면 상태(주소의 refresh · open) — parseResourcesViewState 의 결과 */
  view: ResourcesViewState;
}

export function ResourcesScreen({ screen, view }: ResourcesScreenProps) {
  const query: ResourcesQuery = {
    range: screen.window.range,
    container: screen.selectedContainer === null ? null : { server: screen.selectedContainer.server, container: screen.selectedContainer.container },
  };
  const links: ScreenLinks = { query, view };
  return (
    <main className={styles.main}>
      {/* React 19 가 <head> 로 올린다(next build 뒤의 HTML 로 확인 — 보고 참고). content 에 주소가 없으므로 지금 주소를 다시 불러온다. */}
      {view.autoRefresh && <meta httpEquiv="refresh" content={String(RESOURCE_AUTO_REFRESH_SECONDS[query.range])} />}
      <div className={parts.heading}>
        <h1 className={parts.title}>서버 자원</h1>
        <p className={styles.meta}>조회 시각(KST) <KoreanTime value={screen.window.to} /> · 기간 {screen.window.label}</p>
      </div>
      <Controls links={links} />
      <ElsewhereLine firing={screen.firingElsewhere} />
      {screen.servers.ok && !screen.firingKnown && <p className={styles.failure}>울리는 임계값: {RESOURCE_TEXT.unknown}</p>}
      {!screen.servers.ok ? <FailureLine label="서버 값" failure={screen.servers} /> : screen.servers.value.length === 0
        ? <p className={parts.empty}>지표를 보낸 서버가 없습니다.</p>
        : (
          <div className={styles.servers}>
            {screen.servers.value.map((server) => (
              <ServerSection key={server.server} server={server} links={links}
                selected={screen.selectedContainer !== null && screen.selectedContainer.server === server.server ? screen.selectedContainer : null} />
            ))}
          </div>
        )}
      {/* 고른 컨테이너의 서버가 화면에 없으면(서버 목록 실패 · 목록 밖 서버) 묶음 밖에 따로 */}
      {screen.selectedContainer !== null && !(screen.servers.ok && screen.servers.value.some((server) => server.server === screen.selectedContainer?.server))
        && <SelectedContainer selected={screen.selectedContainer} links={links} />}
      {screen.hiddenServerCount > 0 && <p className={styles.meta}>서버 {screen.hiddenServerCount}대는 이 화면에 보이지 않습니다(앞 10대만).</p>}
    </main>
  );
}
