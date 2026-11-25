/** 재배포 확인 화면(/deploys/redeploy) — 뼈대. 구현 워커가 채운다(진입 함수 loadRedeployPreview 만 부른다). */
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export default async function RedeployPreviewPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }): Promise<never> {
  void searchParams;
  throw new Error("not implemented: RedeployPreviewPage");
}
