/** GitHub REST API 클라이언트(순수 — 설정 · 비밀값을 읽지 않는다. 토큰은 부르는 쪽이 준다). 명세 §10.2.
 * 경로(전부 GET, 5초 기한, 재시도 없음, redirect:"manual" — 3xx 는 bad_status):
 * - 비교: `GET /repos/{owner}/{repo}/compare/{base}...{head}` — 쪽 나눔 인자를 보내지 않는다(GitHub 기본: 최대 250개, 시간순, 마지막이 가장 최근).
 * - 커밋 하나: `GET /repos/{owner}/{repo}/commits/{sha}?per_page=100` — 파일 목록 + 파일별 patch.
 * - 커밋에 연결된 PR: `GET /repos/{owner}/{repo}/commits/{sha}/pulls`.
 * 머리글: `Accept: application/vnd.github+json` · `X-GitHub-Api-Version: 2022-11-28` · 토큰이 있으면(빈 글자 아님) `Authorization: Bearer <토큰>`, 없으면 Authorization 없음.
 * 응답 상태 → 실패 이유:
 * - 403 · 429 이고 `x-ratelimit-remaining: 0` 이거나 `retry-after` 가 있으면 rate_limited(한도 초과 — 1차 · 2차 한도). 429 는 머리글이 없어도 rate_limited.
 *   그 밖의 403 은 bad_status.
 * - 404 · 422 → not_found(없는 커밋 · 저장소). 401 → unauthorized. 그 밖은 failureForHttpStatus(503 unavailable · 504 server_timeout · 그 밖 bad_status).
 * 상한(넘으면 자르되 "더 있음"을 표시 — 조용히 자르지 않는다):
 * - 비교의 커밋 100개: 받은 목록의 **마지막 100개**(B 에 가까운 쪽)를 남긴다. hasMoreCommits = total_commits(또는 받은 개수) > 남긴 개수.
 * - 커밋 하나의 파일 100개: 앞 100개. hasMoreFiles = 받은 파일이 100개 넘음 또는 Link 머리글에 rel="next".
 * - 파일 하나의 patch 500줄: `\n` 으로 나눈 줄 수가 500 을 넘으면 앞 500줄(`\n` 으로 다시 잇는다)과 truncated:true · totalLines.
 * - patch 칸이 없거나 글자가 아니면(바이너리 · 너무 큼) patch = {kind:"unavailable"}.
 * 글자(커밋 메시지 · PR 제목 · 본문 · patch)는 받은 그대로 넘긴다(해석 · 변환 · 다듬기 없음). 응답에서 아래 형의 칸만 고른다(원본 통째 전달 금지).
 * html_url 류는 `https://github.com/` 로 시작해야 한다 — 아니면 unparseable(화면의 링크가 다른 곳으로 가지 않게).
 * 꼴이 다르면(칸 빠짐 · 형 다름 · 모르는 status) 전체가 unparseable. SHA 인자가 16진수 7~40자가 아니면 부르지 않고 invalid_input(field "sha"). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { isCommitSha } from "@/features/deploy-detail/lib/deploy-detail-query";
import type { GitHubRepository } from "@/features/deploy-detail/lib/github-repository";
import { getUpstream, isNonNegativeInteger, isRecord, upstreamUrl, type UpstreamResponse } from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, invalidInput, upstreamFailure, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

/** 실제 GitHub API 기준 주소 — 서버 쪽 진입이 쓴다(테스트는 클라이언트에 다른 주소를 준다). */
export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_ACCEPT = "application/vnd.github+json";
/** html_url 이 이 글자로 시작해야 한다. */
export const GITHUB_WEB_ORIGIN_PREFIX = "https://github.com/";

export const COMMIT_LIST_LIMIT = 100;
export const COMMIT_FILE_LIMIT = 100;
export const FILE_PATCH_LINE_LIMIT = 500;

/** compare 의 status(GitHub 문서의 열거). diverged = 갈라진 이력(강제 푸시 등 — A 가 B 의 조상이 아님). */
export const COMPARISON_STATUSES = ["ahead", "behind", "diverged", "identical"] as const;
export type ComparisonStatus = (typeof COMPARISON_STATUSES)[number];

/** 파일 status(GitHub 문서의 열거). */
export const FILE_CHANGE_STATUSES = ["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"] as const;
export type FileChangeStatus = (typeof FILE_CHANGE_STATUSES)[number];

