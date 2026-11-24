/** 서버 자원 화면의 본문(서버 컴포넌트) — 서버마다 한 묶음(이름 · 받은 때 → 현재 값 → 지금 울리는 임계값 → 그래프 → 컨테이너 표 → 고른 컨테이너의 그래프).
 * 2단계(명세 §17): CPU · 메모리 · 디스크 그래프는 늘 보이고, 네트워크 · 디스크 입출력 · GPU 는 펼쳐 둔 서버(주소의 open)만 그린다 —
 * 안 펼친 서버는 "그래프 더 보기" 링크(누르면 그 서버가 open 에 더해진 주소). 펼침이 곧 주소라 자동 갱신 뒤에도 남고, 안 그린 그래프만큼 HTML 이 준다. 기간 고르기 링크.
 * 3단계: 컨테이너 표(재시작 반복 알림은 그 줄에), 이름을 누르면 그 컨테이너의 CPU · 메모리 그래프가 표 아래에 열린다(닫기 링크).
 * 자동 갱신은 스크립트 없이 `<meta http-equiv="refresh">` — 같은 주소를 다시 불러오므로 기간 · 끈 상태 · 펼친 그래프(주소의 값)가 그대로 남는다.
 * 받은 화면 모델(진입 함수가 모은 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다. 클라이언트 스크립트 없음.
 * 값이 없으면 모델의 글("없음" · "읽지 못함" · "확인하지 못함") 그대로 — 0 으로 보이지 않게. 한 구역이 실패해도 나머지는 그린다(실패는 고정 글자와 HTTP 상태만).
 * 울리는 임계값은 그 값 자리에 표식 + 글(심각도 · 규칙 · 언제부터) — 색만으로 전하지 않는다. 자리가 아직 없는 규칙(재시작 반복 · 모르는 규칙)은 묶음 끝의 목록에. */
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
    <div className={`${styles.reading} ${reading.firing !== null ? styles.readingFiring : ""}`}>
      <dt className={styles.readingLabel}>{label}</dt>
      <dd className={styles.readingValue}><ReadingValue reading={reading} /></dd>
    </div>
  );
}

const GPU_STATE_TEXT: Readonly<Record<Exclude<GpusView["state"], "listed">, string>> = {
  unread: RESOURCE_TEXT.gpuUnread, absent: RESOURCE_TEXT.gpuAbsent, unknown: RESOURCE_TEXT.unknown,
};

