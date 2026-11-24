/** 그래프 하나(서버 컴포넌트) — 화면 모델의 GraphView(buildChartGeometry 의 결과)를 SVG 로 그린다. 스크립트 없음.
 * 선의 구분은 색만이 아니다: 평균 선은 굵은 실선, 최댓값 선은 옅고 가는 점선, 두 번째 값(송신 · 쓰기)은 다른 무늬 + 범례 글.
 * 빈 구간은 모델이 끊어 둔 그대로(조각마다 M), 혼자 남은 점은 작은 표식. 축 눈금은 값과 KST 시각(1시간 · 24시간은 시:분, 7일 · 30일은 월/일).
 * SVG 는 role="img" 이고 이름은 모델의 글 요약 — 같은 요약을 그래프 아래에도 글로 보인다. */
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import type { ChartLine } from "@/features/resources/lib/resource-chart";
import { formatBytes, formatBytesPerSecond, formatPercent } from "@/features/resources/lib/resource-format";
import { RESOURCE_TEXT, type GraphUnit, type GraphView } from "@/features/resources/lib/resources-screen";
import type { ResourceRange } from "@/features/resources/lib/resources-query";
import type { UpstreamFailure } from "@/shared/lib/upstream-result";
import styles from "@/features/resources/ui/ResourceGraph.module.css";

/** 그림 영역 바깥의 여백(축 글자 자리) — SVG 좌표. */
const MARGIN = { top: 8, right: 12, bottom: 22, left: 64 } as const;
const RAW_STEP_MILLISECONDS = 30_000;

const UNIT_FORMATS: Readonly<Record<GraphUnit, (value: number | null) => string>> = {
  percent: formatPercent, bytes: formatBytes, bytesPerSecond: formatBytesPerSecond,
};

/** 선의 모양 — 같은 역할(평균 · 최댓값) 안에서 몇 번째 선인지(0 = 첫 값, 1 = 둘째 값 — 송신 · 쓰기). */
function lineClass(line: ChartLine, order: number): string {
  const role = line.role === "average" ? styles.lineAverage : styles.lineMaximum;
  return `${role} ${order === 0 ? styles.lineFirst : styles.lineSecond}`;
}

/** 같은 역할 안의 순서. */
function ordersOf(lines: ChartLine[]): number[] {
  const seen = { average: 0, maximum: 0 };
  return lines.map((line) => seen[line.role]++);
}

/** x 축 글자 — 1시간 · 24시간은 시:분, 7일 · 30일은 월/일(KST). */
function timeTickText(milliseconds: number, range: ResourceRange): string {
  const text = formatKoreanTime(new Date(milliseconds).toISOString());   // "YYYY-MM-DD HH:MM:SS"
  return range === "1h" || range === "24h" ? text.slice(11, 16) : text.slice(5, 10).replace("-", "/");
}

/** 한 점의 간격 글 — 30초 원본이 아니면 "한 점 = N분 평균". */
function stepNote(graph: GraphView): string | null {
  if (graph.stepMilliseconds <= RAW_STEP_MILLISECONDS && graph.source !== "rollup" && graph.source !== "mixed") return null;
  const minutes = Math.round(graph.stepMilliseconds / 60_000 * 10) / 10;
  return `한 점 = ${minutes}분 평균`;
}

function Legend({ lines, orders }: { lines: ChartLine[]; orders: number[] }) {
  return (
    <ul className={styles.legend} aria-label="선">
      {lines.map((line, index) => (
        <li key={line.key} className={styles.legendItem}>
          <svg className={styles.legendSample} viewBox="0 0 24 8" aria-hidden="true" focusable="false">
            <line x1="0" y1="4" x2="24" y2="4" className={lineClass(line, orders[index])} />
          </svg>
          {line.label}
        </li>
      ))}
    </ul>
  );
}

/** titleHidden — 카드 안처럼 둘레에 같은 이름이 이미 보일 때 제목을 화면에서만 숨긴다(읽기 도구에는 남는다). */
export function ResourceGraph({ graph, range, titleHidden = false }: { graph: GraphView; range: ResourceRange; titleHidden?: boolean }) {
  const { chart } = graph;
  const width = chart.width + MARGIN.left + MARGIN.right;
  const height = chart.height + MARGIN.top + MARGIN.bottom;
  const format = UNIT_FORMATS[graph.unit];
  const orders = ordersOf(chart.lines);
  const note = stepNote(graph);
  return (
    <figure className={styles.graph}>
      <figcaption className={titleHidden ? styles.titleHidden : styles.title}>{graph.title}</figcaption>
      {graph.pointCount === 0 ? <p className={styles.empty}>이 기간에 값이 없습니다</p> : (
        <svg className={styles.svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={graph.summary} focusable="false">
          <g transform={`translate(${MARGIN.left} ${MARGIN.top})`}>
            {chart.yTicks.map((tick) => (
              <g key={`y-${tick.position}`}>
                <line className={styles.grid} x1="0" x2={chart.width} y1={tick.position} y2={tick.position} />
                <text className={styles.tickText} x="-6" y={tick.position} textAnchor="end" dominantBaseline="middle">{format(tick.value)}</text>
              </g>
            ))}
            {chart.xTicks.map((tick, index) => (
              <text key={`x-${index}`} className={styles.tickText} x={tick.position} y={chart.height + 16}
                textAnchor={index === 0 ? "start" : index === chart.xTicks.length - 1 ? "end" : "middle"}>
                {timeTickText(tick.value, range)}
              </text>
            ))}
            {chart.lines.map((line, index) => (
              <g key={line.key}>
                {line.path !== "" && <path className={lineClass(line, orders[index])} d={line.path} />}
                {line.isolatedPoints.map((point, pointIndex) => (
                  <circle key={pointIndex} className={`${styles.isolated} ${line.role === "average" ? styles.isolatedAverage : styles.isolatedMaximum}`}
                    cx={point.x} cy={point.y} r={line.role === "average" ? 2.5 : 1.8} />
                ))}
              </g>
            ))}
          </g>
        </svg>
      )}
      {graph.pointCount > 0 && <Legend lines={chart.lines} orders={orders} />}
      <p className={styles.summary}>{graph.summary}</p>
      {note !== null && graph.pointCount > 0 && <p className={styles.note}>{note}</p>}
    </figure>
  );
}

/** 계열 조회가 실패한 그래프 자리. */
export function GraphFailure({ title, failure }: { title: string; failure: UpstreamFailure }) {
  return (
    <figure className={styles.graph}>
      <figcaption className={styles.title}>{title}</figcaption>
      <p className={styles.failure}>{RESOURCE_TEXT.unknown} — {failure.message}{failure.status !== undefined && <> · HTTP {failure.status}</>}</p>
    </figure>
  );
}
