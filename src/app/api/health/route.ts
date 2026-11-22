/** 자리 헬스 — 인증 없음. 로그인 필수 설정이 유효할 때만 200(세부 3 — 시작 검사가 건너뛰어져도 자리 헬스 확인에서 걸린다).
 * 내부 정보(설정 키 이름 · 값 · 버전 · 다른 서버 상태)를 내지 않는다. */
import { missingLoginConfigKeys, readServerConfig } from "@/shared/config/server-config";
import { jsonResponse } from "@/shared/lib/responses";

export const dynamic = "force-dynamic";

export function GET() {
  if (missingLoginConfigKeys(readServerConfig()).length > 0) return jsonResponse({ status: "unavailable" }, 503);
  return jsonResponse({ status: "ok" });
}
