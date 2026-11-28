/** 통신 지도의 본문(상태 → 그림 · 표 · 알림) — 서버에서도 브라우저에서도 그린다(훅 없음). 브라우저 조각(TrafficMapLive)이 닿는 파일이라
 * 서버 모듈 · 클라이언트 · 설정 · fetch 를 값으로 가져오지 않는다. 시각은 KST(formatKoreanLogTime).
 * 모름과 0 을 가른다: 선의 요청 수 · 채움은 formatEdgeCount · completeness 로("아직 모름"은 0건이라 하지 않는다) · 수집이 밀린 서버 · 채우는 중인 선 ·
 * 읽지 못한 구간이 있는 서버는 글로(role=note) · 잃은 순번(그 서버의 누적 — 이 기간의 것인지 모른다)은 따로 한 줄 · 끊기면 "끊김 — 다시 붙는 중",
 * 다시 붙은 직후(새 지도 전)는 "다시 붙음 — 새 값을 기다리는 중", 둘 다 "아래 값은 <시각> 의 것입니다" · 깨진 사건의 수.
 * 그림(svg)은 꾸밈(aria-hidden) — 같은 값을 표 둘("통신 선" · "수집 상태")로 읽는다. 마디는 서비스 이름(관측 서버의 선에 서버 칸이 없다).
 * 의존의 선(⑬ T9d): 통신의 원과 따로 "의존 연결" 절 안에 두 줄짜리 그림(윗줄 서비스 셋 — 그 기간의 통신과 무관하게 늘 · 아랫줄 의존 다섯 ·
 * 서비스 → 의존의 가는 짧은 점선 2 3 — 통신의 "덜 채워짐" 6 4 와 다르다)과 표 "의존 연결"(서비스 · 의존 · 상태 · 걸린 시간 · 까닭 · 확인한 때).
 * 지금의 상태다 — 고른 기간과 무관. 서비스가 준 detail 은 그리지 않는다(흐름에 없다). */
import { formatKoreanLogTime } from "@/features/logs/ui/LogTable";
import logStyles from "@/features/logs/ui/LogSearchScreen.module.css";
import { TRAFFIC_MAP_RANGE_LABELS, type TrafficMapRange } from "@/features/traffic-map/lib/traffic-map-query";
import {
  DEPENDENCY_NAMES, type DependencyLine, type DependencyServiceName, type DependencyState, type DependencyUnknownReason,
} from "@/features/traffic-map/lib/dependency-lines";
import { isDependencyStale, type TrafficDependencyStreamState } from "@/features/traffic-map/lib/traffic-dependency-stream";
import type { TrafficMapStreamState } from "@/features/traffic-map/lib/traffic-map-stream-state";
import {
  formatEdgeCount, formatErrorRate, formatMilliseconds, formatQuantile, type EdgeCompleteness, type TrafficMapEdgeView, type TrafficMapView,
} from "@/features/traffic-map/lib/traffic-map-view";
import styles from "@/features/traffic-map/ui/TrafficMap.module.css";
import parts from "@/shared/ui/screen-parts.module.css";
import type { UpstreamFailure } from "@/shared/lib/upstream-result";

export interface TrafficMapBodyProps {
  range: TrafficMapRange;
  state: TrafficMapStreamState;
  /** 의존의 선(⑬ T9d) — 없거나 값이 없으면 "의존 연결은 아직 확인하지 않았습니다". */
  dependencies?: TrafficDependencyStreamState;
  /** 낡음을 가르는 지금(밀리초) — 없으면 시각으로는 낡음을 가르지 않는다(연결 상태로만) */
  now?: number;
}

const CLASS_LABELS: Readonly<Record<TrafficMapEdgeView["trafficClass"], string>> = { request: "요청", health: "헬스", stream: "스트림" };
const COMPLETENESS_LABELS: Readonly<Record<EdgeCompleteness, string>> = { settled: "채워짐", filling: "덜 들어왔을 수 있음", unknown: "아직 모름" };

function failureText(failure: UpstreamFailure): string {
  return `${failure.message}${failure.status !== undefined ? ` · HTTP ${failure.status}` : ""}`;
}

