/** 버전 목록 화면(/deploys/versions) — 뼈대. 구현 워커가 채운다(진입 함수 loadDeployVersions 만 부른다). */
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export default async function DeployVersionsPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }): Promise<never> {
  void searchParams;
  throw new Error("not implemented: DeployVersionsPage");
}
