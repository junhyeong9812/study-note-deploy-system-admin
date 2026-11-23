/** GitHub REST API 클라이언트(순수 — 설정 · 비밀값을 읽지 않는다. 토큰은 부르는 쪽이 준다). 명세 §10.2 · §10.3(커밋 목록 · diff 는 master git 조회로 옮겼다 — GitHub 에는 PR 만 남는다).
 * 경로(GET, 5초 기한, 재시도 없음, redirect:"manual" — 3xx 는 bad_status):
 * - 커밋에 연결된 PR: `GET /repos/{owner}/{repo}/commits/{sha}/pulls`.
 * 머리글: `Accept: application/vnd.github+json` · `X-GitHub-Api-Version: 2022-11-28` · 토큰이 있으면(빈 글자 아님) `Authorization: Bearer <토큰>`, 없으면 Authorization 없음.
 * 응답 상태 → 실패 이유:
 * - 403 · 429 이고 `x-ratelimit-remaining: 0` 이거나 `retry-after` 가 있으면 rate_limited(한도 초과 — 1차 · 2차 한도). 429 는 머리글이 없어도 rate_limited.
 *   그 밖의 403 은 bad_status.
 * - 404 · 422 → not_found(없는 커밋 · 저장소). 401 → unauthorized. 그 밖은 failureForHttpStatus(503 unavailable · 504 server_timeout · 그 밖 bad_status).
 * 글자(PR 제목 · 본문)는 받은 그대로 넘긴다(해석 · 변환 · 다듬기 없음). 응답에서 아래 형의 칸만 고른다(원본 통째 전달 금지).
 * html_url 은 `https://github.com/` 로 시작해야 한다 — 아니면 unparseable(화면의 링크가 다른 곳으로 가지 않게).
 * 꼴이 다르면(칸 빠짐 · 형 다름 · 모르는 state) 전체가 unparseable. SHA 인자가 16진수 7~40자가 아니면 부르지 않고 invalid_input(field "sha"). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { isCommitSha } from "@/features/deploy-detail/lib/deploy-detail-query";
import type { GitHubRepository } from "@/features/deploy-detail/lib/github-repository";
import { getUpstream, isRecord, upstreamUrl, type UpstreamResponse } from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, invalidInput, upstreamFailure, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

/** 실제 GitHub API 기준 주소 — 서버 쪽 진입이 쓴다(테스트는 클라이언트에 다른 주소를 준다). */
export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_ACCEPT = "application/vnd.github+json";
/** html_url 이 이 글자로 시작해야 한다. */
export const GITHUB_WEB_ORIGIN_PREFIX = "https://github.com/";

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

  async function get<Value>(path: string, parse: (json: unknown) => Value): Promise<UpstreamResult<Value>> {
    const response = await getUpstream(upstreamUrl(options.baseUrl, path), { fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers });
    if (!response.ok) return response;
    if (response.status < 200 || response.status >= 300) return failureForGitHubResponse(response);
    if (!response.parsed) return upstreamFailure("unparseable");
    try {
      return { ok: true, value: parse(response.json) };
    } catch (error) {
      if (error instanceof UnexpectedShape) return upstreamFailure("unparseable");
      throw error;
    }
  }

  function repositoryPath(repository: GitHubRepository): string {
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  }

  return {
    async listPullRequestsForCommit(repository, sha) {
      if (!isCommitSha(sha)) return invalidInput("sha");
      return get(`${repositoryPath(repository)}/commits/${sha}/pulls`, (json) => requireArray(json).map(parsePullRequest));
    },
  };
}
