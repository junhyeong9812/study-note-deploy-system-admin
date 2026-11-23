/** master git 조회 클라이언트 — 배포 상세의 커밋 목록 · 커밋 하나의 diff 를 GitHub 대신 배포 master 에서 읽는다(명세 §10.3 · §12.2 · 12.7~12.9).
 * 순수: 설정 · 비밀값을 읽지 않는다(기준 주소 · 비밀값은 부르는 쪽이 준다 — 배포 이력 조회와 같은 DEPLOY_MASTER_URL · DEPLOY_SECRET).
 *
 * 경로(전부 GET · 머리글 `X-Deploy-Secret` · 5초 기한(getUpstream) · 재시도 없음 · redirect:"manual" — 3xx 는 bad_status):
 * - 커밋 목록: `GET <base>/deploys/git/commits?service=<서비스>&from=<A>&to=<B>`(인자 순서 그대로) — A 제외 · B 포함.
 * - 커밋 하나: `GET <base>/deploys/git/commit?service=<서비스>&sha=<SHA>`.
 * SHA 인자는 **소문자로 바꿔** 보낸다(master 는 소문자 16진수만 받는다 — ci-cd internal/shared/validate.go). Authorization 은 싣지 않는다.
 * 부르기 전 검사: service 가 DEPLOY_SERVICES 밖이면 invalid_input(field "service"), SHA(from · to · sha)가 16진수 7~40자가 아니면 invalid_input(field "sha") — 부르지 않는다.
 *
 * 응답 봉투 `{success:true,data:…}`(ci-cd internal/shared/envelope.go). data 의 칸(ci-cd internal/agent/git_read.go 의 JSON 이름):
 * - 커밋 목록 GitCommitRange: commits[{sha, author_name, authored_at, subject, body, body_truncated}] · truncated · range_complete · relation
 * - 커밋 하나 GitCommitDetail: sha · author_name · authored_at · subject · body · body_truncated ·
 *   files[{path, previous_path(글자|null), status, additions, deletions, binary, patch(글자|null), patch_truncated}] · files_truncated
 * 응답을 믿지 않는다 — 아래 중 하나면 전체가 unparseable(원문은 담지 않는다):
 * - 봉투가 아님 · 칸 없음 · 형 틀림(글자 · 참거짓 · 0 이상 정수 · 배열) · relation 이 세 값 밖 · 파일 status 가 네 값 밖
 * - 커밋의 sha 가 전체 SHA 꼴(소문자 16진수 40자 또는 64자)이 아님 · 커밋 하나의 sha 가 요청한 SHA(소문자)로 시작하지 않음
 * - relation 이 ancestor 가 아닌데 commits 가 비어 있지 않음(계약: not_ancestor · unknown 은 빈 목록)
 * 응답의 그 밖 칸(예: 작성자 이메일)은 버린다 — 아래 형의 칸만 고른다.
 *
 * 상한(master 가 이미 자르지만 넘는 응답을 그대로 믿지 않는다 — 넘으면 자르고 알린다, 조용히 자르지 않는다):
 * - 커밋 GIT_COMMIT_LIST_LIMIT(100)개: master 순서(B 쪽이 먼저)의 **앞 100개**(B 에 가까운 쪽)를 남기고 truncated:true.
 * - 파일 GIT_COMMIT_FILE_LIMIT(100)개: 앞 100개 · filesTruncated:true.
 * - 파일 하나의 patch GIT_FILE_PATCH_LINE_LIMIT(500)줄: 줄(patchLines — 끝의 `\n` 하나는 줄이 아니다)이 500 을 넘으면 앞 500줄(끝에 `\n`) · patchTruncated:true · patchTotalLines = 받은 줄 수.
 *   500줄 이하면 patch 글자를 바꾸지 않는다.
 * patchTotalLines: master 가 patch_truncated 면 null(전체 줄 수를 모른다), patch 가 null 이면 null, 그 밖은 받은 patch 의 줄 수(patchLines 의 수).
 * 글자(subject · body · patch · path)는 받은 그대로(해석 · 변환 · 다듬기 없음).
 *
 * 응답 상태 → 실패 이유(오류 봉투의 error.code 는 이유를 고르는 데만 쓰고 글자는 넘기지 않는다):
 * - 404 + code `commit_not_found` · `parent_unavailable` → not_in_history(404). 그 밖의 404(경로 없음 — 옛 master 등) → failureForHttpStatus(bad_status).
 * - 503 + code `repository_changing` → history_changing(503). 그 밖의 503 → unavailable.
 * - 429(`too_many_requests`) → rate_limited(429).
 * - 그 밖은 failureForHttpStatus: 401 unauthorized(어드민의 비밀값이 틀림) · 422 invalid_request · 504 server_timeout(`git_timeout` · `agent_timeout`) ·
 *   502 bad_status(`agent_unreachable` · `agent_unauthorized` · `unexpected_response`) · 500 bad_status(`git_failed`).
 * - 연결 실패 unreachable · 5초 timeout · 깨진 JSON unparseable(getUpstream 의 관례 그대로). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { isCommitSha } from "@/features/deploy-detail/lib/deploy-detail-query";
import { patchLines } from "@/features/deploy-detail/lib/diff-lines";
import { DEPLOY_SERVICES, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import { getUpstream, isNonNegativeInteger, isRecord, upstreamUrl, type UpstreamResponse } from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, invalidInput, upstreamFailure, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const DEPLOY_GIT_COMMITS_PATH = "/deploys/git/commits";
export const DEPLOY_GIT_COMMIT_PATH = "/deploys/git/commit";

export const GIT_COMMIT_LIST_LIMIT = 100;
export const GIT_COMMIT_FILE_LIMIT = 100;
export const GIT_FILE_PATCH_LINE_LIMIT = 500;

/** 범위의 뜻(명세 12.7 · 12.8) — ancestor: A 가 B 의 조상(목록 = A..B) · not_ancestor: 되돌린 배포 · 갈라진 이력(빈 목록) ·
 * unknown: 얕은 이력의 경계에서 끊겨 이 서버의 git 으로는 알 수 없음(빈 목록 · range_complete:false). */
