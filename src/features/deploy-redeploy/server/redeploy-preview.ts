/** 재배포 확인 화면의 서버 쪽 진입 — 뼈대: 타입과 시그니처만. 구현 워커가 채운다(세션 → 입력 → 설정 → master 호출, 전부 GET). */
import type { RedeployPreview } from "@/features/deploy-redeploy/lib/redeploy-preview";
import type { RedeployPreviewQuery } from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import type { DeployService } from "@/features/deploys/lib/deploy-history-query";
import type { SearchParamsInput, UpstreamResult } from "@/shared/lib/upstream-result";

export interface RedeployPreviewView {
  /** 입력이 틀렸으면 null(그때 preview 는 invalid_input, master 를 부르지 않는다) */
  query: RedeployPreviewQuery | null;
  /** 돌아갈 버전 목록의 서비스 — 입력의 service 가 허용 목록 안의 글자 하나면 그것(commit 이 틀려도), 아니면 null */
  service: DeployService | null;
  preview: UpstreamResult<RedeployPreview>;
}

/** 화면용 — 세션이 없으면 /login. */
export async function loadRedeployPreview(searchParams: SearchParamsInput): Promise<RedeployPreviewView> {
  void searchParams;
  throw new Error("not implemented: loadRedeployPreview");
}

/** 데이터 경로용 — 세션이 없으면 401, 입력이 틀리면 422, 그 밖은 200 `{success:true,data:RedeployPreviewView}`(no-store). */
export async function redeployPreviewResponse(request: Request): Promise<Response> {
  void request;
  throw new Error("not implemented: redeployPreviewResponse");
}