/** 커밋 한 줄(목록용). */
export interface CommitSummary {
  /** 40자 SHA(GitHub 가 준 그대로) */
  sha: string;
  /** 메시지의 첫 줄(첫 `\n` 앞 — 그 밖은 그대로) */
  title: string;
  /** 메시지 전체(글자 그대로) */
  message: string;
  /** commit.author.name — 없으면 null */
  authorName: string | null;
  /** commit.author.date — 없으면 null */
  authoredAt: string | null;
  htmlUrl: string;
}

export interface CommitComparison {
  status: ComparisonStatus;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  /** 시간순(오래된 것 먼저), 최대 COMMIT_LIST_LIMIT 개 — 넘으면 마지막(가장 최근) 쪽을 남긴다 */
  commits: CommitSummary[];
  hasMoreCommits: boolean;
  /** compare 의 html_url(더 보기 링크) */
  htmlUrl: string;
}

export type FilePatch =
  | { kind: "text"; text: string; truncated: boolean; totalLines: number }
  | { kind: "unavailable" };

export interface CommitFileChange {
  filename: string;
  /** previous_filename(이름 바뀜일 때) — 없으면 null */
  previousFilename: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  patch: FilePatch;
}

export interface CommitDetail extends CommitSummary {
  /** 최대 COMMIT_FILE_LIMIT 개(앞에서부터) */
  files: CommitFileChange[];
  hasMoreFiles: boolean;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  /** 본문(글자 그대로) — 없으면 null */
  body: string | null;
  state: "open" | "closed";
  /** merged_at — 병합되지 않았으면 null */
  mergedAt: string | null;
  htmlUrl: string;
}

export interface GitHubClientOptions {
  /** 끝의 / 허용 */
  baseUrl: string;
  /** null · 빈 글자 = 토큰 없음(Authorization 을 싣지 않는다) */
  token: string | null;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;   // 기본 AbortSignal.timeout — 5000 으로 부른다
}

export interface GitHubClient {
  compareCommits(repository: GitHubRepository, baseSha: string, headSha: string): Promise<UpstreamResult<CommitComparison>>;
  getCommit(repository: GitHubRepository, sha: string): Promise<UpstreamResult<CommitDetail>>;
  /** GitHub 가 준 순서 그대로(고르기는 choosePullRequest) */
  listPullRequestsForCommit(repository: GitHubRepository, sha: string): Promise<UpstreamResult<PullRequestSummary[]>>;
}

/** 여럿이면 병합된 것(mergedAt 이 있는 것) 중 GitHub 순서의 첫 번째, 병합된 것이 없으면 첫 번째, 빈 목록이면 null. */
export function choosePullRequest(pullRequests: readonly PullRequestSummary[]): PullRequestSummary | null {
  return pullRequests.find((pullRequest) => pullRequest.mergedAt !== null) ?? pullRequests[0] ?? null;
}

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

/** 없음 · null 은 null, 글자는 그대로, 그 밖은 꼴이 다름. */
function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requireText(value);
}

function requireCount(value: unknown): number {
  if (!isNonNegativeInteger(value)) throw new UnexpectedShape();
  return value;
}

function requireGitHubWebUrl(value: unknown): string {
  const text = requireText(value);
  if (!text.startsWith(GITHUB_WEB_ORIGIN_PREFIX)) throw new UnexpectedShape();
  return text;
}

function requireOneOf<Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new UnexpectedShape();
  return value as Value;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new UnexpectedShape();
  return value;
}

function parseCommitSummary(value: unknown): CommitSummary {
  const row = requireRecord(value);
  const sha = requireText(row.sha);
  if (!isCommitSha(sha)) throw new UnexpectedShape();
  const commit = requireRecord(row.commit);
  const message = requireText(commit.message);
  let authorName: string | null = null;
  let authoredAt: string | null = null;
  if (commit.author !== undefined && commit.author !== null) {
    const author = requireRecord(commit.author);
    authorName = optionalText(author.name);
    authoredAt = optionalText(author.date);
  }
  const newlineIndex = message.indexOf("\n");
  return {
    sha, title: newlineIndex < 0 ? message : message.slice(0, newlineIndex), message, authorName, authoredAt,
    htmlUrl: requireGitHubWebUrl(row.html_url),
  };
}

function parseComparison(json: unknown): CommitComparison {
  const body = requireRecord(json);
  const received = requireArray(body.commits).map(parseCommitSummary);
  const totalCommits = requireCount(body.total_commits);
  const commits = received.slice(-COMMIT_LIST_LIMIT);   // B 에 가까운(가장 최근) 쪽을 남긴다
  return {
    status: requireOneOf(body.status, COMPARISON_STATUSES),
    aheadBy: requireCount(body.ahead_by),
    behindBy: requireCount(body.behind_by),
    totalCommits,
    commits,
    hasMoreCommits: Math.max(totalCommits, received.length) > commits.length,
    htmlUrl: requireGitHubWebUrl(body.html_url),
  };
}

