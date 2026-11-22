/** GitHub 응답 캐시(순수 — 시계는 주입). 명세 §10.2 "SHA 로 정해지는 응답(커밋 · 비교)은 메모리에(상한 있음, 재시작하면 비워짐). PR 조회는 10분".
 * - 비교(저장소 + base + head) · 커밋 하나(저장소 + sha): 만료 없음. 항목 수가 maximumEntries 를 넘으면 오래된 것부터 버린다.
 * - PR 목록(저장소 + sha): 저장한 뒤 pullRequestLifetimeMilliseconds 동안만(저장 시각 + 수명 **이전**까지 적중, 그 시각부터 다시 부른다). 같은 상한을 따로 적용한다.
 * - 실패 결과는 저장하지 않는다(다음 요청이 다시 부른다). 빈 PR 목록(PR 없음)은 성공이므로 저장한다.
 * - 열쇠의 SHA 는 받은 글자 그대로 쓴다(대소문자를 맞추지 않는다 — 다르면 다른 항목). */
import type { Clock } from "@/features/auth/lib/types";
import type { GitHubClient } from "@/features/deploy-detail/lib/github-client";

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
  throw new Error("not implemented");
}
