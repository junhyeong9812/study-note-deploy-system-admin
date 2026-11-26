/** 배포 이력 화면의 본문(서버 컴포넌트) — 서비스 선택 · 건수 · 표 · 빈 목록 · 다른 서버 실패 · 잘못된 입력 · 배포 상세(§10.2).
 * 받은 값(진입 함수가 칸을 고른 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 서비스 선택 · 줄 고르기 · 커밋 고르기 · 닫기는 링크(GET)라 브라우저 스크립트 없이 동작한다.
 * 상세를 열면 넓은 화면(1100px 이상)은 왼쪽 목록 | 오른쪽 상세로 나누고, 좁은 화면은 상세가 화면 전체를 덮는다. */
import type { DeployDetailOutcome } from "@/features/deploy-detail/lib/deploy-detail-view";
import { DeployDetailPanel } from "@/features/deploy-detail/ui/DeployDetailPanel";
import { deployVersionsHref } from "@/features/deploy-versions/ui/DeployVersionsScreen";
import type { DeployHistoryView } from "@/features/deploys/server/deploy-history";
import { DEPLOY_HISTORY_DEFAULT_LIMIT, DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import { DeployHistoryTable } from "@/features/deploys/ui/DeployHistoryTable";
import { deploysHref, type DeployListAddress } from "@/features/deploys/ui/deploys-address";
import styles from "@/features/deploys/ui/DeployHistoryScreen.module.css";
import parts from "@/shared/ui/screen-parts.module.css";

/** 입력 이름 → 화면 글자(잘못된 입력 안내). */
const FIELD_LABELS: Readonly<Record<string, string>> = { service: "서비스", limit: "건수" };

function filterHref(service: DeployService | null, limit: number): string {
  return deploysHref({ service, limit });
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

export interface DeployHistoryScreenProps {
  view: DeployHistoryView;
  /** 상세(주소에 selected 가 있을 때) — 없으면 null */
  detail: DeployDetailOutcome | null;
  /** 목록에서 강조할 요청 ID */
  selectedRequestId: string | null;
}

export function DeployHistoryScreen({ view, detail, selectedRequestId }: DeployHistoryScreenProps) {
  const selected = view.query?.service ?? null;
  const limit = view.query?.limit ?? DEPLOY_HISTORY_DEFAULT_LIMIT;
  const { deployments } = view;
  const list: DeployListAddress = { service: selected, limit };
  const closeHref = deploysHref(list);
  const commitHref = (sha: string) => (detail?.kind === "view"
    ? deploysHref(list, { requestId: detail.view.query.selectedRequestId, service: detail.view.query.service, commitSha: sha })
    : closeHref);
  const listContent = (
    <>
      {!deployments.ok && deployments.reason === "invalid_input" && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>조회 조건이 맞지 않습니다</p>
          <p className={parts.problemDetail}>
            {FIELD_LABELS[deployments.field ?? ""] ?? deployments.field} 값을 확인하세요. 고를 수 있는 서비스: 전체 · {DEPLOY_SERVICES.join(" · ")}
            {" "}· 건수는 1~200. <a href="/deploys">전체 보기</a>
          </p>
        </div>
      )}

      {!deployments.ok && deployments.reason !== "invalid_input" && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>배포 이력을 불러오지 못했습니다</p>
          <p className={parts.problemDetail}>
            배포 서버: {deployments.message}{deployments.status !== undefined && <> · HTTP {deployments.status}</>}
          </p>
        </div>
      )}

      {deployments.ok && deployments.value.length === 0 && (
        <p className={parts.empty}>{selected === null ? "배포 기록이 없습니다." : `${selected} 의 배포 기록이 없습니다.`}</p>
      )}

      {deployments.ok && deployments.value.length > 0 && (
        <DeployHistoryTable
          deployments={deployments.value}
          rowHref={(deployment) => deploysHref(list, { requestId: deployment.requestId, service: deployment.service })}
          selectedRequestId={detail === null ? null : selectedRequestId}
          compact={detail !== null}
        />
      )}
    </>
  );
  return (
    <main className={`${styles.main} ${detail !== null ? styles.mainSplit : ""}`}>
      <div className={parts.heading}>
        <h1 className={parts.title}>배포 이력</h1>
        {deployments.ok && (
          <p className={parts.count}>
            {selected ?? "전체"} · <strong>{deployments.value.length}건</strong>
            <span className={parts.countNote}>(최신순, 최대 {limit}건)</span>
          </p>
        )}
        <p className={parts.count}><a href={deployVersionsHref(selected)}>{selected === null ? "버전 목록" : `${selected} 의 버전 목록`}</a></p>
      </div>
      <ServiceFilter selected={selected} limit={limit} />
      {detail === null ? listContent : (
        <div className={styles.split}>
          <div className={styles.splitList}>{listContent}</div>
          <DeployDetailPanel outcome={detail} closeHref={closeHref} commitHref={commitHref} />
        </div>
      )}
    </main>
  );
}
