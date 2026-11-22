/** 자리 헬스 — 인증 없음. 내부 정보(설정 유무 · 버전 · 다른 서버 상태)를 내지 않는다. */
import { jsonResponse } from "@/shared/lib/responses";

export const dynamic = "force-dynamic";

export function GET() {
  return jsonResponse({ status: "ok" });
}
