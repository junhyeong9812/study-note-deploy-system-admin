/** 재배포 확인 화면의 본문(서버 컴포넌트) — 지금 버전 → 고른 버전 · 방향(글이 먼저) · 사이의 커밋 표 · 되돌릴 때의 데이터 꼴 안내 ·
 * 100개 상한 · 얕은 경계 · 배포 진행 중 · 고를 수 없는 버전 · 틀린 입력 · 실패 · 버전 목록으로 돌아가는 링크.
 * 받은 값(진입 함수의 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 그리기만 한다 — 스크립트가 없다. 접수 폼(비교가 되고 진행 중인 배포가 없을 때만)은 POST /api/deploys/redeploy 하나(숨은 칸 서비스 · 커밋 · 확인 값 + 비밀번호).
 * 두 버전은 표의 줄로 그리지 않는다(표의 줄 = 사이의 커밋).
 * 표 · 낱말 · 색은 배포 이력 화면의 것을 그대로 쓴다.
 * 문제의 조치로 연 것이면(명세 ⑫ §24) 머리 아래에 "문제 <ID> 의 조치" 한 줄과 문제 화면으로 돌아가는 링크 · 폼에 숨은 칸 incident ·
 * 확인 화면을 낼 수 없으면 그 까닭만(폼 없음). 문제의 조치가 아니면 이 조각 전과 같은 마크업이다. */
import type { BetweenCommits, RedeployDirection, RedeployPreview } from "@/features/deploy-redeploy/lib/redeploy-preview";
import { REDEPLOY_ACCEPT_ACTION, REDEPLOY_INCIDENT_TEXT } from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import type { RedeployAcceptSubmission, RedeployIncidentContext, RedeployPreviewView } from "@/features/deploy-redeploy/server/redeploy-preview";
import type { DeployVersion } from "@/features/deploy-versions/lib/deploy-versions-view";
import { deployVersionsHref } from "@/features/deploy-versions/ui/DeployVersionsScreen";
import { formatKoreanTime, shortPrefix } from "@/features/deploys/lib/deploy-format";
import { DEPLOY_SERVICES } from "@/features/deploys/lib/deploy-history-query";
import { incidentHref } from "@/features/incidents/lib/incidents-query";
import screenStyles from "@/features/deploys/ui/DeployHistoryScreen.module.css";
import tableStyles from "@/features/deploys/ui/DeployHistoryTable.module.css";
import formStyles from "@/features/auth/ui/LoginForm.module.css";
import parts from "@/shared/ui/screen-parts.module.css";

const COMMIT_PREFIX_LENGTH = 7;

/** 입력 이름 → 화면 글자(잘못된 입력 안내). */
const FIELD_LABELS: Readonly<Record<string, string>> = { service: "서비스", commit: "커밋", incident: "문제의 ID", action: "조치" };

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

const PASSWORD_FIELD_ID = "redeploy-password";

function AcceptForm({ service, commitSha, confirmation, incident }: { service: string; commitSha: string; confirmation: string; incident: RedeployIncidentContext | null }) {
  return (
    <form className={formStyles.form} method="post" action={REDEPLOY_ACCEPT_ACTION}>
      <input type="hidden" name="service" value={service} />
      <input type="hidden" name="commit" value={commitSha} />
      <input type="hidden" name="confirmation" value={confirmation} />
      {incident !== null && <input type="hidden" name="incident" value={incident.incidentId} />}
      {incident !== null && <input type="hidden" name="action" value={incident.action} />}
      <div className={formStyles.field}>
        <label className={formStyles.label} htmlFor={PASSWORD_FIELD_ID}>비밀번호</label>
        <input className={formStyles.input} id={PASSWORD_FIELD_ID} type="password" name="password" autoComplete="current-password" required />
      </div>
      <button className={formStyles.button} type="submit">{`${service} 를 ${shortPrefix(commitSha, COMMIT_PREFIX_LENGTH)} 로 배포`}</button>
    </form>
  );
}

