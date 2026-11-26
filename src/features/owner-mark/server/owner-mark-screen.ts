/** 주인 표시 화면의 서버 쪽 진입 — 세션 검증을 직접 부른 뒤에만 설정(OWNER_COOKIE_SECRET · OWNER_COOKIE_DOMAIN · ADMIN_ORIGIN)과
 * 요청에 실려 온 쿠키 `study_owner` 를 읽는다(next/headers cookies().getAll("study_owner")). 다른 서버를 부르지 않는다.
 * - loadOwnerMarkScreen(): 세션이 없으면 /login. 설정의 판정(checkOwnerMarkSettings) + 이 브라우저의 판정(verifyOwnerMark — 서버의 시계).
 * - ownerMarkScreenResponse(request): GET /api/owner-mark — 세션이 없으면 401, 그 밖은 200 `{success:true,data:OwnerMarkScreen}`(no-store).
 * - 열쇠는 OWNER_COOKIE_SECRET 의 글자 **그대로**(다듬지 않는다 — server-config 의 ownerCookieSecret). 도메인은 앞뒤 공백을 다듬는다.
 * - 화면 데이터에 쿠키의 값 · 서명 · 열쇠가 없다(판정의 낱말과 시각만). */
import "server-only";
import { cookies } from "next/headers";
import { requireApiSession, requireSession } from "@/features/auth/server/require-session";
import {
  OWNER_COOKIE_NAME, checkOwnerMarkSettings, verifyOwnerMark, type OwnerMarkSettings, type OwnerMarkVerdict,
} from "@/features/owner-mark/lib/owner-mark";
import { readServerConfig } from "@/shared/config/server-config";
import { screenDataResponse } from "@/shared/lib/screen-responses";

export interface OwnerMarkScreen {
  settings: OwnerMarkSettings;
  verdict: OwnerMarkVerdict;
}

/** 세션 검증을 마친 뒤에만 부른다. */
async function buildOwnerMarkScreen(): Promise<OwnerMarkScreen> {
  const config = readServerConfig();
  const cookieValues = (await cookies()).getAll(OWNER_COOKIE_NAME).map((cookie) => cookie.value);
  return {
    settings: checkOwnerMarkSettings({ secret: config.ownerCookieSecret, domain: config.ownerCookieDomain, adminOrigin: config.adminOrigin }),
    verdict: verifyOwnerMark(cookieValues, config.ownerCookieSecret, Date.now()),
  };
}

export async function loadOwnerMarkScreen(): Promise<OwnerMarkScreen> {
  await requireSession();
  return buildOwnerMarkScreen();
}

export async function ownerMarkScreenResponse(_request: Request): Promise<Response> {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  return screenDataResponse(await buildOwnerMarkScreen(), null);
}
