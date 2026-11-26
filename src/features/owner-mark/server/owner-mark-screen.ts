/** 주인 표시 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 설정(OWNER_COOKIE_SECRET · OWNER_COOKIE_DOMAIN · ADMIN_ORIGIN)과
 * 요청에 실려 온 쿠키 `study_owner` 를 읽는다(next/headers cookies().getAll("study_owner")). 다른 서버를 부르지 않는다.
 * - loadOwnerMarkScreen(): 세션이 없으면 /login. 설정의 판정(checkOwnerMarkSettings) + 이 브라우저의 판정(verifyOwnerMark — 서버의 시계).
 * - ownerMarkScreenResponse(request): GET /api/owner-mark — 세션이 없으면 401, 그 밖은 200 `{success:true,data:OwnerMarkScreen}`(no-store).
 * - 열쇠는 OWNER_COOKIE_SECRET 의 글자 **그대로**(다듬지 않는다 — server-config 의 다른 키처럼 trim 하지 않는다). 도메인은 앞뒤 공백을 다듬어도 된다.
 * - 화면 데이터에 쿠키의 값 · 서명 · 열쇠가 없다(판정의 낱말과 시각만).
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 몸은 구현 워커가 채운다. */
import "server-only";
import type { OwnerMarkSettings, OwnerMarkVerdict } from "@/features/owner-mark/lib/owner-mark";

export interface OwnerMarkScreen {
  settings: OwnerMarkSettings;
  verdict: OwnerMarkVerdict;
}

export async function loadOwnerMarkScreen(): Promise<OwnerMarkScreen> {
  throw new Error("not implemented: loadOwnerMarkScreen");
}

export async function ownerMarkScreenResponse(_request: Request): Promise<Response> {
  throw new Error("not implemented: ownerMarkScreenResponse");
}
