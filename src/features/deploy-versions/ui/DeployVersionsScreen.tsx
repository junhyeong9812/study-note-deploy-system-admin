/** 버전 목록 화면의 본문(서버 컴포넌트) — 뼈대: 시그니처만. 구현 워커가 채운다. */
import type { DeployVersionsView } from "@/features/deploy-versions/server/deploy-versions";

export function DeployVersionsScreen({ view }: { view: DeployVersionsView }): never {
  void view;
  throw new Error("not implemented: DeployVersionsScreen");
}
