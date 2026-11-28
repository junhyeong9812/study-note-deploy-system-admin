/** 테스트 전용 — 버전 목록의 가짜 배포 master. 배포 이력(`GET /deploys?service=&limit=`)과 git 조회(`GET /deploys/git/commits?service=&from=&to=` ·
 * `GET /deploys/git/commit?service=&sha=`)를 실제 master 의 꼴(ci-cd internal/master/store.go Deployment · internal/agent/git_read.go)로 답한다.
 * git 이력은 한 줄로 이어진 커밋 사슬(오래된 것 먼저)이다 — 범위 A..B 는 A 제외 · B 포함, B 쪽이 먼저. 사슬에 없는 커밋은 404 commit_not_found.
 * 받은 요청은 fetch(createRoutedFetch)가 남긴다. 주소 · 비밀값은 upstream-test-fakes 의 문서용 가짜.
 * SHA 는 파일마다 · 부를 때마다 다르다 — 진입 모듈의 캐시가 사례 사이에 이어져도 앞 사례의 답이 섞이지 않는다. */
import { createHash, randomUUID } from "node:crypto";
import { gitCommitDetailJson, gitCommitJson, gitCommitRangeJson, masterGitFailure, masterGitSuccess } from "@/features/deploy-detail/lib/deploy-git-test-fakes";
import { createRoutedFetch, jsonBody, type RoutedFetchHandler } from "@/shared/lib/upstream-test-fakes";

export const MASTER_DEPLOYS_PATH = "/deploys";
export const MASTER_GIT_COMMITS_PATH = "/deploys/git/commits";
export const MASTER_GIT_COMMIT_PATH = "/deploys/git/commit";

const SALT = randomUUID();
let shaSequence = 0;
let requestSequence = 0;

/** 소문자 16진수 40자 — 부를 때마다 다르다. */
export function uniqueSha(): string {
  shaSequence += 1;
  return createHash("sha1").update(`${SALT}:sha:${shaSequence}`).digest("hex");
}

function uniqueRequestId(): string {
  requestSequence += 1;
  const hex = createHash("sha1").update(`${SALT}:request:${requestSequence}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface FakeCommit {
  sha: string;
  subject: string;
}

/** 제목들로 커밋 사슬을 만든다(오래된 것 먼저). */
export function commitChain(subjects: string[]): FakeCommit[] {
  return subjects.map((subject) => ({ sha: uniqueSha(), subject }));
}

/** 2026-11-20T00:00:00Z 에서 minutes 분 뒤(ISO, 초까지). */
export function minutesAfterStart(minutes: number): string {
  return new Date(Date.UTC(2026, 10, 20, 0, 0, 0) + minutes * 60_000).toISOString().replace(".000Z", "Z");
}

export type FakeDeployState = "accepted" | "ci_running" | "cd_running" | "succeeded" | "failed";

/** master 의 배포 한 건(JSON 칸 이름 그대로). 끝난 건(succeeded · failed)은 접수 3분 뒤에 finished_at, 진행 중은 finished_at 없음(omitempty). */
export function deploymentJson(service: string, commitSha: string, state: FakeDeployState, acceptedAt: string, overrides: Record<string, unknown> = {}) {
  const finished = state === "succeeded" || state === "failed";
  const row: Record<string, unknown> = {
    request_id: uniqueRequestId(), service, commit_sha: commitSha, state, accepted_at: acceptedAt,
    ci_ms: finished ? 60_000 : 0, cd_ms: finished ? 30_000 : 0,
  };
  if (finished) row.finished_at = new Date(Date.parse(acceptedAt) + 3 * 60_000).toISOString().replace(".000Z", "Z");
  if (state === "failed") row.failed_stage = "ci_test";
  return { ...row, ...overrides };
}

type RouteKey = typeof MASTER_DEPLOYS_PATH | typeof MASTER_GIT_COMMITS_PATH | typeof MASTER_GIT_COMMIT_PATH;

export interface FakeMaster {
  fetch: ReturnType<typeof createRoutedFetch>;
  /** 이력(최신순 — master 가 주는 순서). 기본 답은 service 인자로 거르고 limit 만큼 앞에서 자른다. 바꿔 끼워도 된다. */
  deployments: Record<string, unknown>[];
  /** git 이력(오래된 것 먼저) */
  chain: FakeCommit[];
  /** 경로별 답 바꿔 끼우기(없으면 기본 답) */
  override: Partial<Record<RouteKey, RoutedFetchHandler>>;
  /** 받은 요청의 주소 */
  requestedUrls: () => URL[];
  /** git 조회(두 경로) 요청의 주소 */
  gitRequests: () => URL[];
}

function rangeResponse(chain: FakeCommit[], url: URL): Response {
  const from = (url.searchParams.get("from") ?? "").toLowerCase();
  const to = (url.searchParams.get("to") ?? "").toLowerCase();
  const fromIndex = chain.findIndex((commit) => commit.sha === from);
  const toIndex = chain.findIndex((commit) => commit.sha === to);
  if (fromIndex < 0 || toIndex < 0) return masterGitFailure(404, "commit_not_found");
  if (fromIndex > toIndex) return masterGitSuccess(gitCommitRangeJson([], { relation: "not_ancestor" }));
  const commits = chain.slice(fromIndex + 1, toIndex + 1).reverse().map((commit) => gitCommitJson(commit.sha, { subject: commit.subject }));
  return masterGitSuccess(gitCommitRangeJson(commits));
}

function commitResponse(chain: FakeCommit[], url: URL): Response {
  const sha = (url.searchParams.get("sha") ?? "").toLowerCase();
  const commit = sha.length > 0 ? chain.find((each) => each.sha.startsWith(sha)) : undefined;
  if (commit === undefined) return masterGitFailure(404, "commit_not_found");
  return masterGitSuccess(gitCommitDetailJson(commit.sha, [], { subject: commit.subject }));
}

export function createFakeMaster(deployments: Record<string, unknown>[] = [], chain: FakeCommit[] = []): FakeMaster {
  const master: FakeMaster = {
    deployments,
    chain,
    override: {},
    fetch: createRoutedFetch((url, init) => {
      const custom = master.override[url.pathname as RouteKey];
      if (custom !== undefined) return custom(url, init);
      if (url.pathname === MASTER_DEPLOYS_PATH) {
        const service = url.searchParams.get("service");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const rows = master.deployments.filter((row) => service === null || row.service === service).slice(0, limit);
        return jsonBody({ success: true, data: { deployments: rows } });
      }
      if (url.pathname === MASTER_GIT_COMMITS_PATH) return rangeResponse(master.chain, url);
      if (url.pathname === MASTER_GIT_COMMIT_PATH) return commitResponse(master.chain, url);
      throw new Error(`unexpected upstream ${url.pathname}`);
    }),
    requestedUrls: () => master.fetch.mock.calls.map(([input]) => new URL(input)),
    gitRequests: () => master.requestedUrls().filter((url) => url.pathname === MASTER_GIT_COMMITS_PATH || url.pathname === MASTER_GIT_COMMIT_PATH),
  };
  return master;
}
