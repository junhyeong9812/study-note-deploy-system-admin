/** GitHub 응답 캐시(순수 — 시계는 주입). 명세 §10.2 "SHA 로 정해지는 응답(커밋 · 비교)은 메모리에(상한 있음, 재시작하면 비워짐). PR 조회는 10분".
 * - 비교(저장소 + base + head) · 커밋 하나(저장소 + sha): 만료 없음. 항목 수가 maximumEntries 를 넘으면 오래된 것부터 버린다.
 * - PR 목록(저장소 + sha): 저장한 뒤 pullRequestLifetimeMilliseconds 동안만(저장 시각 + 수명 **이전**까지 적중, 그 시각부터 다시 부른다). 같은 상한을 따로 적용한다.
 * - 실패 결과는 저장하지 않는다(다음 요청이 다시 부른다). 빈 PR 목록(PR 없음)은 성공이므로 저장한다.
 * - 열쇠의 SHA 는 받은 글자 그대로 쓴다(대소문자를 맞추지 않는다 — 다르면 다른 항목). */
import type { Clock } from "@/features/auth/lib/types";
import type { GitHubClient, PullRequestSummary } from "@/features/deploy-detail/lib/github-client";
import type { GitHubRepository } from "@/features/deploy-detail/lib/github-repository";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

export const GITHUB_CACHE_MAXIMUM_ENTRIES = 500;
export const PULL_REQUEST_CACHE_MILLISECONDS = 10 * 60 * 1000;

export interface GitHubCacheOptions {
  clock: Clock;
  /** 기본 GITHUB_CACHE_MAXIMUM_ENTRIES */
  maximumEntries?: number;
  /** 기본 PULL_REQUEST_CACHE_MILLISECONDS */
  pullRequestLifetimeMilliseconds?: number;
}

/** client 와 같은 꼴의 캐시 감싸기. */
export function createCachedGitHubClient(client: GitHubClient, options: GitHubCacheOptions): GitHubClient {
  const maximumEntries = options.maximumEntries ?? GITHUB_CACHE_MAXIMUM_ENTRIES;
  const pullRequestLifetime = options.pullRequestLifetimeMilliseconds ?? PULL_REQUEST_CACHE_MILLISECONDS;
  /** 비교 · 커밋 하나 — 만료 없음. Map 은 넣은 순서를 지키므로 첫 항목이 가장 오래된 것이다. */
  const fixedEntries = new Map<string, unknown>();
  /** PR 목록 — 저장 시각과 함께. */
  const pullRequestEntries = new Map<string, { storedAt: number; value: unknown }>();

  function remember<Entry>(entries: Map<string, Entry>, key: string, entry: Entry) {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maximumEntries) {
      const oldestKey = entries.keys().next().value as string;
      entries.delete(oldestKey);
    }
  }

  async function cachedFixed<Value>(key: string, load: () => Promise<UpstreamResult<Value>>): Promise<UpstreamResult<Value>> {
    if (fixedEntries.has(key)) return { ok: true, value: fixedEntries.get(key) as Value };
    const result = await load();
    if (result.ok) remember(fixedEntries, key, result.value);   // 실패는 저장하지 않는다
    return result;
  }

  function repositoryKey(repository: GitHubRepository): string {
    return `${repository.owner}/${repository.name}`;
  }

  return {
    compareCommits(repository, baseSha, headSha) {
      return cachedFixed(`compare:${repositoryKey(repository)}:${baseSha}...${headSha}`, () => client.compareCommits(repository, baseSha, headSha));
    },
    getCommit(repository, sha) {
      return cachedFixed(`commit:${repositoryKey(repository)}:${sha}`, () => client.getCommit(repository, sha));
    },
    async listPullRequestsForCommit(repository, sha) {
      const key = `${repositoryKey(repository)}:${sha}`;
      const stored = pullRequestEntries.get(key);
      if (stored !== undefined && options.clock() < stored.storedAt + pullRequestLifetime) {
        return { ok: true, value: stored.value as PullRequestSummary[] };
      }
      const result = await client.listPullRequestsForCommit(repository, sha);
      if (result.ok) remember(pullRequestEntries, key, { storedAt: options.clock(), value: result.value });
      else pullRequestEntries.delete(key);
      return result;
    },
  };
}