export const GIT_RELATIONS = ["ancestor", "not_ancestor", "unknown"] as const;
export type GitRelation = (typeof GIT_RELATIONS)[number];

/** 파일 status(agent 의 네 값). */
export const GIT_FILE_STATUSES = ["added", "modified", "deleted", "renamed"] as const;
export type GitFileStatus = (typeof GIT_FILE_STATUSES)[number];

/** 커밋 하나의 요약 — 작성자 이메일은 없다(master 도 내지 않는다). */
export interface GitCommit {
  /** 전체 SHA(소문자 40자 또는 64자) */
  sha: string;
  authorName: string;
  /** ISO-8601 UTC 글자 그대로 */
  authoredAt: string;
  subject: string;
  body: string;
  /** body_truncated — 본문을 master 가 잘랐다 */
  bodyTruncated: boolean;
}

export interface GitCommitRange {
  /** master 순서 그대로(B 쪽이 먼저 — --topo-order), 최대 GIT_COMMIT_LIST_LIMIT 개 */
  commits: GitCommit[];
  /** master 의 truncated 이거나 어드민이 상한으로 잘랐다 */
  truncated: boolean;
  /** range_complete — false 면 목록에 얕은 경계 커밋이 들어 있다(그 너머는 서버에 없다) · unknown 이면 언제나 false */
  rangeComplete: boolean;
  relation: GitRelation;
}

export interface GitFileChange {
  path: string;
  /** renamed 일 때만 글자, 그 밖은 null */
  previousPath: string | null;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** 바이너리 · 생략이면 null, 그 밖은 GitHub 의 patch 와 같은 꼴(첫 줄이 "@@" 구간 머리) — 최대 GIT_FILE_PATCH_LINE_LIMIT 줄 */
  patch: string | null;
  /** master 의 patch_truncated 이거나 어드민이 500줄로 잘랐다 */
  patchTruncated: boolean;
  /** 받은 patch 의 전체 줄 수 — master 가 잘랐거나 patch 가 null 이면 null */
  patchTotalLines: number | null;
}

export interface GitCommitDetail extends GitCommit {
  /** 최대 GIT_COMMIT_FILE_LIMIT 개(앞에서부터) */
  files: GitFileChange[];
  /** master 의 files_truncated 이거나 어드민이 상한으로 잘랐다 */
  filesTruncated: boolean;
}

export interface DeployGitClientOptions {
  /** DEPLOY_MASTER_URL — 끝의 / 허용 */
  baseUrl: string;
  /** DEPLOY_SECRET — X-Deploy-Secret 로만 싣는다 */
  secret: string;
  fetch: FetchLike;
  /** 기본 AbortSignal.timeout — 5000 으로 부른다 */
  timeoutSignal?: TimeoutSignalFactory;
}

export interface DeployGitClient {
  /** A(fromSha) 다음부터 B(toSha) 까지 — 범위의 커밋 목록과 relation. */
  listCommits(service: DeployService, fromSha: string, toSha: string): Promise<UpstreamResult<GitCommitRange>>;
  /** 커밋 하나와 파일별 diff(첫째 부모와의 차이). */
  getCommit(service: DeployService, sha: string): Promise<UpstreamResult<GitCommitDetail>>;
}

