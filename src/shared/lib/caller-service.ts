/** 호출자 머리글(⑬ T4b · 통신 규약 §2.2) — 어드민(서버 쪽)이 **우리 서비스**(관측 서버 · 알림 서버 · ci-cd 마스터 · backend · llm-wrapper)를 부를 때
 * 자기 이름을 싣는다. 받는 쪽 nginx 가 접속 기록의 "부른 쪽"으로만 쓴다(인증이 아니다 — 앱은 이 머리글을 읽지 않는다).
 * - 값은 코드의 상수 `admin`(소문자) — 설정(`SERVER_NAME` 등)이나 들어온 요청의 `X-Caller-Service` 에서 읽지 않는다. 호출마다 **정확히 하나**.
 * - 바깥(GitHub · Redis · Claude 실행 자리 — 규약의 목록에 없고 앞에 nginx 가 없다)에는 싣지 않는다.
 * - 싣는 자리: 공용 getUpstream(기본으로 싣는다 — 바깥으로 가는 호출만 ourService: false 로 끈다)과 직접 fetch 하는 클라이언트(관측 서버의 로그인 판정 ·
 *   알림 서버의 사건 · 관측 서버의 자원 · 의존 상태 · ci-cd 마스터의 재배포 접수) — 모두 withCallerService 로. 서버 쪽 코드만 가져온다(브라우저 쪽 파일은 가져오지 않는다). */
export const CALLER_SERVICE_HEADER = "X-Caller-Service";
export const ADMIN_CALLER_SERVICE = "admin";

/** 부르는 쪽의 머리글 **뒤에** 호출자 머리글을 싣는다(Headers 의 set — 부르는 쪽이 같은 이름을 줬어도 덮어쓰고, 대소문자만 다른 이름으로 둘이 되지 않는다). */
export function withCallerService(headers: Record<string, string>): Headers {
  const merged = new Headers(headers);
  merged.set(CALLER_SERVICE_HEADER, ADMIN_CALLER_SERVICE);
  return merged;
}
