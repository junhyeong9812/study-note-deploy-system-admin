/** 재배포 확인 화면의 본문(서버 컴포넌트) — 지금 버전 → 고른 버전 · 방향(글이 먼저) · 사이의 커밋 표 · 되돌릴 때의 데이터 꼴 안내 ·
 * 100개 상한 · 얕은 경계 · 배포 진행 중 · 고를 수 없는 버전 · 틀린 입력 · 실패 · 버전 목록으로 돌아가는 링크.
 * 받은 값(진입 함수의 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 읽기만 한다 — 폼 · 단추 · 입력 · 스크립트가 없다(접수는 다음 조각). 두 버전은 표의 줄로 그리지 않는다(표의 줄 = 사이의 커밋).
 * 표 · 낱말 · 색은 배포 이력 화면의 것을 그대로 쓴다. */
import type { BetweenCommits, RedeployDirection, RedeployPreview } from "@/features/deploy-redeploy/lib/redeploy-preview";
import type { RedeployPreviewView } from "@/features/deploy-redeploy/server/redeploy-preview";
import type { DeployVersion } from "@/features/deploy-versions/lib/deploy-versions-view";
import { deployVersionsHref } from "@/features/deploy-versions/ui/DeployVersionsScreen";
import { formatKoreanTime, shortPrefix } from "@/features/deploys/lib/deploy-format";
import { DEPLOY_SERVICES } from "@/features/deploys/lib/deploy-history-query";
import screenStyles from "@/features/deploys/ui/DeployHistoryScreen.module.css";
import tableStyles from "@/features/deploys/ui/DeployHistoryTable.module.css";
import parts from "@/shared/ui/screen-parts.module.css";

const COMMIT_PREFIX_LENGTH = 7;

/** 입력 이름 → 화면 글자(잘못된 입력 안내). */
const FIELD_LABELS: Readonly<Record<string, string>> = { service: "서비스", commit: "커밋" };

const UNKNOWN_REASON_LABELS = {
  diverged: "갈라진 이력(어느 쪽도 다른 쪽의 조상이 아님)",
  shallow_history: "서버의 git 이력이 얕아 판정할 수 없음",
} as const;

function CommitCode({ sha }: { sha: string }) {
  return <code className={tableStyles.code} title={sha}>{shortPrefix(sha, COMMIT_PREFIX_LENGTH)}</code>;
}

function VersionLine({ label, version }: { label: string; version: DeployVersion }) {
  return (
    <p className={parts.count}>
      <strong>{label}</strong>{" "}<CommitCode sha={version.commitSha} />{" "}
      {version.title ?? <span className={tableStyles.none}>제목 없음</span>}
      {" · 마지막 배포 "}
      <time dateTime={version.lastDeployedAt} title={`UTC ${version.lastDeployedAt}`}>{formatKoreanTime(version.lastDeployedAt)}</time>
    </p>
  );
}