/** 전체 SHA — 소문자 16진수 40자(SHA-1) 또는 64자(SHA-256). */
const FULL_COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** 이유를 고르는 데만 쓰는 오류 코드(글자는 넘기지 않는다). */
const NOT_IN_HISTORY_CODES: readonly string[] = ["commit_not_found", "parent_unavailable"];
const HISTORY_CHANGING_CODE = "repository_changing";

/** 해석 중 꼴이 다를 때 던진다 — 응답 하나의 해석을 통째로 unparseable 로 바꾼다(원문은 담지 않는다). */
class UnexpectedShape extends Error {}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new UnexpectedShape();
  return value;
}

function requireText(value: unknown): string {
  if (typeof value !== "string") throw new UnexpectedShape();
  return value;
}

/** null 이면 null, 글자면 그대로, 그 밖(칸 없음 포함)은 꼴이 다름. */
function requireTextOrNull(value: unknown): string | null {
  if (value === null) return null;
  return requireText(value);
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new UnexpectedShape();
  return value;
}

function requireCount(value: unknown): number {
  if (!isNonNegativeInteger(value)) throw new UnexpectedShape();
  return value;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new UnexpectedShape();
  return value;
}

function requireOneOf<Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new UnexpectedShape();
  return value as Value;
}

function requireFullSha(value: unknown): string {
  const sha = requireText(value);
  if (!FULL_COMMIT_SHA_PATTERN.test(sha)) throw new UnexpectedShape();
  return sha;
}

/** 커밋 요약의 칸만 고른다(작성자 이메일 등 그 밖 칸은 버린다). */
function parseCommit(value: unknown): GitCommit {
  const row = requireRecord(value);
  return {
    sha: requireFullSha(row.sha),
    authorName: requireText(row.author_name),
    authoredAt: requireText(row.authored_at),
    subject: requireText(row.subject),
    body: requireText(row.body),
    bodyTruncated: requireBoolean(row.body_truncated),
  };
}

function parseCommitRange(data: Record<string, unknown>): GitCommitRange {
  const received = requireArray(data.commits).map(parseCommit);
  const relation = requireOneOf(data.relation, GIT_RELATIONS);
  if (relation !== "ancestor" && received.length > 0) throw new UnexpectedShape();   // 계약: not_ancestor · unknown 은 빈 목록
  const commits = received.slice(0, GIT_COMMIT_LIST_LIMIT);   // B 쪽(앞)을 남긴다
  return {
    commits,
    truncated: requireBoolean(data.truncated) || received.length > commits.length,
    rangeComplete: requireBoolean(data.range_complete),
    relation,
  };
}

function parseFileChange(value: unknown): GitFileChange {
  const row = requireRecord(value);
  const receivedPatch = requireTextOrNull(row.patch);
  const masterTruncated = requireBoolean(row.patch_truncated);
  const file = {
    path: requireText(row.path),
    previousPath: requireTextOrNull(row.previous_path),
    status: requireOneOf(row.status, GIT_FILE_STATUSES),
    additions: requireCount(row.additions),
    deletions: requireCount(row.deletions),
    binary: requireBoolean(row.binary),
  };
  if (receivedPatch === null) return { ...file, patch: null, patchTruncated: masterTruncated, patchTotalLines: null };
  const lines = patchLines(receivedPatch);   // 끝의 줄바꿈 하나는 줄이 아니다
  const cut = lines.length > GIT_FILE_PATCH_LINE_LIMIT;
  return {
    ...file,
    patch: cut ? `${lines.slice(0, GIT_FILE_PATCH_LINE_LIMIT).join("\n")}\n` : receivedPatch,
    patchTruncated: masterTruncated || cut,
    patchTotalLines: masterTruncated ? null : lines.length,
  };
}

function parseCommitDetail(data: Record<string, unknown>, requestedSha: string): GitCommitDetail {
  const commit = parseCommit(data);
  const received = requireArray(data.files).map(parseFileChange);
  const files = received.slice(0, GIT_COMMIT_FILE_LIMIT);
  if (!commit.sha.startsWith(requestedSha)) throw new UnexpectedShape();   // 요청한 커밋이 아니다
  return { ...commit, files, filesTruncated: requireBoolean(data.files_truncated) || received.length > files.length };
}

/** 오류 봉투의 error.code — 이유를 고르는 데만 쓴다. 없거나 글자가 아니면 null. */
function errorCodeOf(response: UpstreamResponse): string | null {
  if (!response.parsed || !isRecord(response.json) || !isRecord(response.json.error)) return null;
  const code = response.json.error.code;
  return typeof code === "string" ? code : null;
}

