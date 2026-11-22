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
