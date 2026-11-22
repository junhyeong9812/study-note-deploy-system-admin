/** 배포 이력 화면의 본문(서버 컴포넌트) — 서비스 선택 · 건수 · 표 · 빈 목록 · 다른 서버 실패 · 잘못된 입력.
 * 받은 값(진입 함수가 칸을 고른 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 서비스 선택은 링크(GET)라 브라우저 스크립트 없이 동작한다. */
import type { DeployHistoryView } from "@/features/deploys/server/deploy-history";
import { DEPLOY_HISTORY_DEFAULT_LIMIT, DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import { DeployHistoryTable } from "@/features/deploys/ui/DeployHistoryTable";
import styles from "@/features/deploys/ui/DeployHistoryScreen.module.css";

/** 입력 이름 → 화면 글자(잘못된 입력 안내). */
const FIELD_LABELS: Readonly<Record<string, string>> = { service: "서비스", limit: "건수" };

function filterHref(service: DeployService | null, limit: number): string {
  const search = new URLSearchParams();
  if (service !== null) search.set("service", service);
  if (limit !== DEPLOY_HISTORY_DEFAULT_LIMIT) search.set("limit", String(limit));
  const query = search.toString();
  return query.length > 0 ? `/deploys?${query}` : "/deploys";
}

function ServiceFilter({ selected, limit }: { selected: DeployService | null; limit: number }) {
  const options: (DeployService | null)[] = [null, ...DEPLOY_SERVICES];
  return (
    <nav className={styles.filter} aria-label="서비스 선택">
      <ul className={styles.filterList}>
        {options.map((service) => (
          <li key={service ?? "all"}>
            <a className={styles.filterLink} href={filterHref(service, limit)} aria-current={selected === service ? "page" : undefined}>
              {service ?? "전체"}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DeployHistoryScreen({ view }: { view: DeployHistoryView }) {
  const selected = view.query?.service ?? null;
  const limit = view.query?.limit ?? DEPLOY_HISTORY_DEFAULT_LIMIT;
  const { deployments } = view;
  return (
    <main className={styles.main}>
      <div className={styles.heading}>
        <h1 className={styles.title}>배포 이력</h1>
        {deployments.ok && (
          <p className={styles.count}>
            {selected ?? "전체"} · <strong>{deployments.value.length}건</strong>
            <span className={styles.countNote}>(최신순, 최대 {limit}건)</span>
          </p>
        )}
      </div>
      <ServiceFilter selected={selected} limit={limit} />

      {!deployments.ok && deployments.reason === "invalid_input" && (
        <div className={styles.problem} role="alert">
          <p className={styles.problemTitle}>조회 조건이 맞지 않습니다</p>
          <p className={styles.problemDetail}>
            {FIELD_LABELS[deployments.field ?? ""] ?? deployments.field} 값을 확인하세요. 고를 수 있는 서비스: 전체 · {DEPLOY_SERVICES.join(" · ")}
            {" "}· 건수는 1~200. <a href="/deploys">전체 보기</a>
          </p>
        </div>
      )}

      {!deployments.ok && deployments.reason !== "invalid_input" && (
        <div className={styles.problem} role="alert">
          <p className={styles.problemTitle}>배포 이력을 불러오지 못했습니다</p>
          <p className={styles.problemDetail}>
            배포 서버: {deployments.message}{deployments.status !== undefined && <> · HTTP {deployments.status}</>}
          </p>
        </div>
      )}

      {deployments.ok && deployments.value.length === 0 && (
        <p className={styles.empty}>{selected === null ? "배포 기록이 없습니다." : `${selected} 의 배포 기록이 없습니다.`}</p>
      )}

      {deployments.ok && deployments.value.length > 0 && <DeployHistoryTable deployments={deployments.value} />}
    </main>
  );
}