function parsePatch(value: unknown): FilePatch {
  if (typeof value !== "string") return { kind: "unavailable" };
  const lines = value.split("\n");
  if (lines.length <= FILE_PATCH_LINE_LIMIT) return { kind: "text", text: value, truncated: false, totalLines: lines.length };
  return { kind: "text", text: lines.slice(0, FILE_PATCH_LINE_LIMIT).join("\n"), truncated: true, totalLines: lines.length };
}

function parseFileChange(value: unknown): CommitFileChange {
  const row = requireRecord(value);
  return {
    filename: requireText(row.filename),
    previousFilename: optionalText(row.previous_filename),
    status: requireOneOf(row.status, FILE_CHANGE_STATUSES),
    additions: requireCount(row.additions),
    deletions: requireCount(row.deletions),
    patch: parsePatch(row.patch),
  };
}

/** Link 머리글에 rel="next" 가 있는가(다음 쪽이 있다). */
function hasNextPage(headers: Headers): boolean {
  return /;\s*rel="?next"?/.test(headers.get("link") ?? "");
}

function parseCommitDetail(json: unknown, headers: Headers): CommitDetail {
  const summary = parseCommitSummary(json);
  const received = requireArray(requireRecord(json).files).map(parseFileChange);
  const files = received.slice(0, COMMIT_FILE_LIMIT);
  return { ...summary, files, hasMoreFiles: received.length > files.length || hasNextPage(headers) };
}

function parsePullRequest(value: unknown): PullRequestSummary {
  const row = requireRecord(value);
  if (typeof row.number !== "number" || !Number.isInteger(row.number) || row.number <= 0) throw new UnexpectedShape();
  return {
    number: row.number,
    title: requireText(row.title),
    body: optionalText(row.body),
    state: requireOneOf(row.state, ["open", "closed"] as const),
    mergedAt: optionalText(row.merged_at),
    htmlUrl: requireGitHubWebUrl(row.html_url),
  };
}

/** 2xx 가 아닌 응답 → 실패 이유(머리 주석의 표). */
function failureForGitHubResponse(response: UpstreamResponse): UpstreamFailure {
  const { status, headers } = response;
  if (status === 429) return upstreamFailure("rate_limited", { status });
  if (status === 403) {
    const limited = headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after");
    return upstreamFailure(limited ? "rate_limited" : "bad_status", { status });
  }
  if (status === 404 || status === 422) return upstreamFailure("not_found", { status });
  return failureForHttpStatus(status);
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const headers: Record<string, string> = { Accept: GITHUB_ACCEPT, "X-GitHub-Api-Version": GITHUB_API_VERSION };
  if (options.token !== null && options.token.length > 0) headers.Authorization = `Bearer ${options.token}`;

  async function get<Value>(path: string, parameters: [string, string | null][], parse: (json: unknown, headers: Headers) => Value): Promise<UpstreamResult<Value>> {
    const response = await getUpstream(upstreamUrl(options.baseUrl, path, parameters), { fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers });
    if (!response.ok) return response;
    if (response.status < 200 || response.status >= 300) return failureForGitHubResponse(response);
    if (!response.parsed) return upstreamFailure("unparseable");
    try {
      return { ok: true, value: parse(response.json, response.headers) };
    } catch (error) {
      if (error instanceof UnexpectedShape) return upstreamFailure("unparseable");
      throw error;
    }
  }

  function repositoryPath(repository: GitHubRepository): string {
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  }

  return {
    async compareCommits(repository, baseSha, headSha) {
      if (!isCommitSha(baseSha) || !isCommitSha(headSha)) return invalidInput("sha");
      return get(`${repositoryPath(repository)}/compare/${baseSha}...${headSha}`, [], parseComparison);
    },
    async getCommit(repository, sha) {
      if (!isCommitSha(sha)) return invalidInput("sha");
      return get(`${repositoryPath(repository)}/commits/${sha}`, [["per_page", String(COMMIT_FILE_LIMIT)]], parseCommitDetail);
    },
    async listPullRequestsForCommit(repository, sha) {
      if (!isCommitSha(sha)) return invalidInput("sha");
      return get(`${repositoryPath(repository)}/commits/${sha}/pulls`, [], (json) => requireArray(json).map(parsePullRequest));
    },
  };
}
