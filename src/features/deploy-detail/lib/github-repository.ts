/** 서비스 이름 → GitHub 저장소(코드에 고정한 허용 목록 — 명세 §10.2 "입력값으로 저장소를 고를 수 없다"). 순수.
 * ci-cd 는 배포 대상이 아니므로 표에 없다. */
import type { DeployService } from "@/features/deploys/lib/deploy-history-query";

export const GITHUB_REPOSITORY_OWNER = "junhyeong9812";

export const GITHUB_REPOSITORY_NAMES: Readonly<Record<DeployService, string>> = {
  front: "study-note-deploy-system-front",
  backend: "study-note-deploy-system-backend",
  llm: "study-note-deploy-system-llm",
  alert: "study-note-deploy-system-alert",
  observe: "study-note-deploy-system-observe",
  admin: "study-note-deploy-system-admin",
  claude: "study-note-deploy-system-claude",
};

export interface GitHubRepository {
  owner: string;
  name: string;
}

/** 표에 있는 서비스면 그 저장소, 아니면 null(대소문자 · 공백 · 프로토타입 이름(`constructor` 등)도 null). */
export function githubRepositoryFor(service: string): GitHubRepository | null {
  if (!Object.hasOwn(GITHUB_REPOSITORY_NAMES, service)) return null;
  return { owner: GITHUB_REPOSITORY_OWNER, name: GITHUB_REPOSITORY_NAMES[service as DeployService] };
}

/** 공개 저장소의 웹 주소(화면의 "GitHub 에서 보기" 링크 — API 를 부르지 않는다). 순수.
 * - 비교: `https://github.com/{owner}/{name}/compare/{base}...{head}`
 * - 커밋 하나: `https://github.com/{owner}/{name}/commit/{sha}`
 * SHA 는 받은 글자 그대로 넣는다(부르는 쪽이 16진수로 검사한 값만 준다). */
export function githubCompareUrl(repository: GitHubRepository, baseSha: string, headSha: string): string {
  return `https://github.com/${repository.owner}/${repository.name}/compare/${baseSha}...${headSha}`;
}

export function githubCommitUrl(repository: GitHubRepository, sha: string): string {
  return `https://github.com/${repository.owner}/${repository.name}/commit/${sha}`;
}
