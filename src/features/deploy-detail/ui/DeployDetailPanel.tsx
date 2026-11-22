/** 배포 상세(서버 컴포넌트) — 배포 요약 · 범위(A→B) · PR · 커밋 목록 · 고른 커밋의 바뀐 파일과 diff. 명세 §10.2.
 * 받은 값(진입 함수가 칸을 고른 결과)만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 커밋 고르기 · 닫기는 링크(GET), 파일 접고 펴기는 <details> — 브라우저 스크립트 없이 동작한다.
 * PR 본문 · 커밋 메시지 · diff 는 React 의 글자 출력으로만 그린다(HTML · 마크다운으로 해석하지 않는다). */
import type { ReactNode } from "react";
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import { formatKoreanTime, shortPrefix } from "@/features/deploys/lib/deploy-format";
import { Duration, FailedStage, StateBadge } from "@/features/deploys/ui/DeployHistoryTable";
import type { CommitListView, DeployDetailOutcome, DeployDetailView } from "@/features/deploy-detail/lib/deploy-detail-view";
import type { DeployRange } from "@/features/deploy-detail/lib/deploy-range";
import type { CommitDetail, CommitFileChange, FileChangeStatus, PullRequestSummary } from "@/features/deploy-detail/lib/github-client";
import { diffLines, type DiffLineKind } from "@/features/deploy-detail/lib/diff-lines";
import type { UpstreamFailure } from "@/shared/lib/upstream-result";
import styles from "@/features/deploy-detail/ui/DeployDetailPanel.module.css";

const COMMIT_PREFIX_LENGTH = 7;
/** 파일이 이 수 이하이면 처음부터 펼쳐 둔다. */
const OPEN_FILE_COUNT = 5;

export interface DeployDetailPanelProps {
  outcome: DeployDetailOutcome;
  /** 상세를 닫은 목록 주소(selected · commit 을 뺀다) */
  closeHref: string;
  /** 이 배포에서 커밋 하나를 고른 주소 */
  commitHref: (sha: string) => string;
}

const FIELD_LABELS: Readonly<Record<string, string>> = { service: "서비스", selected: "요청 ID", commit: "커밋" };

const FILE_STATUS_LABELS: Readonly<Record<FileChangeStatus, string>> = {
  added: "추가", removed: "삭제", modified: "수정", renamed: "이름 바뀜", copied: "복사", changed: "바뀜", unchanged: "그대로",
};

const DIFF_SIGNS: Readonly<Record<DiffLineKind, string>> = { addition: "+", deletion: "−", hunk: "", context: "", note: "" };
const DIFF_LINE_CLASS: Readonly<Record<DiffLineKind, string>> = {
  addition: styles.lineAddition, deletion: styles.lineDeletion, hunk: styles.lineHunk, context: styles.lineContext, note: styles.lineNote,
};

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function GitHubProblem({ failure }: { failure: UpstreamFailure }) {
  return (
    <p className={styles.problem} role="status">
      GitHub: {failure.message}{failure.status !== undefined && <> · HTTP {failure.status}</>}
    </p>
  );
}

function Time({ value }: { value: string | null }) {
  if (value === null) return <span className={styles.muted}>—</span>;
  return <time dateTime={value} title={`UTC ${value}`}>{formatKoreanTime(value)}</time>;
}

function ShortSha({ sha }: { sha: string }) {
  return <code className={styles.code} title={sha}>{shortPrefix(sha, COMMIT_PREFIX_LENGTH)}</code>;
}

function DeploymentSummaryList({ deployment }: { deployment: DeploymentSummary }) {
  return (
    <dl className={styles.summary}>
      <dt>서비스</dt><dd>{deployment.service}</dd>
      <dt>상태</dt><dd><StateBadge deployment={deployment} /></dd>
      <dt>접수(KST)</dt><dd><Time value={deployment.acceptedAt} /></dd>
      <dt>실패 단계</dt><dd><FailedStage stage={deployment.failedStage} /></dd>
      <dt>걸린 시간</dt><dd><Duration deployment={deployment} /></dd>
      <dt>요청 ID</dt><dd><code className={styles.code}>{deployment.requestId}</code></dd>
      <dt>커밋</dt><dd><code className={styles.code}>{deployment.commitSha}</code></dd>
    </dl>
  );
}

function RangeLine({ range, commits }: { range: DeployRange; commits: DeployDetailView["commits"] }) {
  if (range.status === "no_previous") return <p className={styles.range}>이전 성공 배포 없음 — 이번 커밋만</p>;
  if (range.status === "same_commit") return <p className={styles.range}>변경 없음(같은 커밋 재배포)</p>;
  const list = commits !== null && commits.ok ? commits.value : null;
  return (
    <div className={styles.range}>
      <p>
        직전 성공 배포 <ShortSha sha={range.baseCommitSha ?? ""} /> → 이번 배포 <ShortSha sha={range.headCommitSha} />
        {list !== null && <>, 커밋 {list.totalCommits}개</>}
      </p>
      {list !== null && list.diverged && (
        <p className={styles.warning} role="note">
          <span aria-hidden="true">⚠ </span>갈라진 이력 — 직전 성공 배포의 커밋이 이번 커밋의 조상이 아닙니다(강제 푸시 등). GitHub 비교 결과를 그대로 보여 줍니다.
        </p>
      )}
      {list !== null && list.comparisonStatus === "behind" && (
        <p className={styles.warning} role="note">이번 커밋이 직전 성공 배포의 커밋보다 앞선(오래된) 커밋입니다 — 되돌리는 배포.</p>
      )}
    </div>
  );
}