function ConnectionStatus({ state }: { state: TrafficMapStreamState }) {
  const at = state.lastReceivedAt === null ? null : formatKoreanLogTime(state.lastReceivedAt);
  switch (state.connection) {
    case "connecting":
      return <p className={styles.status} role="status">{at === null ? "연결 중" : `연결 중 · 마지막 갱신 ${at}`}</p>;
    case "open":
      return <p className={`${styles.status} ${styles.statusLive}`} role="status">{at === null ? "실시간" : `실시간 · 마지막 갱신 ${at}`}</p>;
    case "reconnecting":
      return <p className={`${styles.status} ${styles.statusBroken}`} role="status">{at === null ? "끊김 — 다시 붙는 중" : `끊김 — 다시 붙는 중 · 마지막으로 받은 시각 ${at}`}</p>;
    case "reopened":
      return <p className={styles.status} role="status">{at === null ? "다시 붙음 — 새 값을 기다리는 중" : `다시 붙음 — 새 값을 기다리는 중 · 마지막으로 받은 시각 ${at}`}</p>;
    case "session_ended":
      return <p className={`${styles.status} ${styles.statusBroken}`} role="status">세션이 끝났습니다 — 다시 로그인하세요 <a href="/login">로그인</a></p>;
  }
}

/** 이름 — 규약의 목록 밖이면 곁에 "(목록 밖)"(글로). */
function TrafficName({ name, known }: { name: string; known: boolean }) {
  return <>{name}{!known && <span className={styles.outsideName}> (목록 밖)</span>}</>;
}

const FIGURE_SIZE = 480;
const FIGURE_RADIUS = 180;
const NODE_RADIUS = 34;

/** 마디를 원 위에 고르게 놓고, 선은 부른 쪽 → 받는 쪽의 굽은 선(같은 두 마디의 갈래는 굽은 정도로 가른다). 덜 채워진 선은 점선. */
function TrafficFigure({ view }: { view: TrafficMapView }) {
  const center = FIGURE_SIZE / 2;
  const positions = new Map(view.nodes.map((name, index) => {
    const angle = (2 * Math.PI * index) / view.nodes.length - Math.PI / 2;
    return [name, { x: center + FIGURE_RADIUS * Math.cos(angle), y: center + FIGURE_RADIUS * Math.sin(angle) }] as const;
  }));
  const pairCounts = new Map<string, number>();
  return (
    <svg className={styles.figure} viewBox={`0 0 ${FIGURE_SIZE} ${FIGURE_SIZE}`} aria-hidden="true" focusable="false">
      <defs>
        <marker id="traffic-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path className={styles.arrow} d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {view.edges.map((edge) => {
        const from = positions.get(edge.caller)!;
        const to = positions.get(edge.service)!;
        const pair = `${edge.caller}→${edge.service}`;
        const order = pairCounts.get(pair) ?? 0;
        pairCounts.set(pair, order + 1);
        const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        const bend = 24 + order * 18;
        const control = { x: (from.x + to.x) / 2 - ((to.y - from.y) / length) * bend, y: (from.y + to.y) / 2 + ((to.x - from.x) / length) * bend };
        // 끝을 마디의 테두리까지 당긴다
        const toward = (point: { x: number; y: number }, target: { x: number; y: number }) => {
          const distance = Math.hypot(target.x - point.x, target.y - point.y) || 1;
          return { x: point.x + ((target.x - point.x) / distance) * NODE_RADIUS, y: point.y + ((target.y - point.y) / distance) * NODE_RADIUS };
        };
        const start = toward(from, control);
        const end = toward(to, control);
        const incomplete = edge.completeness !== "settled";
        return (
          <path key={`${pair}:${edge.trafficClass}`} data-edge={`${pair}:${edge.trafficClass}`}
            className={`${styles.edge} ${incomplete ? styles.edgeIncomplete : ""}`} {...(incomplete ? { strokeDasharray: "6 4" } : {})}
            d={`M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`}
            markerEnd="url(#traffic-arrow)" />
        );
      })}
      {view.nodes.map((name) => {
        const { x, y } = positions.get(name)!;
        return (
          <g key={name}>
            <circle className={`${styles.node} ${view.edges.some((edge) => (edge.caller === name && !edge.callerKnown) || (edge.service === name && !edge.serviceKnown)) ? styles.nodeOutside : ""}`}
              cx={x.toFixed(1)} cy={y.toFixed(1)} r={NODE_RADIUS} />
            <text className={styles.nodeName} x={x.toFixed(1)} y={y.toFixed(1)}>{name}</text>
          </g>
        );
      })}
    </svg>
  );
}

