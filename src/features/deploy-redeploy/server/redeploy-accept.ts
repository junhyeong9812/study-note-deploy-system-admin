/** 재배포 접수의 서버 쪽 진입(POST /api/deploys/redeploy) — 뼈대: 상수와 시그니처만. 구현 워커가 채운다.
 * 순서: 출처 → 세션 → 속도 제한 → 입력의 꼴 → 계정 이름 → 확인 값 → 비밀번호(로그인과 같은 잠금 판정) → 이력 재확인 → master 접수 한 번. */

/** 계정당 60초(미끄러지는 창) 안의 접수 시도 상한 — 세션을 통과한 POST 마다 센다. */
export const REDEPLOY_RATE_LIMIT_PER_MINUTE = 5;
/** 본문(application/x-www-form-urlencoded) 상한. */
export const REDEPLOY_BODY_MAX_BYTES = 4_096;

export async function redeployAcceptResponse(request: Request): Promise<Response> {
  void request;
  throw new Error("not implemented: redeployAcceptResponse");
}
