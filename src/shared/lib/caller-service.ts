/** 호출자 머리글(⑬ T4b · 통신 규약 §2.2) — 어드민(서버 쪽)이 **우리 서비스**(관측 서버 · 알림 서버 · ci-cd 마스터 · backend · llm-wrapper)를 부를 때
 * 자기 이름을 싣는다. 받는 쪽 nginx 가 접속 기록의 "부른 쪽"으로만 쓴다(인증이 아니다 — 앱은 이 머리글을 읽지 않는다).
 * - 값은 코드의 상수 `admin`(소문자) — 설정(`SERVER_NAME` 등)이나 들어온 요청의 `X-Caller-Service` 에서 읽지 않는다. 호출마다 **정확히 하나**.
 * - 바깥(GitHub · Redis · Claude 실행 자리 — 규약의 목록에 없고 앞에 nginx 가 없다)에는 싣지 않는다.
 * 뼈대: 테스트 설계 워커가 상수만 고정했다. 싣는 자리는 구현 워커가 정한다(공용 getUpstream 과 직접 fetch 하는 클라이언트 — 전수 표). */
export const CALLER_SERVICE_HEADER = "X-Caller-Service";
export const ADMIN_CALLER_SERVICE = "admin";
