/** 서버 자원 화면의 본문(서버 컴포넌트) — 서버마다 한 묶음(이름 · 받은 때 → 현재 값 → 지금 울리는 임계값 → 그래프). 컨테이너 표는 다음 단계.
 * 2단계(명세 §17): CPU · 메모리 · 디스크 그래프는 늘 보이고 네트워크 · 디스크 입출력 · GPU 는 `<details>` 에 접어 둔다. 기간 고르기 링크.
 * 자동 갱신은 스크립트 없이 `<meta http-equiv="refresh">` — 같은 주소를 다시 불러오므로 기간 · 끈 상태 · 펼친 그래프(주소의 값)가 그대로 남는다.
 * 받은 화면 모델(진입 함수가 모은 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다. 클라이언트 스크립트 없음.
 * 값이 없으면 모델의 글("없음" · "읽지 못함" · "확인하지 못함") 그대로 — 0 으로 보이지 않게. 한 구역이 실패해도 나머지는 그린다(실패는 고정 글자와 HTTP 상태만).
 * 울리는 임계값은 그 값 자리에 표식 + 글(심각도 · 규칙 · 언제부터) — 색만으로 전하지 않는다. 자리가 아직 없는 규칙(재시작 반복 · 모르는 규칙)은 묶음 끝의 목록에. */
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import { formatAge, formatPercent } from "@/features/resources/lib/resource-format";
import {
  RESOURCE_TEXT, type ElsewhereFiringView, type FiringView, type GpuGraphs, type GpusView, type GraphView, type HostGraphs, type MetricReading,
  type ResourcesScreen, type ServerFreshness, type ServerResourceView,
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

/** 그래프 — CPU · 메모리 · 디스크는 늘, 나머지는 접어 둔다. 펼친 채로 두려면 주소에 싣는 링크(스크립트가 없어 펼침 자체는 주소에 남지 않는다). */
function ServerGraphs({ server, links }: { server: ServerResourceView; links: ScreenLinks }) {
  const range = links.query.range;
  const open = links.view.openServers.includes(server.server);
  const keepHref = resourcesScreenHref(links.query, withServerOpen(links.view, server.server, !open));
  return (
    <>
      <div className={styles.graphs}>
        <GraphSlot result={server.hostGraphs} pick={(graphs) => graphs.cpu} title="CPU" range={range} />
        <GraphSlot result={server.hostGraphs} pick={(graphs) => graphs.memory} title="메모리" range={range} />
        <GraphSlot result={server.hostGraphs} pick={(graphs) => graphs.disk} title="디스크" range={range} />
      </div>
      <details className={styles.more} open={open}>
        <summary className={styles.moreSummary}>그래프 더 보기 — 네트워크 · 디스크 입출력 · GPU</summary>
        <p className={styles.keep}>
          {open ? <>새로 고쳐도 펼쳐 둡니다 · <a href={keepHref}>펼쳐 두지 않기</a></> : <a href={keepHref}>새로 고쳐도 펼쳐 두기</a>}
        </p>
        <div className={styles.graphs}>
          <GraphSlot result={server.hostGraphs} pick={(graphs) => graphs.network} title="네트워크" range={range} />
          <GraphSlot result={server.hostGraphs} pick={(graphs) => graphs.diskIo} title="디스크 입출력" range={range} />
          {server.gpus.state === "listed"
            ? server.gpuGraphs.map((gpu) => <GpuGraphSlots key={gpu.index} gpu={gpu} range={range} />)
            : <p className={styles.noValue}>GPU 그래프 — {GPU_STATE_TEXT[server.gpus.state]}</p>}
        </div>
        {server.omittedGpuGraphCount > 0 && <p className={styles.noValue}>GPU {server.omittedGpuGraphCount}개는 그래프를 그리지 않았습니다(앞 4개만).</p>}
      </details>
    </>
  );
}

function ServerSection({ server, links }: { server: ServerResourceView; links: ScreenLinks }) {
  const headingId = `resource-server-${server.server}`;
  const current = server.current;
  const others = server.firing.filter((view) => !PLACED_RULES.has(view.rule));
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
            {screen.servers.value.map((server) => <ServerSection key={server.server} server={server} links={links} />)}
          </div>
        )}
      {screen.hiddenServerCount > 0 && <p className={styles.meta}>서버 {screen.hiddenServerCount}대는 이 화면에 보이지 않습니다(앞 10대만).</p>}
    </main>
  );
}
