/** 세부 4 — "임시 제한 중"은 로그인 뒤에도 보인다. 로그인 화면과 홈이 이 함수로 표시 여부를 정한다.
 * 관측 서버에 닿지 않는 동안(마지막 관측 호출이 실패했거나 대기열에 항목이 있는 동안) true. 로그인 서비스가 아직 없으면 false. */
import "server-only";
import { existingLoginService } from "@/features/auth/server/login-service";

export function isTemporaryRestrictionActive(): boolean {
  return existingLoginService()?.flow?.temporaryRestrictionActive() ?? false;
}