function GpuReading({ gpus }: { gpus: GpusView }) {
  return (
    <div className={`${styles.reading} ${styles.readingWide}`}>
      <dt className={styles.readingLabel}>GPU</dt>
      <dd className={styles.readingValue}>
        {gpus.state !== "listed" ? <span className={styles.noValue}>{GPU_STATE_TEXT[gpus.state]}</span> : (
          <ul className={styles.gpuList}>
            {gpus.rows.map((gpu) => (
              <li key={gpu.index}>
                <span className={styles.gpuName}>GPU {gpu.index}</span>
                사용률 <ReadingValue reading={gpu.utilization} /> · 메모리 <ReadingValue reading={gpu.memory} /> · 온도{" "}
                <span className={gpu.temperatureText === RESOURCE_TEXT.none ? styles.noValue : styles.value}>{gpu.temperatureText}</span>
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}

/** 그래프 자리 — 계열 조회가 실패했으면 그 글. */
function GraphSlot({ result, pick, title, range }: { result: ServerResourceView["hostGraphs"]; pick: (graphs: HostGraphs) => GraphView; title: string; range: ResourceRange }) {
  return result.ok ? <ResourceGraph graph={pick(result.value)} range={range} /> : <GraphFailure title={title} failure={result} />;
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

/** 그래프 — CPU · 메모리 · 디스크는 늘. 나머지는 펼쳐 둔 서버만 그리고, 안 펼친 서버에는 펼치는 링크만(그리지 않으므로 HTML 이 준다). */
function ServerGraphs({ server, links }: { server: ServerResourceView; links: ScreenLinks }) {
  const range = links.query.range;
  const open = links.view.openServers.includes(server.server);
  const toggleHref = resourcesScreenHref(links.query, withServerOpen(links.view, server.server, !open));
  return (
    <>
      <div className={styles.graphs}>
        <GraphSlot result={server.hostGraphs} pick={(graphs) => graphs.cpu} title="CPU" range={range} />
        <GraphSlot result={server.hostGraphs} pick={(graphs) => graphs.memory} title="메모리" range={range} />
        <GraphSlot result={server.hostGraphs} pick={(graphs) => graphs.disk} title="디스크" range={range} />
      </div>
      {!open ? (
        <p className={styles.more}><a className={styles.moreLink} href={toggleHref}>그래프 더 보기 — 네트워크 · 디스크 입출력 · GPU</a></p>
      ) : (
        <div className={styles.more} role="group" aria-label={`${server.server} 그래프 더 보기`}>
          <p className={styles.moreHeading}>
            <span className={styles.moreTitle}>그래프 더 보기 — 네트워크 · 디스크 입출력 · GPU</span>
            <a className={styles.moreLink} href={toggleHref}>접기</a>
          </p>
          <div className={styles.graphs}>
            <GraphSlot result={server.hostGraphs} pick={(graphs) => graphs.network} title="네트워크" range={range} />
            <GraphSlot result={server.hostGraphs} pick={(graphs) => graphs.diskIo} title="디스크 입출력" range={range} />
            {server.gpus.state === "listed"
              ? server.gpuGraphs.map((gpu) => <GpuGraphSlots key={gpu.index} gpu={gpu} range={range} />)
              : <p className={styles.noValue}>GPU 그래프 — {GPU_STATE_TEXT[server.gpus.state]}</p>}
          </div>
          {server.omittedGpuGraphCount > 0 && <p className={styles.noValue}>GPU {server.omittedGpuGraphCount}개는 그래프를 그리지 않았습니다(앞 4개만).</p>}
        </div>
      )}
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

function ServerSection({ server, links, selected }: { server: ServerResourceView; links: ScreenLinks; selected: SelectedContainerView | null }) {
  const headingId = `resource-server-${server.server}`;
  const current = server.current;
  const others = unplacedFiring(server);
  return (
    <section className={styles.server} aria-labelledby={headingId}>
      <div className={styles.serverHeading}>
        <h2 id={headingId} className={styles.serverName}>{server.server}</h2>
        <FreshnessLine freshness={server.freshness} measuredAt={server.measuredAt} />
      </div>
      {server.freshness.kind === "stale" && <p className={styles.staleNote}>아래 값은 {server.freshness.label}입니다 — 지금 값이 아닐 수 있습니다.</p>}
      <dl className={`${styles.readings} ${server.freshness.kind === "stale" ? styles.readingsStale : ""}`}>
        <Reading label="CPU" reading={current.cpu} />
        <Reading label="메모리" reading={current.memory} />
        <Reading label="디스크" reading={current.disk} />
        <Reading label="네트워크 받기" reading={current.networkReceive} />
        <Reading label="네트워크 보내기" reading={current.networkTransmit} />
        <Reading label="디스크 읽기" reading={current.diskRead} />
        <Reading label="디스크 쓰기" reading={current.diskWrite} />
        <GpuReading gpus={server.gpus} />
      </dl>
      {others.length > 0 && (
        <div className={styles.others}>
          <p className={styles.othersTitle}>그 밖의 알림 {others.length}건</p>
          <ul className={styles.firingList}>
            {others.map((view, index) => <li key={`${index}-${view.rule}-${view.target ?? ""}`}><FiringBadge firing={view} /></li>)}
          </ul>
        </div>
      )}
      <ServerGraphs server={server} links={links} />
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