/** 2xx 가 아닌 응답 → 실패 이유(머리 주석의 표). */
function failureForMasterGitResponse(response: UpstreamResponse): UpstreamFailure {
  const { status } = response;
  const code = errorCodeOf(response);
  if (status === 404 && code !== null && NOT_IN_HISTORY_CODES.includes(code)) return upstreamFailure("not_in_history", { status });
  if (status === 503 && code === HISTORY_CHANGING_CODE) return upstreamFailure("history_changing", { status });
  if (status === 429) return upstreamFailure("rate_limited", { status });
  return failureForHttpStatus(status);
}

function isDeployService(service: string): service is DeployService {
  return (DEPLOY_SERVICES as readonly string[]).includes(service);
}

export function createDeployGitClient(options: DeployGitClientOptions): DeployGitClient {
  async function get<Value>(path: string, parameters: [string, string][], parse: (data: Record<string, unknown>) => Value): Promise<UpstreamResult<Value>> {
    const response = await getUpstream(upstreamUrl(options.baseUrl, path, parameters), {
      fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers: { "X-Deploy-Secret": options.secret },
    });
    if (!response.ok) return response;
    if (response.status < 200 || response.status >= 300) return failureForMasterGitResponse(response);
    if (!response.parsed || !isRecord(response.json) || response.json.success !== true || !isRecord(response.json.data)) {
      return upstreamFailure("unparseable");
    }
    try {
      return { ok: true, value: parse(response.json.data) };
    } catch (error) {
      if (error instanceof UnexpectedShape) return upstreamFailure("unparseable");
      throw error;
    }
  }

  return {
    async listCommits(service, fromSha, toSha) {
      if (!isDeployService(service)) return invalidInput("service");
      if (!isCommitSha(fromSha) || !isCommitSha(toSha)) return invalidInput("sha");
      return get(DEPLOY_GIT_COMMITS_PATH, [["service", service], ["from", fromSha.toLowerCase()], ["to", toSha.toLowerCase()]], parseCommitRange);
    },
    async getCommit(service, sha) {
      if (!isDeployService(service)) return invalidInput("service");
      if (!isCommitSha(sha)) return invalidInput("sha");
      const requestedSha = sha.toLowerCase();
      return get(DEPLOY_GIT_COMMIT_PATH, [["service", service], ["sha", requestedSha]], (data) => parseCommitDetail(data, requestedSha));
    },
  };
}

/** 캐시의 항목 수 상한(넘으면 오래된 것부터 버린다 — 재시작하면 비워짐). */
export const DEPLOY_GIT_CACHE_MAXIMUM_ENTRIES = 500;

export interface DeployGitCacheOptions {
  /** 기본 DEPLOY_GIT_CACHE_MAXIMUM_ENTRIES */
  maximumEntries?: number;
}

/** client 와 같은 꼴의 메모리 캐시 감싸기(만료 없음 — SHA 로 정해지는 응답만 둔다).
 * - getCommit: 성공이면 저장(열쇠 = 서비스 + 받은 SHA 글자). 실패는 저장하지 않는다.
 * - listCommits: 성공이고 relation "ancestor" · rangeComplete:true · truncated:false 인 것만 저장(열쇠 = 서비스 + A + B).
 *   not_ancestor · unknown · rangeComplete:false · truncated · 실패는 저장하지 않는다 — 이력이 바뀌면(다음 배포의 fetch) 답이 달라진다.
 * - 항목 수가 maximumEntries 를 넘으면 가장 오래 전에 넣은 것부터 버린다(두 경로가 한 상한을 함께 쓴다). */
export function createCachedDeployGitClient(client: DeployGitClient, options: DeployGitCacheOptions = {}): DeployGitClient {
  const maximumEntries = options.maximumEntries ?? DEPLOY_GIT_CACHE_MAXIMUM_ENTRIES;
  /** Map 은 넣은 순서를 지키므로 첫 항목이 가장 오래된 것이다. */
  const entries = new Map<string, unknown>();

  function remember(key: string, value: unknown) {
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > maximumEntries) {
      const oldestKey = entries.keys().next().value as string;
      entries.delete(oldestKey);
    }
  }

  return {
    async listCommits(service, fromSha, toSha) {
      const key = `commits:${service}:${fromSha}:${toSha}`;
      if (entries.has(key)) return { ok: true, value: entries.get(key) as GitCommitRange };
      const result = await client.listCommits(service, fromSha, toSha);
      // 이력이 바뀌면(다음 배포의 fetch) 답이 달라지는 것은 두지 않는다
      if (result.ok && result.value.relation === "ancestor" && result.value.rangeComplete && !result.value.truncated) remember(key, result.value);
      return result;
    },
    async getCommit(service, sha) {
      const key = `commit:${service}:${sha}`;
      if (entries.has(key)) return { ok: true, value: entries.get(key) as GitCommitDetail };
      const result = await client.getCommit(service, sha);
      if (result.ok) remember(key, result.value);   // 실패는 저장하지 않는다
      return result;
    },
  };
}