function BetweenTable({ label, between }: { label: string; between: BetweenCommits }) {
  return (
    <>
      <p className={parts.count}>
        <strong>{`${label} ${between.commits.length}개${between.truncated ? " 이상" : ""}`}</strong>
        <span className={parts.countNote}>(최신순 — 지금 버전 쪽이 위)</span>
      </p>
      {between.truncated && <p className={parts.count}>커밋이 100개보다 많아 일부만 보입니다(지금 쪽 100개).</p>}
      {!between.complete && <p className={parts.count}>서버의 git 이력 경계에 닿아 목록의 일부가 빠졌을 수 있습니다.</p>}
      <div className={tableStyles.scroller} tabIndex={0} role="region" aria-label={`${label} 표`}>
        <table className={`${tableStyles.table} ${tableStyles.tableCompact}`}>
          <thead>
            <tr>
              <th scope="col">커밋</th>
              <th scope="col">커밋 제목</th>
            </tr>
          </thead>
          <tbody>
            {between.commits.map((commit) => (
              <tr key={commit.sha}>
                <td><CommitCode sha={commit.sha} /></td>
                <td>{commit.title}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Direction({ direction }: { direction: RedeployDirection }) {
  switch (direction.kind) {
    case "same":
      return <p className={parts.count}><strong>같은 버전을 다시 올립니다</strong> — 지금 떠 있는 커밋을 한 번 더 배포합니다.</p>;
    case "rollback":
      return (
        <>
          <p className={parts.count}><strong>되돌립니다</strong> — 고른 버전은 지금 버전보다 앞선 커밋입니다. 아래 커밋들이 서버에서 빠집니다.</p>
          <div className={parts.problem} role="note">
            <p className={parts.problemDetail}>
              데이터 꼴(표의 구조)을 바꾼 커밋이 사이에 있으면 되돌린 뒤 앱이 깨질 수 있습니다. 목록을 보고 판단하세요.
            </p>
          </div>
          <BetweenTable label="사라지는 커밋" between={direction.between} />
        </>
      );
    case "forward":
      return (
        <>
          <p className={parts.count}><strong>앞으로 올립니다</strong> — 고른 버전은 지금 버전보다 뒤의 커밋입니다. 아래 커밋들이 서버에 더해집니다.</p>
          <BetweenTable label="더해지는 커밋" between={direction.between} />
        </>
      );
    case "unknown": {
      const { failure } = direction;
      const reason = direction.reason === "lookup_failed"
        ? (failure === null ? "조회 실패" : `${failure.message}${failure.status !== undefined ? ` · HTTP ${failure.status}` : ""}`)
        : UNKNOWN_REASON_LABELS[direction.reason];
      return (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>{`두 버전의 앞뒤를 확인하지 못함 — ${reason}`}</p>
          <p className={parts.problemDetail}>되돌리기인지 앞으로인지, 사이에 어떤 커밋이 있는지 보일 수 없습니다.</p>
        </div>
      );
    }
  }
}

function Preview({ preview }: { preview: RedeployPreview }) {
  if (preview.kind === "not_deployable") {
    return (
      <div className={parts.problem} role="alert">
        <p className={parts.problemTitle}>배포된 적 없는 버전은 고를 수 없습니다</p>
        <p className={parts.problemDetail}>
          <CommitCode sha={preview.commitSha} /> 는 {preview.service} 의 성공한 배포 이력(최근 200건)에 없습니다. 버전 목록에서 고르세요.
        </p>
      </div>
    );
  }
  return (
    <>
      {preview.inProgress !== null && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>배포 진행 중 — 끝난 뒤에 올릴 수 있습니다</p>
          <p className={parts.problemDetail}>
            진행 중인 배포 <CommitCode sha={preview.inProgress.commitSha} /> · 접수{" "}
            <time dateTime={preview.inProgress.acceptedAt} title={`UTC ${preview.inProgress.acceptedAt}`}>{formatKoreanTime(preview.inProgress.acceptedAt)}</time>
          </p>
        </div>
      )}
      <VersionLine label="지금 버전" version={preview.current} />
      <VersionLine label="고른 버전" version={preview.chosen} />
      <Direction direction={preview.direction} />
    </>
  );
}

export function RedeployPreviewScreen({ view }: { view: RedeployPreviewView }) {
  const { preview, service } = view;
  return (
    <main className={screenStyles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>재배포 확인</h1>
        {service !== null && <p className={parts.count}>{service}</p>}
        <p className={parts.count}><a href={deployVersionsHref(service)}>버전 목록으로</a></p>
      </div>

      {!preview.ok && preview.reason === "invalid_input" && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>조회 조건이 맞지 않습니다</p>
          <p className={parts.problemDetail}>
            {`${FIELD_LABELS[preview.field ?? ""] ?? preview.field} 값을 확인하세요. `}
            고를 수 있는 서비스: {DEPLOY_SERVICES.join(" · ")} · 커밋은 버전 목록의 링크가 주는 전체 SHA(소문자 40자)만 받습니다.
          </p>
        </div>
      )}

      {!preview.ok && preview.reason !== "invalid_input" && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>버전을 확인하지 못함</p>
          <p className={parts.problemDetail}>
            {`배포 서버: ${preview.message}${preview.status !== undefined ? ` · HTTP ${preview.status}` : ""}`}
          </p>
        </div>
      )}

      {preview.ok && <Preview preview={preview.value} />}
    </main>
  );
}
