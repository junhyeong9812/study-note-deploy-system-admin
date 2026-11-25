/** 버전 목록 화면의 본문(서버 컴포넌트) — 서비스 고르기 · 지금 버전 · 배포에 성공한 적 있는 버전들(커밋 제목 · 가장 최근 배포 시각 · 성공 횟수) ·
 * 배포 진행 중 한 줄 · 읽은 이력의 범위 · 다른 서버 실패 · 잘못된 입력.
 * 받은 값(진입 함수의 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 읽기만 한다 — 폼 · 단추 · 스크립트가 없고, 서비스 고르기는 링크(GET)다. 표 · 낱말 · 색은 배포 이력 화면의 것을 그대로 쓴다. */
import type { DeployVersionsView } from "@/features/deploy-versions/server/deploy-versions";
import type { DeployVersionList } from "@/features/deploy-versions/lib/deploy-versions-view";
import { describeDeployState, formatKoreanTime, shortPrefix } from "@/features/deploys/lib/deploy-format";
import { DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import screenStyles from "@/features/deploys/ui/DeployHistoryScreen.module.css";
import tableStyles from "@/features/deploys/ui/DeployHistoryTable.module.css";
import parts from "@/shared/ui/screen-parts.module.css";

export const DEPLOY_VERSIONS_PATH = "/deploys/versions";

const COMMIT_PREFIX_LENGTH = 7;

/** 버전 목록 화면의 주소 — 서비스를 골랐으면 `?service=<서비스>`. 배포 이력 화면의 링크도 이것을 쓴다. */
export function deployVersionsHref(service: DeployService | null): string {
  return service === null ? DEPLOY_VERSIONS_PATH : `${DEPLOY_VERSIONS_PATH}?${new URLSearchParams({ service }).toString()}`;
}

function ServiceChoice({ selected }: { selected: DeployService | null }) {
  return (
    <nav className={screenStyles.filter} aria-label="서비스 선택">
      <ul className={screenStyles.filterList}>
        {DEPLOY_SERVICES.map((service) => (
          <li key={service}>
            <a className={screenStyles.filterLink} href={deployVersionsHref(service)} aria-current={selected === service ? "page" : undefined}>
              {service}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function CommitCode({ sha }: { sha: string }) {
  return <code className={tableStyles.code} title={sha}>{shortPrefix(sha, COMMIT_PREFIX_LENGTH)}</code>;
}

function VersionList({ list }: { list: DeployVersionList }) {
  const { inProgress, titleFailure } = list;
  return (
    <>
      <p className={parts.count}>
        최근 {list.historyLimit}건의 배포에서 찾은 버전
        {list.reachedHistoryLimit && <> — 더 오래된 배포는 읽지 않았습니다(그 배포의 버전은 목록에 없을 수 있습니다).</>}
      </p>

      {inProgress !== null && (
        <p className={parts.count}>
          <span className={`${tableStyles.badge} ${tableStyles.badgeProgress}`}>
            <span aria-hidden="true" className={tableStyles.badgeMark}>…</span>배포 진행 중
            <span className={tableStyles.badgeDetail}>{describeDeployState(inProgress.state).detail}</span>
          </span>
          {" "}<CommitCode sha={inProgress.commitSha} /> · 접수{" "}
          <time dateTime={inProgress.acceptedAt} title={`UTC ${inProgress.acceptedAt}`}>{formatKoreanTime(inProgress.acceptedAt)}</time>
        </p>
      )}

      {titleFailure !== null && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>
            {`커밋 제목을 확인하지 못함 — ${titleFailure.message}${titleFailure.status !== undefined ? ` · HTTP ${titleFailure.status}` : ""}`}
          </p>
          <p className={parts.problemDetail}>버전 목록은 배포 이력에서 읽은 그대로입니다. 제목을 얻지 못한 줄은 &quot;제목 없음&quot;으로 보입니다.</p>
        </div>
      )}

      {list.versions.length === 0 ? (
        <p className={parts.empty}>{`${list.service} 의 성공한 배포가 없습니다.`}</p>
      ) : (
        <>
          <p className={parts.count}>
            지금 = 가장 최근에 성공한 배포의 커밋(배포 이력 기준). 같은 커밋은 한 줄 — 가장 최근 배포 시각과 성공 횟수.
          </p>
          <div className={tableStyles.scroller} tabIndex={0} role="region" aria-label="버전 목록 표">
            <table className={`${tableStyles.table} ${tableStyles.tableCompact}`}>
              <thead>
                <tr>
                  <th scope="col">커밋</th>
                  <th scope="col">커밋 제목</th>
                  <th scope="col">마지막 배포(KST)</th>
                  <th scope="col">성공 횟수</th>
                </tr>
              </thead>
              <tbody>
                {list.versions.map((version) => (
                  <tr key={version.commitSha}>
                    <td>
                      <CommitCode sha={version.commitSha} />
                      {version.current && <>{" "}<span className={`${tableStyles.badge} ${tableStyles.badgeSuccess}`}>지금</span></>}
                    </td>
                    <td>{version.title ?? <span className={tableStyles.none}>제목 없음</span>}</td>
                    <td className={tableStyles.time}>
                      <time dateTime={version.lastDeployedAt} title={`UTC ${version.lastDeployedAt}`}>{formatKoreanTime(version.lastDeployedAt)}</time>
                    </td>
                    <td className={tableStyles.time}>{`${version.deployCount}번`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

export function DeployVersionsScreen({ view }: { view: DeployVersionsView }) {
  const selected = view.query?.service ?? null;
  const { versions } = view;
  return (
    <main className={screenStyles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>버전 목록</h1>
        {versions !== null && versions.ok && (
          <p className={parts.count}>{selected} · <strong>{`${versions.value.versions.length}개`}</strong></p>
        )}
      </div>
      <ServiceChoice selected={selected} />

      {versions === null && <p className={parts.empty}>서비스를 고르면 지금 떠 있는 버전과 배포에 성공한 적 있는 버전들이 커밋 제목과 함께 보입니다.</p>}

      {versions !== null && !versions.ok && versions.reason === "invalid_input" && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>조회 조건이 맞지 않습니다</p>
          <p className={parts.problemDetail}>
            서비스 값을 확인하세요. 고를 수 있는 서비스: {DEPLOY_SERVICES.join(" · ")}. <a href={DEPLOY_VERSIONS_PATH}>처음으로</a>
          </p>
        </div>
      )}

      {versions !== null && !versions.ok && versions.reason !== "invalid_input" && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>버전 목록을 확인하지 못함</p>
          <p className={parts.problemDetail}>
            배포 서버: {versions.message}{versions.status !== undefined && <> · HTTP {versions.status}</>}
          </p>
        </div>
      )}

      {versions !== null && versions.ok && <VersionList list={versions.value} />}
    </main>
  );
}