function PullRequestSection({ pullRequest }: { pullRequest: DeployDetailView["pullRequest"] }) {
  return (
    <section className={styles.section} aria-labelledby="deploy-detail-pull-request">
      <h3 id="deploy-detail-pull-request" className={styles.sectionTitle}>PR</h3>
      {pullRequest === null ? null : !pullRequest.ok ? (
        <GitHubProblem failure={pullRequest} />
      ) : pullRequest.value === null ? (
        <p className={styles.muted}>연결된 PR 없음</p>
      ) : (
        <PullRequestBody pullRequest={pullRequest.value} />
      )}
    </section>
  );
}

function PullRequestBody({ pullRequest }: { pullRequest: PullRequestSummary }) {
  return (
    <div className={styles.pullRequest}>
      <p className={styles.pullRequestTitle}>
        <span className={styles.muted}>#{pullRequest.number}</span> {pullRequest.title}
      </p>
      <p className={styles.meta}>
        {pullRequest.mergedAt !== null ? <>병합 <Time value={pullRequest.mergedAt} /></> : pullRequest.state === "open" ? "열림(병합 전)" : "닫힘(병합 안 됨)"}
        {" · "}<ExternalLink href={pullRequest.htmlUrl}>GitHub 에서 보기</ExternalLink>
      </p>
      {pullRequest.body !== null && pullRequest.body.length > 0
        ? <div className={styles.text}>{pullRequest.body}</div>
        : <p className={styles.muted}>(본문 없음)</p>}
    </div>
  );
}

