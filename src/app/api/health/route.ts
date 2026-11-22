/** 자리 헬스 — 인증 없음. 필수 설정(로그인 + 화면 넷 · 알림)이 유효할 때만 200(형식 · 해시 해석 포함, 해석 결과는 기억해 요청마다 argon2 를 돌리지 않는다)(세부 3 — 시작 검사가 건너뛰어져도 자리 헬스 확인에서 걸린다).
 * 내부 정보(설정 키 이름 · 값 · 버전 · 다른 서버 상태)를 내지 않는다. */
import { missingRequiredConfigKeys } from "@/shared/config/login-config-check";
import { readServerConfig } from "@/shared/config/server-config";
import { jsonResponse } from "@/shared/lib/responses";

export const dynamic = "force-dynamic";

export function GET() {
  if (missingRequiredConfigKeys(readServerConfig()).length > 0) return jsonResponse({ status: "unavailable" }, 503);
  return jsonResponse({ status: "ok" });
}
