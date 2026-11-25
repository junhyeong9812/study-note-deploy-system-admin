/** 테스트 전용 — 재배포 확인 화면의 가짜 master: 버전 목록의 가짜(createFakeMaster)에 **가지가 갈라지는 git 이력**을 얹는다.
 * 커밋마다 부모 하나(parentSha). 범위 조회 A..B(ci-cd internal/agent/git_read.go readCommitRange · relation):
 * - A 가 B 의 조상(같은 커밋 포함) → relation ancestor, commits = B 에서 부모를 따라 A 직전까지(B 쪽이 먼저), 101개 이상이면 앞 100개 + truncated
 * - 그 밖 → not_ancestor, commits [](이력이 온전한 가짜라 unknown 은 내지 않는다 — unknown 은 사례가 override 로 끼운다)
 * - A · B 가 이력에 없으면 404 commit_not_found. 커밋 하나 조회는 앞부분이 맞는 커밋, 없으면 404. */
import { gitCommitDetailJson, gitCommitJson, gitCommitRangeJson, masterGitFailure, masterGitSuccess } from "@/features/deploy-detail/lib/deploy-git-test-fakes";
import {
  MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH, uniqueSha, type FakeMaster,
} from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import { FAKE_DEPLOY_MASTER_URL, UPSTREAM_RAW_MARKER } from "@/shared/lib/upstream-test-fakes";

export interface GraphCommit {
  sha: string;
  subject: string;
  /** 첫 커밋이면 null */
  parentSha: string | null;
}

/** parent 뒤에 한 줄로 이어지는 커밋들(오래된 것 먼저). parent 가 null 이면 뿌리부터. */
export function branchFrom(parent: GraphCommit | null, subjects: string[]): GraphCommit[] {
  const commits: GraphCommit[] = [];
  let parentSha = parent?.sha ?? null;
  for (const subject of subjects) {
    const commit = { sha: uniqueSha(), subject, parentSha };
    commits.push(commit);
    parentSha = commit.sha;
  }
  return commits;
}

const GIT_COMMIT_LIST_LIMIT = 100;

/** master 의 두 git 경로를 이 이력으로 답하게 한다(이미 끼운 override 는 덮어쓴다). */
export function installCommitGraph(master: FakeMaster, graph: readonly GraphCommit[]): void {
  const bySha = new Map(graph.map((commit) => [commit.sha, commit]));
  master.override[MASTER_GIT_COMMITS_PATH] = (url) => {
    const from = bySha.get((url.searchParams.get("from") ?? "").toLowerCase());
    const to = bySha.get((url.searchParams.get("to") ?? "").toLowerCase());
    if (from === undefined || to === undefined) return masterGitFailure(404, "commit_not_found");
    const walk: GraphCommit[] = [];
    let cursor: GraphCommit | undefined = to;
    while (cursor !== undefined && cursor.sha !== from.sha) {
      walk.push(cursor);
      cursor = cursor.parentSha === null ? undefined : bySha.get(cursor.parentSha);
    }
    if (cursor === undefined) return masterGitSuccess(gitCommitRangeJson([], { relation: "not_ancestor" }));
    const truncated = walk.length > GIT_COMMIT_LIST_LIMIT;
    const commits = walk.slice(0, GIT_COMMIT_LIST_LIMIT).map((commit) => gitCommitJson(commit.sha, { subject: commit.subject }));
    return masterGitSuccess(gitCommitRangeJson(commits, { truncated }));
  };
  master.override[MASTER_GIT_COMMIT_PATH] = (url) => {
    const sha = (url.searchParams.get("sha") ?? "").toLowerCase();
    const commit = sha.length > 0 ? graph.find((each) => each.sha.startsWith(sha)) : undefined;
    if (commit === undefined) return masterGitFailure(404, "commit_not_found");
    return masterGitSuccess(gitCommitDetailJson(commit.sha, [], { subject: commit.subject }));
  };
}

/** 범위 조회 가운데 양 끝이 {첫째, 둘째}(순서 무관)인 것 — 방향을 알아내려는 조회. */
export function rangeRequestsBetween(master: FakeMaster, firstSha: string, secondSha: string): URL[] {
  const pair = [firstSha, secondSha].sort().join(" ");
  return master.gitRequests().filter((url) => url.pathname === MASTER_GIT_COMMITS_PATH
    && [url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? ""].sort().join(" ") === pair);
}

// ---- 접수 요청의 실패 — Node 20 의 fetch(undici)가 실제로 던지는 꼴 ----
// 연결 실패: TypeError("fetch failed") + cause(시스템 오류 · code). 보낸 뒤 끊김: cause 가 SocketError(code UND_ERR_SOCKET).
// 본문을 읽다 끊김: 응답은 왔고 본문 스트림이 TypeError("terminated") + cause SocketError 로 실패한다.
// 메시지에는 원문 표식 · 주소를 일부러 넣는다(결과 · 응답에 나오면 원문을 흘린 것이다).

const LEAKY_CAUSE_TEXT = `${UPSTREAM_RAW_MARKER} ${FAKE_DEPLOY_MASTER_URL}`;

/** `TypeError("fetch failed")` 에 `cause.code` 가 실린 실패. aggregate 면 cause 가 AggregateError(IPv4 · IPv6 를 모두 시도한 연결 거부의 꼴). */
export function undiciFetchFailure(code: string, options: { aggregate?: boolean } = {}): TypeError {
  const cause = options.aggregate === true
    ? Object.assign(new AggregateError([Object.assign(new Error(`connect ${code} ${LEAKY_CAUSE_TEXT}`), { code })], LEAKY_CAUSE_TEXT), { code })
    : Object.assign(new Error(`${code} ${LEAKY_CAUSE_TEXT}`), { code });
  return new TypeError("fetch failed", { cause });
}

/** cause 가 없는 TypeError — 어디서 실패했는지 알 수 없다. */
export function fetchFailureWithoutCause(): TypeError {
  return new TypeError(`fetch failed ${LEAKY_CAUSE_TEXT}`);
}

/** 상태 · 머리글은 왔는데 본문을 읽는 중에 소켓이 끊긴 응답. */
export function bodyCutResponse(status: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{\"success\":true,\"data\":{\"request_id\":"));
      const cause = Object.assign(new Error(`other side closed ${LEAKY_CAUSE_TEXT}`), { name: "SocketError", code: "UND_ERR_SOCKET" });
      queueMicrotask(() => controller.error(new TypeError("terminated", { cause })));
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "application/json" } });
}
