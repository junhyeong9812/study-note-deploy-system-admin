/** 재배포 확인 화면의 본문(서버 컴포넌트) — 뼈대: 시그니처만. 구현 워커가 채운다. */
import type { RedeployPreviewView } from "@/features/deploy-redeploy/server/redeploy-preview";

export function RedeployPreviewScreen({ view }: { view: RedeployPreviewView }): never {
  void view;
  throw new Error("not implemented: RedeployPreviewScreen");
}
