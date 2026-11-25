/** 연관 로그 "그때 서버 상태"의 자원 칸(서버 컴포넌트) — 명세 §2.6 · §10.4 · §11.5 · §17 끝 줄 "수치만 — 그 로그 시각의 값과 앞뒤 5분의 최댓값
 * (서버의 CPU · 메모리 · 디스크, 그 서비스 컨테이너의 CPU · 메모리). '서버 자원' 화면으로 가는 링크를 둔다. 그래프는 넣지 않는다".
 * 받은 값(진입 함수의 TraceResourcesView)만 그린다. 값이 없으면 모델의 글("없음" · "기록 없음") — 0 으로 보이지 않게.
 * 못 찾은 경우 둘을 가른다: 다 물었는데 없음 → "기록 없음" / 일부 조회가 실패 → "어느 서버였는지 확인하지 못함". 조회가 통째로 실패하면 이 칸만 "확인하지 못함". */
import { RESOURCE_RANGE_MILLISECONDS, RESOURCE_RANGES, resourcesHref, type ResourceRange } from "@/features/resources/lib/resources-query";
import {
  TRACE_RESOURCE_TEXT, type TraceResourcesView, type TraceSeriesView, type TraceServerLocation,
} from "@/features/log-trace/lib/trace-resources";
import type { UpstreamFailure, UpstreamResult } from "@/shared/lib/upstream-result";
import styles from "@/features/log-trace/ui/LogTracePanel.module.css";

const UNKNOWN_TEXT = "확인하지 못함";
const ROLLUP_STEP_MILLISECONDS = 5 * 60 * 1000;

/** 로그 시각이 들어가는 가장 짧은 기간(지금 기준) — 1시간 · 24시간 · 7일, 그 밖은 30일. */
export function rangeContaining(atMilliseconds: number, nowMilliseconds: number): ResourceRange {
  const age = Math.max(0, nowMilliseconds - atMilliseconds);
  return RESOURCE_RANGES.find((range) => age <= RESOURCE_RANGE_MILLISECONDS[range]) ?? "30d";
}

/** 서버 자원 화면의 그 서버(그 서비스 컨테이너가 있으면 그 컨테이너를 고른 주소). */
function resourcesScreenLink(location: Extract<TraceServerLocation, { kind: "found" }>, atMilliseconds: number, nowMilliseconds: number): string {
  const range = rangeContaining(atMilliseconds, nowMilliseconds);
  const container = location.serviceContainer === null ? null : { server: location.server, container: location.serviceContainer };
  return `${resourcesHref({ range, container })}#resource-server-${location.server}`;
}

function failureText(failure: UpstreamFailure): string {
  return `${UNKNOWN_TEXT} — ${failure.message}${failure.status !== undefined ? ` · HTTP ${failure.status}` : ""}`;
}

/** 5분 평균(고른 로그가 7일보다 오래됨)에서 읽은 값인가. */
function isRollup(series: UpstreamResult<TraceSeriesView> | null): boolean {
  return series !== null && series.ok && (series.value.source === "rollup" || series.value.source === "mixed" || series.value.stepMilliseconds >= ROLLUP_STEP_MILLISECONDS);
}

/** 한 갈래(서버 · 컨테이너)의 줄들 — 지표 · 그 로그 시각의 값 · 앞뒤 5분의 최댓값. 실패 · 기록 없음은 한 줄. */
function SeriesRows({ group, series, emptyText }: { group: string; series: UpstreamResult<TraceSeriesView> | null; emptyText: string }) {
  if (series === null || !series.ok || series.value.noRecord) {
    const text = series === null ? emptyText : !series.ok ? failureText(series) : TRACE_RESOURCE_TEXT.noRecord;
    return (
      <tr>
        <th scope="row">{group}</th>
        <td colSpan={3} className={styles.muted}>{text}</td>
      </tr>
    );
  }
  return (
    <>
      {series.value.values.map((value, index) => (
        <tr key={value.label}>
          {index === 0 && <th scope="row" rowSpan={series.value.values.length}>{group}</th>}
          <td>{value.label}</td>
          <td className={value.atLogValue === null ? styles.muted : undefined}>{value.atLogText}</td>
          <td className={value.maximumValue === null ? styles.muted : undefined}>{value.maximumText}</td>
        </tr>
      ))}
    </>
  );
}

function FoundBlock({ resources, location, nowMilliseconds }: {
  resources: TraceResourcesView; location: Extract<TraceServerLocation, { kind: "found" }>; nowMilliseconds: number;
}) {
  const rollup = isRollup(resources.host) || isRollup(resources.container);
  return (
    <>
      <p className={styles.resourceWhere}>
        서버 <strong>{location.server}</strong>
        {location.serviceContainer !== null && <> (<span className={styles.code}>{location.serviceContainer}</span>)</>}
      </p>
      <table className={styles.countTable}>
        <thead>
          <tr><th scope="col">갈래</th><th scope="col">지표</th><th scope="col">그 로그 시각</th><th scope="col">앞뒤 5분 최댓값</th></tr>
        </thead>
        <tbody>
          <SeriesRows group="서버" series={resources.host} emptyText={TRACE_RESOURCE_TEXT.noRecord} />
          <SeriesRows group="컨테이너" series={resources.container} emptyText="그 서비스 컨테이너 기록 없음" />
        </tbody>
      </table>
      <p className={styles.rangeNote}>컨테이너 CPU 는 코어 하나 = 100%(100% 를 넘을 수 있다){rollup && <> · 5분 평균 값(고른 로그가 7일보다 오래됨)</>}</p>
      {location.alsoSeenOn.length > 0 && <p className={styles.muted}>같은 서비스가 서버 {location.alsoSeenOn.join(" · ")} 에도 보였습니다.</p>}
      {location.uncheckedServers.length > 0 && <p className={styles.muted}>서버 {location.uncheckedServers.join(" · ")} 는 {UNKNOWN_TEXT}.</p>}
      <p><a className={styles.stateLink} href={resourcesScreenLink(location, resources.atMilliseconds, nowMilliseconds)}>서버 자원 화면에서 보기 →</a></p>
    </>
  );
}

export function TraceResourcesBlock({ resources, nowMilliseconds }: { resources: TraceResourcesView; nowMilliseconds: number }) {
  const location = resources.location;
  return (
    <div className={styles.stateBlock} aria-labelledby="log-trace-resources-title" role="group">
      <h4 id="log-trace-resources-title" className={styles.stateTitle}>그때 서버 자원 — {resources.service} · 앞뒤 5분</h4>
      {!location.ok ? <p className={styles.muted}>{failureText(location)}</p>
        : location.value.kind === "none" ? <p className={styles.muted}>{TRACE_RESOURCE_TEXT.noRecord} — 그 시각에 {resources.service} 컨테이너를 본 서버가 없습니다(보관 기간 밖 · 수집 전).</p>
        : location.value.kind === "unknown" ? <p className={styles.muted}>{TRACE_RESOURCE_TEXT.unknownServer} — 서버 {location.value.failedServers.join(" · ")} 에 묻지 못했습니다.</p>
        : <FoundBlock resources={resources} location={location.value} nowMilliseconds={nowMilliseconds} />}
    </div>
  );
}