function CommitListSection({ commits, selectedSha, commitHref }: { commits: UpstreamFailure | { ok: true; value: CommitListView }; selectedSha: string | null; commitHref: (sha: string) => string }) {
  return (
    <section className={styles.section} aria-labelledby="deploy-detail-commits">
      <h3 id="deploy-detail-commits" className={styles.sectionTitle}>
        커밋{commits.ok && <span className={styles.muted}> {commits.value.totalCommits}개</span>}
      </h3>
      {!commits.ok ? (
        <GitHubProblem failure={commits} />
      ) : commits.value.commits.length === 0 ? (
        <p className={styles.muted}>바뀐 커밋이 없습니다.</p>
      ) : (
        <>
          <ol className={styles.commitList}>
            {commits.value.commits.map((commit) => {
              const current = selectedSha !== null && commit.sha.toLowerCase() === selectedSha.toLowerCase();
              return (
                <li key={commit.sha}>
                  <a className={styles.commitLink} href={commitHref(commit.sha)} aria-current={current ? "true" : undefined}>
                    <ShortSha sha={commit.sha} />
                    <span className={styles.commitTitle}>{commit.title}</span>
                    <span className={styles.commitTime}><Time value={commit.authoredAt} /></span>
                  </a>
                </li>
              );
            })}
          </ol>
          {commits.value.hasMoreCommits && commits.value.htmlUrl !== null && (
            <p className={styles.more}>
              더 있음 — 전체 {commits.value.totalCommits}개 중 최근 {commits.value.commits.length}개만 보입니다.{" "}
              <ExternalLink href={commits.value.htmlUrl}>GitHub 에서 보기</ExternalLink>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function FileDiff({ file, commitUrl }: { file: CommitFileChange; commitUrl: string }) {
  if (file.patch.kind === "unavailable") return <p className={styles.muted}>미리 볼 수 없음(바이너리이거나 너무 큼)</p>;
  const patch = file.patch;
  return (
    <>
      <div className={styles.diffScroller} role="region" aria-label={`${file.filename} diff`} tabIndex={0}>
        <table className={styles.diff}>
          <tbody>
            {diffLines(patch.text).map((line, index) => (
              <tr key={index} className={DIFF_LINE_CLASS[line.kind]}>
                <td className={styles.lineNumber}>{line.oldNumber ?? ""}</td>
                <td className={styles.lineNumber}>{line.newNumber ?? ""}</td>
                <td className={styles.lineSign}>{DIFF_SIGNS[line.kind]}</td>
                <td className={styles.lineText}>{line.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {patch.truncated && (
        <p className={styles.more}>
          더 있음 — 전체 {patch.totalLines}줄 중 앞 {patch.text.split("\n").length}줄만 보입니다.{" "}
          <ExternalLink href={commitUrl}>GitHub 에서 보기</ExternalLink>
        </p>
      )}
    </>
  );
}

function CommitFilesSection({ commit }: { commit: DeployDetailView["commit"] }) {
  if (commit === null) {
    return (
      <section className={styles.section} aria-labelledby="deploy-detail-files">
        <h3 id="deploy-detail-files" className={styles.sectionTitle}>바뀐 파일</h3>
        <p className={styles.muted}>위 목록에서 커밋을 고르면 바뀐 파일과 diff 가 보입니다.</p>
      </section>
    );
  }
  if (!commit.ok) {
    return (
      <section className={styles.section} aria-labelledby="deploy-detail-files">
        <h3 id="deploy-detail-files" className={styles.sectionTitle}>바뀐 파일</h3>
        <GitHubProblem failure={commit} />
      </section>
    );
  }
  return <CommitFiles commit={commit.value} />;
}

function CommitFiles({ commit }: { commit: CommitDetail }) {
  const openAll = commit.files.length <= OPEN_FILE_COUNT;
  return (
    <section className={styles.section} aria-labelledby="deploy-detail-files">
      <h3 id="deploy-detail-files" className={styles.sectionTitle}>
        바뀐 파일 <ShortSha sha={commit.sha} /> <span className={styles.muted}>{commit.files.length}개</span>
      </h3>
      <p className={styles.meta}>
        {commit.authorName ?? "작성자 없음"} · <Time value={commit.authoredAt} /> · <ExternalLink href={commit.htmlUrl}>GitHub 에서 보기</ExternalLink>
      </p>
      <div className={styles.text}>{commit.message}</div>
      {commit.files.length === 0 && <p className={styles.muted}>바뀐 파일이 없습니다.</p>}
      <ul className={styles.fileList}>
        {commit.files.map((file) => (
          <li key={file.filename}>
            <details className={styles.file} open={openAll || undefined}>
              <summary className={styles.fileSummary}>
                <span className={styles.fileStatus}>{FILE_STATUS_LABELS[file.status]}</span>
                <span className={styles.fileName}>
                  {file.previousFilename !== null && <>{file.previousFilename} → </>}{file.filename}
                </span>
                <span className={styles.fileCounts}>
                  <span className={styles.additions}>+{file.additions}</span> <span className={styles.deletions}>−{file.deletions}</span>
                </span>
              </summary>
              <FileDiff file={file} commitUrl={commit.htmlUrl} />
            </details>
          </li>
        ))}
      </ul>
      {commit.hasMoreFiles && (
        <p className={styles.more}>
          파일이 더 있음 — 앞 {commit.files.length}개만 보입니다. <ExternalLink href={commit.htmlUrl}>GitHub 에서 보기</ExternalLink>
        </p>
      )}
    </section>
  );
}

function DetailBody({ outcome, commitHref }: { outcome: DeployDetailOutcome; commitHref: (sha: string) => string }) {
  if (outcome.kind === "invalid_input") {
    return (
      <div className={styles.problemBox} role="alert">
        <p className={styles.problemTitle}>선택 조건이 맞지 않습니다</p>
        <p>{FIELD_LABELS[outcome.field] ?? outcome.field} 값을 확인하세요. 커밋은 이 배포의 커밋 목록에 든 것만 고를 수 있습니다.</p>
      </div>
    );
  }
  if (outcome.kind === "not_found") {
    return (
      <div className={styles.problemBox} role="alert">
        <p className={styles.problemTitle}>선택한 배포를 찾을 수 없습니다</p>
        <p>그 서비스의 최근 200건 안에 이 요청 ID 가 없습니다.</p>
      </div>
    );
  }
  const { view } = outcome;
  if (!view.deployment.ok) {
    return (
      <div className={styles.problemBox} role="alert">
        <p className={styles.problemTitle}>배포 상세를 불러오지 못했습니다</p>
        <p>배포 서버: {view.deployment.message}{view.deployment.status !== undefined && <> · HTTP {view.deployment.status}</>}</p>
      </div>
    );
  }
  return (
    <>
      <DeploymentSummaryList deployment={view.deployment.value} />
      {view.range !== null && <RangeLine range={view.range} commits={view.commits} />}
      <PullRequestSection pullRequest={view.pullRequest} />
      {view.commits !== null && <CommitListSection commits={view.commits} selectedSha={view.query.commitSha} commitHref={commitHref} />}
      <CommitFilesSection commit={view.commit} />
    </>
  );
}

export function DeployDetailPanel({ outcome, closeHref, commitHref }: DeployDetailPanelProps) {
  return (
    <section className={styles.panel} aria-label="배포 상세">
      <div className={styles.panelHeader}>
        <a className={styles.backLink} href={closeHref}>← 목록으로</a>
        <h2 id="deploy-detail-title" className={styles.panelTitle}>배포 상세</h2>
        <a className={styles.closeLink} href={closeHref} aria-label="배포 상세 닫기">닫기 ✕</a>
      </div>
      <DetailBody outcome={outcome} commitHref={commitHref} />
    </section>
  );
}