/** commitSha = 확인 값에 서명한 커밋(주소의 commit 또는 문제의 조치에서 서버가 정한 판 — 소문자 40자). */
function Submission({ preview, submission, commitSha, incident }: {
  preview: Extract<RedeployPreview, { kind: "comparison" }>; submission: RedeployAcceptSubmission; commitSha: string; incident: RedeployIncidentContext | null;
}) {
  if (submission.kind === "incident_account_too_long") {
    return (
      <div className={parts.problem} role="alert">
        <p className={parts.problemTitle}>{REDEPLOY_INCIDENT_TEXT.accountTooLong}</p>
      </div>
    );
  }
  if (submission.kind === "account_not_allowed") {
    return (
      <div className={parts.problem} role="alert">
        <p className={parts.problemTitle}>이 계정 이름으로는 배포를 일으킬 수 없습니다</p>
        <p className={parts.problemDetail}>접수에 남기는 이름(admin:계정)은 영문 · 숫자 · . _ - 만 받습니다. 계정 이름(ADMIN_USER)을 바꾼 뒤 다시 여세요.</p>
      </div>
    );
  }
  return (
    <>
      {preview.direction.kind === "unknown" && (
        <p className={parts.count}>그래도 올리려면 두 커밋을 따로 확인한 뒤 비밀번호를 넣어 접수하세요.</p>
      )}
      <p className={parts.count}>접수하면 배포 서버가 이 커밋을 다시 빌드해 올립니다. 비밀번호를 다시 확인합니다(이 확인 화면은 5분 동안만 쓸 수 있습니다).</p>
      <AcceptForm service={preview.service} commitSha={commitSha} confirmation={submission.confirmation} incident={incident} />
    </>
  );
}

function Preview({ preview, submission, commitSha, incident }: { preview: RedeployPreview; submission: RedeployAcceptSubmission | null; commitSha: string; incident: RedeployIncidentContext | null }) {
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
      {submission !== null && <Submission preview={preview} submission={submission} commitSha={commitSha} incident={incident} />}
    </>
  );
}

export function RedeployPreviewScreen({ view }: { view: RedeployPreviewView }) {
  const { preview, service, submission, incident } = view;
  // 문제의 조치에서 확인 화면을 낼 수 없으면 그 까닭만 보인다(조회 실패 상자를 그리지 않는다)
  const showPreview = incident === undefined || incident.reason === null;
  return (
    <main className={screenStyles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>재배포 확인</h1>
        {service !== null && <p className={parts.count}>{service}</p>}
        <p className={parts.count}><a href={deployVersionsHref(service)}>버전 목록으로</a></p>
      </div>
      {incident !== undefined && (
        <p className={parts.count}>
          <strong>{`${REDEPLOY_INCIDENT_TEXT.headingPrefix}${incident.incidentId}${REDEPLOY_INCIDENT_TEXT.headingSuffix}`}</strong>
          {" · "}<a href={incidentHref(incident.incidentId)}>{REDEPLOY_INCIDENT_TEXT.back}</a>
        </p>
      )}
      {incident?.reason != null && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>{incident.reason}</p>
        </div>
      )}

      {!preview.ok && preview.reason === "invalid_input" && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>조회 조건이 맞지 않습니다</p>
          <p className={parts.problemDetail}>
            {`${FIELD_LABELS[preview.field ?? ""] ?? preview.field} 값을 확인하세요. `}
            고를 수 있는 서비스: {DEPLOY_SERVICES.join(" · ")} · 커밋은 버전 목록의 링크가 주는 전체 SHA(소문자 40자)만 받습니다.
          </p>
        </div>
      )}

      {showPreview && !preview.ok && preview.reason !== "invalid_input" && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>버전을 확인하지 못함</p>
          <p className={parts.problemDetail}>
            {`배포 서버: ${preview.message}${preview.status !== undefined ? ` · HTTP ${preview.status}` : ""}`}
          </p>
        </div>
      )}

      {showPreview && preview.ok && view.query !== null && (
        <Preview preview={preview.value} submission={submission} commitSha={view.query.commitSha} incident={incident ?? null} />
      )}
    </main>
  );
}