function EdgeTable({ view }: { view: TrafficMapView }) {
  return (
    <div className={logStyles.scroller} tabIndex={0} role="region" aria-label="통신 선 표">
      <table className={`${logStyles.table} ${styles.table}`} aria-label="통신 선">
        <thead>
          <tr>
            <th scope="col">부른 쪽</th>
            <th scope="col">받는 쪽</th>
            <th scope="col">갈래</th>
            <th scope="col">요청</th>
            <th scope="col">오류 비율</th>
            <th scope="col">중앙값</th>
            <th scope="col">95%</th>
            <th scope="col">가장 긴</th>
            <th scope="col">채움</th>
          </tr>
        </thead>
        <tbody>
          {view.edges.map((edge) => (
            <tr key={`${edge.caller}→${edge.service}:${edge.trafficClass}`}>
              <th scope="row"><TrafficName name={edge.caller} known={edge.callerKnown} /></th>
              <td><TrafficName name={edge.service} known={edge.serviceKnown} /></td>
              <td>{CLASS_LABELS[edge.trafficClass]}</td>
              <td>{formatEdgeCount(edge)}</td>
              <td>{formatErrorRate(edge.errorRate)}</td>
              <td>{formatQuantile(edge.p50)}</td>
              <td>{formatQuantile(edge.p95)}</td>
              <td>{formatMilliseconds(edge.maxMilliseconds)}</td>
              <td>{COMPLETENESS_LABELS[edge.completeness]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 읽지 못한 구간 — 없으면 "없음", 셋까지 쉼표로, 넷부터는 앞의 셋 + " 외 n개"(주소 꼴은 view 가 이미 가렸다). */
const MISSING_SHOWN = 3;
function missingText(missing: readonly string[]): string {
  if (missing.length === 0) return "없음";
  const shown = missing.slice(0, MISSING_SHOWN).join(", ");
  return missing.length > MISSING_SHOWN ? `${shown} 외 ${missing.length - MISSING_SHOWN}개` : shown;
}

function ServerTable({ view }: { view: TrafficMapView }) {
  return (
    <div className={logStyles.scroller} tabIndex={0} role="region" aria-label="수집 상태 표">
      <table className={`${logStyles.table} ${styles.table}`} aria-label="수집 상태">
        <thead>
          <tr>
            <th scope="col">서버</th>
            <th scope="col">읽기 진도</th>
            <th scope="col">수신</th>
            <th scope="col">잃은 순번</th>
            <th scope="col">읽지 못한 구간</th>
            <th scope="col">버린 요청별 줄</th>
          </tr>
        </thead>
        <tbody>
          {view.servers.map((server) => (
            <tr key={server.server}>
              <th scope="row">{server.server}</th>
              <td>{server.readProgressAt === null ? "아직 없음" : formatKoreanLogTime(server.readProgressAt)}</td>
              <td>{server.receiveDelayed ? "수신 지연" : server.readProgressAt === null ? "진도 없음" : "정상"}</td>
              <td>{`${server.sequenceGaps}개`}</td>
              <td>{missingText(server.missing)}</td>
              <td>{`${server.requestsDropped + server.requestsRejected}줄`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const DEPENDENCY_LINE_CLASSES: Readonly<Record<DependencyState, string>> = {
  up: styles.dependencyLineUp, down: styles.dependencyLineDown, unknown: styles.dependencyLineUnknown,
};

/** 의존의 그림의 크기(viewBox 의 단위) — 아랫줄 다섯 칸 · 윗줄 서비스 셋. 가장 긴 이름(elasticsearch 13자 · llm-wrapper 11자)이 글자 15 로 상자에 든다. */
const DEPENDENCY_FIGURE_WIDTH = 580;
const DEPENDENCY_FIGURE_HEIGHT = 170;
const DEPENDENCY_BOX_WIDTH = 108;
const SERVICE_BOX_WIDTH = 116;
const DEPENDENCY_BOX_HEIGHT = 30;
const SERVICE_ROW_TOP = 10;
const DEPENDENCY_ROW_TOP = 130;
/** 윗줄의 차례와 가운데(x) — backend · observe · llm-wrapper(선의 엇갈림이 가장 적다: backend→postgres 와 observe→redis 의 한 번은 피할 수 없다). */
const SERVICE_CENTERS: readonly (readonly [DependencyServiceName, number])[] = [["backend", 150], ["observe", 330], ["llm-wrapper", 490]];
/** 아랫줄 — 의존 다섯(닫힌 표의 차례)이 같은 너비의 칸 하나씩. */
const DEPENDENCY_SLOT_WIDTH = DEPENDENCY_FIGURE_WIDTH / DEPENDENCY_NAMES.length;

/** 의존의 그림(꾸밈 — 같은 값은 표에 있다): 윗줄 서비스 셋은 늘 그린다(그 기간의 통신과 무관) · 아랫줄 의존 다섯 · 선은 서비스 상자의 아래 가운데 → 의존 상자의 위 가운데. */
function DependencyFigure({ lines }: { lines: readonly DependencyLine[] }) {
  const serviceCenter = new Map(SERVICE_CENTERS);
  const dependencyCenter = new Map(DEPENDENCY_NAMES.map((name, index) => [name, DEPENDENCY_SLOT_WIDTH * (index + 0.5)] as const));
  const box = (center: number, top: number, width: number) => ({ x: center - width / 2, y: top, width, height: DEPENDENCY_BOX_HEIGHT });
  return (
    <svg className={styles.dependencyFigure} data-dependency-figure="" viewBox={`0 0 ${DEPENDENCY_FIGURE_WIDTH} ${DEPENDENCY_FIGURE_HEIGHT}`}
      aria-hidden="true" focusable="false">
      {lines.map((line) => {
        const key = `${line.service}→${line.dependency}`;
        return (
          <line key={key} data-dependency-line={key} data-dependency-state={line.state}
            className={`${styles.dependencyLine} ${DEPENDENCY_LINE_CLASSES[line.state]}`} strokeDasharray="2 3"
            x1={serviceCenter.get(line.service)} y1={SERVICE_ROW_TOP + DEPENDENCY_BOX_HEIGHT}
            x2={dependencyCenter.get(line.dependency)} y2={DEPENDENCY_ROW_TOP} />
        );
      })}
      {SERVICE_CENTERS.map(([service, center]) => (
        <g key={service} data-dependency-service={service}>
          <rect className={styles.dependencyService} {...box(center, SERVICE_ROW_TOP, SERVICE_BOX_WIDTH)} rx={6} />
          <text className={styles.dependencyName} x={center} y={SERVICE_ROW_TOP + DEPENDENCY_BOX_HEIGHT / 2}>{service}</text>
        </g>
      ))}
      {DEPENDENCY_NAMES.map((name) => {
        const center = dependencyCenter.get(name)!;
        return (
          <g key={name} data-dependency-node={name}>
            <rect className={styles.dependencyNode} {...box(center, DEPENDENCY_ROW_TOP, DEPENDENCY_BOX_WIDTH)} rx={6} />
            <text className={styles.dependencyName} x={center} y={DEPENDENCY_ROW_TOP + DEPENDENCY_BOX_HEIGHT / 2}>{name}</text>
          </g>
        );
      })}
    </svg>
  );
}

const DEPENDENCY_STATE_LABELS: Readonly<Record<DependencyState, string>> = { up: "연결됨", down: "끊김", unknown: "모름" };
const DEPENDENCY_REASON_LABELS: Readonly<Record<DependencyUnknownReason, string>> = {
  not_configured: "설정 없음", unreachable: "닿지 않음", timeout: "닿지 않음(4초 초과)", unparseable: "읽을 수 없는 답(옛 판일 수 있음)", not_reported: "알리지 않음",
};

function DependencyTable({ lines, checkedAt }: { lines: readonly DependencyLine[]; checkedAt: string }) {
  const at = formatKoreanLogTime(checkedAt);
  return (
    <div className={logStyles.scroller} tabIndex={0} role="region" aria-label="의존 연결 표">
      <table className={`${logStyles.table} ${styles.table}`} aria-label="의존 연결">
        <thead>
          <tr>
            <th scope="col">서비스</th>
            <th scope="col">의존</th>
            <th scope="col">상태</th>
            <th scope="col">걸린 시간</th>
            <th scope="col">까닭</th>
            <th scope="col">확인한 때</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={`${line.service}→${line.dependency}`}>
              <th scope="row">{line.service}</th>
              <td>{line.dependency}</td>
              <td>{DEPENDENCY_STATE_LABELS[line.state]}</td>
              <td>{formatMilliseconds(line.tookMs)}</td>
              <td>{line.reason === null ? "—" : DEPENDENCY_REASON_LABELS[line.reason]}</td>
              <td>{at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 의존 연결 — 지금의 상태(고른 기간과 무관). 값이 없으면 "아직 확인하지 않았습니다" · 낡으면 확인한 시각과 함께. */
function DependencySection({ dependencies, connection, now }: {
  dependencies: TrafficDependencyStreamState | undefined; connection: TrafficMapStreamState["connection"]; now: number | undefined;
}) {
  const shown = dependencies?.shown ?? null;
  return (
    <>
      <h2 className={styles.sectionTitle}>의존 연결</h2>
      {shown === null ? <p className={parts.empty}>의존 연결은 아직 확인하지 않았습니다</p> : (
        <>
          <DependencyFigure lines={shown.lines} />
          <p className={styles.meta}>의존 연결은 지금의 상태입니다 — 고른 기간과 무관합니다</p>
          {isDependencyStale(dependencies!, connection, now ?? Date.parse(shown.checkedAt)) && (
            <p className={styles.note} role="note">{`의존 연결은 ${formatKoreanLogTime(shown.checkedAt)} 에 확인한 값입니다 — 지금 값이 아닐 수 있습니다`}</p>
          )}
          <DependencyTable lines={shown.lines} checkedAt={shown.checkedAt} />
        </>
      )}
      {dependencies !== undefined && dependencies.brokenEvents > 0 && <p className={styles.note} role="note">{`깨진 의존 갱신 ${dependencies.brokenEvents}건을 버렸습니다`}</p>}
    </>
  );
}

function MapContent({ view }: { view: TrafficMapView }) {
  const missingServers = view.servers.filter((server) => server.missing.length > 0).map((server) => server.server);
  return (
    <>
      <p className={styles.meta}>{`조회 기간(KST) ${formatKoreanLogTime(view.from)} ~ ${formatKoreanLogTime(view.to)}`}</p>
      {view.delayedServers.length > 0 && (
        <p className={styles.note} role="note">{`수집이 밀린 서버: ${view.delayedServers.join(", ")} — 그 서버가 받은 요청은 지도에 덜 들어왔을 수 있습니다`}</p>
      )}
      {missingServers.length > 0 && (
        <p className={styles.note} role="note">{`읽지 못한 구간이 있는 서버: ${missingServers.join(", ")} — 그 구간의 요청은 지도에 덜 들어왔을 수 있습니다`}</p>
      )}
      {view.hasFilling && <p className={styles.note} role="note">채우는 중인 선이 있습니다 — 그 수는 아직 늘 수 있고 판정(색)에 쓰지 않습니다</p>}
      {view.gapServers.length > 0 && (
        <p className={styles.note} role="note">
          {`최근에 잃은 항목: ${view.gapServers.map((gap) => `${gap.server} ${gap.sequenceGaps}개`).join(", ")} — 이 기간의 것인지는 알 수 없습니다`}
        </p>
      )}
      {view.edgesTruncated && <p className={styles.note} role="note">{`선이 ${view.edgeTotal}개라 요청이 많은 ${view.edges.length}개만 보입니다`}</p>}
      {view.edges.length === 0 ? (
        <p className={parts.empty}>
          {view.delayedServers.length > 0 ? "이 기간에 받은 선이 없습니다 — 수집이 밀린 서버가 있어 아직 모를 수 있습니다"
            : missingServers.length > 0 ? "이 기간에 받은 선이 없습니다 — 읽지 못한 구간이 있는 서버가 있어 아직 모를 수 있습니다"
              : "이 기간에 지나간 요청이 없습니다"}
        </p>
      ) : (
        <>
          <TrafficFigure view={view} />
          <h2 className={styles.sectionTitle}>통신 선</h2>
          <EdgeTable view={view} />
        </>
      )}
      {view.servers.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>수집 상태</h2>
          <ServerTable view={view} />
        </>
      )}
    </>
  );
}

export function TrafficMapBody({ range, state, dependencies, now }: TrafficMapBodyProps) {
  const shown = state.shown;
  const shownAt = shown === null ? null : formatKoreanLogTime(shown.fetchedAt);
  const stale = shown !== null && (state.connection === "reconnecting" || state.connection === "reopened" || state.connection === "session_ended");
  return (
    <section className={styles.body} aria-label={`통신 지도 — ${TRAFFIC_MAP_RANGE_LABELS[range]}`}>
      <ConnectionStatus state={state} />
      {stale && <p className={styles.note} role="note">{`아래 값은 ${shownAt} 의 것입니다 — 지금 값이 아닐 수 있습니다`}</p>}
      {state.failure !== null && (
        <div className={parts.problem} role="alert">
          {shown === null
            ? <p className={parts.problemTitle}>{`지도를 읽지 못했습니다 — 관측 서버: ${failureText(state.failure)}`}</p>
            : <>
              <p className={parts.problemTitle}>{`관측 서버에 닿지 못함 — ${failureText(state.failure)}`}</p>
              <p className={parts.problemDetail}>{`아래는 ${shownAt} 에 받은 값입니다`}</p>
            </>}
        </div>
      )}
      {state.brokenEvents > 0 && <p className={styles.note} role="note">{`깨진 갱신 ${state.brokenEvents}건을 버렸습니다`}</p>}
      {shown === null
        ? state.failure === null && <p className={parts.empty}>아직 받은 지도가 없습니다</p>
        : shown.map.ok && <MapContent view={shown.map.value} />}
      <DependencySection dependencies={dependencies} connection={state.connection} now={now} />
    </section>
  );
}
