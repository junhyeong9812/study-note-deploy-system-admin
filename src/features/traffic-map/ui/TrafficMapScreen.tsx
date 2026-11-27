/** 통신 지도 화면의 틀(서버 컴포넌트) — 제목 · 기간 고르기(스크립트 없는 링크) · 살아 있는 조각(TrafficMapLive). 받은 값만 그린다. */
import { TRAFFIC_MAP_RANGES, TRAFFIC_MAP_RANGE_LABELS } from "@/features/traffic-map/lib/traffic-map-query";
import type { TrafficMapScreen as TrafficMapScreenData } from "@/features/traffic-map/server/traffic-map";
import styles from "@/features/traffic-map/ui/TrafficMap.module.css";
import { TrafficMapLive } from "@/features/traffic-map/ui/TrafficMapLive";
import parts from "@/shared/ui/screen-parts.module.css";

export const TRAFFIC_MAP_PATH = "/traffic";

export function TrafficMapScreen({ screen }: { screen: TrafficMapScreenData }) {
  return (
    <main className={styles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>통신 지도</h1>
      </div>
      <nav aria-label="기간">
        <ul className={styles.ranges}>
          {TRAFFIC_MAP_RANGES.map((range) => (
            <li key={range}>
              <a className={`${styles.range} ${range === screen.range ? styles.rangeSelected : ""}`}
                href={`${TRAFFIC_MAP_PATH}?${new URLSearchParams({ range }).toString()}`} aria-current={range === screen.range ? "page" : undefined}>
                {TRAFFIC_MAP_RANGE_LABELS[range]}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <TrafficMapLive key={screen.range} range={screen.range} initial={screen.initial} initialDependencies={screen.initialDependencies} />
    </main>
  );
}
