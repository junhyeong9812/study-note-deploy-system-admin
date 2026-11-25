# study-note-deploy-system-admin

운영자 한 명이 배포 이력 · 로그 · 서비스 상태 · 로그인 시도 기록을 읽기 전용으로 보는 어드민 화면(Next.js 15 App Router).
어드민 백엔드는 따로 두지 않는다 — 이 앱의 서버 쪽 코드가 master · 관측 · 알림 · backend 서버를 직접 부른다.
지금 있는 것: 로그인(`/login`) · 로그인 뒤 홈(`/`, 화면 넷의 메뉴) · 화면 넷(`/deploys` · `/logs` · `/status` · `/login-attempts`) · `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/health` · 화면 넷과 두 상세의 데이터 경로(아래 "구성").

## 구성

- `src/middleware.ts` — 공통 진입. 세션 없는 화면 요청은 `ADMIN_ORIGIN` 기준의 `/login` 으로 307(Next 15.5 middleware 는 상대 Location 을 받지 못한다 — 내부 호스트 이름 대신 설정값을 쓰고, nginx 의 `proxy_redirect` + `absolute_redirect off` 가 바깥으로는 `Location: /login` 으로 바꾼다). **기본 거절**: `classifyPath`(`src/features/auth/lib/auth-boundary.ts`)가 public 이라고 한 경로(`/login` · `/api/auth/login` · `/api/health` · `/favicon.ico` · `/_next/static/…`)만 세션 없이 통과. 나머지는 서명한 세션 쿠키가 없으면 화면은 `/login` 으로(307), `/api/…` 는 401. 런타임은 Node.js(`config.runtime = "nodejs"`, Next 15.5 stable) — 세션 검증이 `node:crypto` HMAC 을 쓴다. argon2 · ioredis 는 임포트하지 않는다.
- `src/features/auth/server/require-session.ts` — 두 번째 겹. 보호 화면은 `requireSession()`(없으면 `/login`), 데이터 경로는 `requireApiSession()`(없으면 401)을 **직접** 호출한다. 새 화면·경로·다른 서버를 부르는 서버 쪽 함수도 반드시 호출한다.
- `src/features/auth/lib/` — 세션(HMAC-SHA256, 12시간, 연장 없음) · 자격(argon2id, ID 가 틀려도 더미 해시로 같은 검증) · Origin(설정값과 글자까지 같음) · 속도 제한(IP 마다 60초 10회, 자리별 메모리) · 관측 서버 판정 · 임시 제한(관측 서버 장애 시 3회 → 15분) · 대기열(상한 500, 복귀 뒤 `replayed:true`) · 잠금 알림.
- `src/features/auth/server/login-service.ts` — 속도 제한 · 임시 제한 · 대기열을 프로세스 안에 하나만 둔다(`globalThis`).
- 화면 넷과 두 상세(배포 상세 · 연관 로그)의 데이터 계층 `src/features/{deploys,logs,status,login-attempts,deploy-detail,log-trace}/` — `lib/`(순수: 입력 검증 · 다른 서버 클라이언트 · 응답에서 화면에 필요한 칸만 고르기, 설정·Next 를 읽지 않는다) + `server/`(진입 함수 — `requireSession()`/`requireApiSession()` 을 **직접** 부른 뒤에만 설정을 읽고 다른 서버를 부른다) + `ui/`(서버 컴포넌트 — 받은 값만 그린다. server · `*-client` · 설정을 값으로 임포트하지 않는다). `src/app` 의 화면 · `GET /api/{deploys,logs,status,login-attempts}` · `GET /api/deploys/detail` · `GET /api/logs/trace` 는 진입 함수만 부른다(화면 넷의 기능 폴더는 소스 검사 `src/app/screen-data-imports.test.ts`).
  - 다른 서버 호출: 전부 GET · `redirect: "manual"` · 본문까지 5초 기한. 실패는 고정된 짧은 사유(`src/shared/lib/upstream-result.ts`)와 상태 코드만 — 오류 본문 원문 · 주소 · 예외 문구는 넘기지 않는다. 정상 응답 안의 사유 글자(감시 대상의 DOWN 사유 · backend 의존성 detail · 관측 서버 헬스의 failure)는 주소를 `(주소)` 로 가리고 120자로 자른다(`maskUpstreamReason`). 입력이 틀리면 데이터 경로는 422 `invalid_input`(다른 서버를 부르지 않는다), 다른 서버가 실패해도 200 에 그 칸의 실패로 보인다. 상태 화면의 다섯 호출은 병렬.
  - 화면 넷: 배포 이력(`/deploys` — 줄을 누르면 오른쪽에 배포 상세(`deploy-detail`, `GET /api/deploys/detail`): 요약 · 직전 성공 배포→이번 배포의 커밋 목록 · PR · 커밋별 바뀐 파일과 diff. 커밋 목록 · diff 는 배포 master 의 git 조회(`GET /deploys/git/commits` · `GET /deploys/git/commit` — 배포 이력과 같은 `DEPLOY_MASTER_URL` · `DEPLOY_SECRET`)에서, PR 제목 · 본문만 GitHub 에서 읽는다. 선택은 주소의 `selected` · `selectedService` · `commit`) · 로그 조회(`/logs` — 줄을 누르면 오른쪽에 연관 로그(`log-trace`, `GET /api/logs/trace`): 고른 로그 · 이 요청 요약 · 같은 요청 ID 의 연관 로그 · 그때 서버 상태(수준별 건수 · 배포 · 알림). 선택은 주소의 `selected`) · 상태 한눈에(`/status`) · 로그인 시도 기록(`/login-attempts`). 공통 틀 `src/features/admin-shell/ui/AdminShell.tsx`(내비게이션 · 로그아웃 · "임시 제한 중").
- `src/shared/config/server-config.ts` — 환경 변수를 읽는 유일한 곳(`server-only`).
- `src/shared/lib/logger.ts` — `requestId:admin:message` 한 줄, stdout + Redis 스트림 `logs`(실패 무해). IP · 입력 ID · 비밀번호 · User-Agent 는 넘기지 않는다.

## 임포트 정책

**절대경로(`@/...`)만 사용한다** — 같은 폴더 안이라도 상대 임포트 금지(front 와 같은 정책).

## 실행

- 테스트: `npm test` · 빌드: `npm run build && sh scripts/check-client-bundle.sh`(브라우저로 가는 `.next/static` 에 비밀값 이름·테스트용 비밀값이 없는지 검색 — Docker build 단계에서도 돈다).
- 무중단 배포 구성(앱은 두 자리 `admin-blue`·`admin-green` 중 하나만 뜨고 nginx 가 18000 을 받는다). `.env` 작성(`.env.example` 참고) 후:

  ```sh
  mkdir -p deploy/active
  cp deploy/nginx/nginx.conf deploy/active/nginx.conf
  cp deploy/nginx/upstream-blue.conf deploy/active/upstream.conf
  cp deploy/nginx/edge-allow.conf.example deploy/active/edge-allow.conf   # 주소를 실제 엣지 IP 로 바꾼다
  docker compose up -d --build admin-blue nginx
  curl -sD- -o /dev/null http://<BIND_ADDR>:18000/api/health | grep -i x-deploy-slot
  ```

  - nginx: 로그인 경로(`location = /api/auth/login`)는 본문을 모으지 않고 앱으로 흘려보낸다(`proxy_request_buffering off`). 그래서 앱의 4KB 상한과 **전체 3초 기한**이 nginx 를 거쳐도 실제로 걸린다(넘으면 400 `malformed` 로 기록되고 속도 제한에도 든다). nginx 는 8KB 상한(넘으면 413 — 앱에 닿지 않는 유일한 경우)과 `client_body_timeout 10s`(두 번의 읽기 사이 간격 — 전체 기한이 아니다)만 맡는다.
  - nginx 가 서버에서 여는 포트는 `.env` 의 `PUBLIC_PORT`(비면 18000)다 — 바꾸면 `docker compose up -d nginx` 로 nginx 를 다시 만들고, ci-cd agent 의 `DEPLOY_HEALTH_ADMIN` 도 같은 포트로 맞춘다. 자리 포트(18001·18002)와 컨테이너 안쪽 포트(18000)는 그대로다.
  - `deploy/active/` 는 서버에만 있고 git 에 없다. `edge-allow.conf` 가 없으면 nginx 가 뜨지 않는다(닫힌 쪽으로 실패).
  - 접속 기록(nginx — 루트 프로젝트 `docs/cross-cutting/plans/2026-11-25/traffic-map/communication-protocol.md` 3절): 요청마다 표준 출력에 JSON 한 줄(14칸, `service` 는 `admin` — 응답 없이 닫는 444 도 한 줄). 접속 주소 · 쿼리 문자열 · 리퍼러 · User-Agent · 쿠키 · 인증 머리글은 싣지 않고, 경로는 첫 `?` 앞 1024자까지다(접속 IP 는 접속 기록에는 남지 않는다 — 오류 기록 · 관측 서버의 로그인 시도 기록에는 남는다). 오류 기록은 표준 오류(주소가 든다 — 수집하지 않는다). 도커 로그는 10MB × 3 으로 묶는다.
  - 요청 ID(`X-Request-Id`): 사설 대역 · 루프백에서 온 꼴(`^[A-Za-z0-9_-]{1,64}$`) 맞는 값만 믿고(엣지에서 온 값은 아직 믿지 않는다), 아니면 nginx 가 새로 만들어 앱에 넘기고 응답 머리글로 돌려준다. 호출자(`X-Caller-Service`)는 엣지 연결이면 `edge`, 사설 대역의 아는 이름이면 그대로, 나머지는 `outside` 로 덮어써 넘긴다 — 지도 표시용이지 인증이 아니다.
  - 배포: 이 변경을 병합 · 배포한 뒤 서버에서 한 번 `docker compose up -d nginx` 로 nginx 컨테이너를 다시 만든다 — (가) 로그 크기 제한(10MB × 3)이 그때 걸린다(설정 복사 · reload 로는 걸리지 않는다) (나) 이전 형식으로 쌓인 접속 기록(방문자 주소 · 쿼리가 든 줄)이 컨테이너의 로그와 함께 지워진다 (다) reload 뒤 옛 워커가 끝날 때까지(`worker_shutdown_timeout` — 최대 180초) 옛 형식의 줄을 쓰는 구간이 없어진다.
  - 배포·전환·수동 조작은 ci-cd 저장소 README 의 "무중단 배포" 절을 따른다. 자리 포트: blue `127.0.0.1:18001`, green `127.0.0.1:18002`.
- 비밀번호 해시 만들기(한 줄 — 평문이 셸 기록에 남지 않게 읽어서 넣는다). **비용은 `m=19456,t=2,p=1` 로 고정**이다 — 설정 해시가 `$argon2id$v=19$m=19456,t=2,p=1$` 로 시작하지 않으면 더미 해시와 검증 시간이 달라지므로 설정 없음과 같다(서버가 뜨지 않는다 — 아래 "환경 변수"). 아래 명령은 그 매개변수를 명시한다:

  ```sh
  docker run --rm -it admin-app:local node -e 'const r=require("readline").createInterface({input:process.stdin,output:process.stderr});r.question("password: ",p=>{r.close();require("@node-rs/argon2").hash(p,{algorithm:2,memoryCost:19456,timeCost:2,parallelism:1}).then(h=>console.log(h))})'
  ```

- 세션 서명 키: `openssl rand -hex 32`.

- 배포된 컨테이너에서의 **값 검사**(빌드 때는 비밀값이 없어 이름만 검사한다): 컨테이너 안의 실제 환경 변수 값으로 브라우저로 가는 묶음을 검색한다. 값은 출력하지 않고 이름·파일만 알린다(8자보다 짧은 값은 이름만 알리고 건너뛴다). 하나라도 나오면 exit 1.

  ```sh
  docker exec admin-app-blue sh scripts/check-client-bundle.sh --env-values   # 활성 자리 이름으로
  ```

## 환경 변수

`.env.example` 에 키 이름과 설명.

- **필수**(하나라도 없거나 형식이 틀리면 **서버가 뜨지 않는다 — 종료 코드 78**): `ADMIN_USER` · `ADMIN_PASSWORD_HASH`(argon2id, 비용 `m=19456,t=2,p=1`, 검증 라이브러리가 실제로 읽을 수 있어야 함 — 시작 때 argon2 검증 1회로 확인, 약 50~70ms, 결과는 기억) · `SESSION_SECRET`(32자 이상) · `ADMIN_ORIGIN`(https 이고 출처 꼴 그대로 — `new URL(값).origin === 값`, 끝의 `/`·경로·scheme 없음은 틀림) · `OBSERVE_URL`(해석되는 http(s) 주소, 끝의 `/` 허용) · `OBSERVE_SECRET` · 화면 넷 · 잠금 알림이 부르는 서버의 `DEPLOY_MASTER_URL` · `BACKEND_URL` · `ALERT_URL`(셋 다 해석되는 http(s) 주소, 끝의 `/` 허용) · `DEPLOY_SECRET` · `ALERT_SECRET`(비지 않은 값). 서버가 뜰 때(`instrumentation.register()`) 검사해 빠진 키 **이름**만 1줄(`startup:admin:설정 없음 — 서버를 끝낸다 keys=…`) 남기고 종료 코드 78 로 끝낸다(값은 찍지 않는다). 빌드(`next build`)는 설정 없이 된다 — 검사는 서버가 실제로 뜰 때만.
  - 실측: 요청을 하나도 받기 전에 끝난다(컨테이너 안에서 시작 직후부터 헬스를 두드려도 응답 0건). `restart: unless-stopped` 아래에서는 재시작이 되풀이된다(12초에 5회).
  - 배포에서의 뜻: 새 자리가 뜨지 않으므로 compose healthcheck 는 healthy 가 되지 않고, ci-cd agent 의 자리 헬스 확인(`127.0.0.1:18001`/`18002`)이 실패해 그 배포는 `cd_health` 실패로 끝난다 — nginx 는 전환되지 않고 이전 자리가 계속 서비스한다.
  - 헬스(`GET /api/health`)도 필수 설정이 유효할 때만 200, 아니면 503(본문에 키 이름·값 없음) — 시작 검사가 건너뛰어져도 자리 헬스 확인에서 걸린다.
- **선택**: `LOG_REDIS_URL`(비면 stdout 만) — 비어 있으면 시작 로그에 이름만 1줄. `GITHUB_TOKEN`(배포 상세가 GitHub REST API 로 PR 제목 · 본문을 읽을 때 싣는 토큰 — 커밋 목록 · diff 는 GitHub 가 아니라 master 에서 읽는다) — 비면 토큰 없이 부른다(GitHub 익명 한도 IP 당 시간당 60회, 토큰이 있으면 5000회 — 한도를 넘으면 상세의 PR 구역만 "GitHub: 한도 초과"). 권한은 **공개 저장소 읽기 전용**만 준다(fine-grained token 의 "Public repositories (read-only)", 그 밖의 권한 없음). 값은 서버 쪽에만 있고 로그 · 응답 · 오류 문구에 나오지 않는다.

## 보안 경계 요약

- 비밀값(`X-Observe-Secret` · `X-Alert-Secret` · `X-Deploy-Secret` · 세션 서명 키 · 비밀번호 해시)은 서버 프로세스의 환경 변수에만 있다. 다른 서버 호출은 전부 서버 쪽 코드에서 한다.
- 세션: `admin_session` 쿠키(`HttpOnly; Secure; SameSite=Strict; Path=/`, 12시간). 쿠키만으로 판정하므로 로그아웃 전에 복사된 쿠키는 만료까지 유효하다(수용 — 전체 무효화 = `SESSION_SECRET` 교체). `Secure` 이므로 브라우저는 https(엣지)로만 쿠키를 보낸다.
- 로그인 · 로그아웃은 `Origin` 이 `ADMIN_ORIGIN` 과 글자까지 같을 때만 받는다. Server Action 은 쓰지 않는다.
- 잠금은 관측 서버가 판정한다(연속 5회 → 15분). 관측 서버에 닿지 않으면 자리 메모리의 임시 제한(3회 → 15분)으로 판정하고 화면에 "임시 제한 중"을 표시한다. 잠금이 시작되면(임시 제한 포함) 알림 서버에 이벤트 1건.
- 클라이언트 IP: nginx 가 **엣지 IP 와 사설 대역에서 온 연결만** 받고(나머지는 응답 없이 닫음), 앱에 넘기는 `X-Real-IP` 를 다시 쓴다 — 엣지에서 온 연결이면 엣지가 넣은 값, 아니면 실제 접속 주소. 앱은 `X-Real-IP` 하나만 읽고(`X-Forwarded-For` 는 보지 않는다), 없으면 `unknown` 한 통으로 센다.
- 보호 화면·데이터 응답은 요청마다 렌더링하고 `Cache-Control: no-store`.
- 판정 순서: Origin 검사 → 속도 제한 → 본문 읽기 → 자격 검증. 본문은 앞의 두 검사를 통과한 뒤에만 읽고, 읽으면서 상한 4KB·기한 3초를 적용한다(넘으면 400 `malformed`). 형식이 틀린 본문도 속도 제한에 센다(Origin 거절은 세지 않는다).
- 관측 판정은 첫 호출과 재시도를 합쳐 기한 5초 하나다 — 연결 실패·2xx 아님·해석 불가만 같은 `attempt_id` 로 남은 시간 안에서 1회 재시도하고, 시간 초과는 재시도하지 않는다. 기한이 지나면 임시 제한으로 판정한다(관측 서버가 느려도 로그인은 약 5초에 끝난다).
- 속도 제한 표(IP 상한 10,000): 창 안의 IP 는 지우지 않는다. 표가 활성 항목으로 가득 차면 새 IP 는 429(관측 서버에 기록하지 않고 건수만 앱 로그), 창이 지난 항목은 정리한다.
- 대기열의 주기 재전송: 대기열이 비어 있지 않은 동안 30초마다 스스로 재전송한다(관측 서버가 돌아오면 다음 로그인을 기다리지 않는다). 재전송은 한 번에 하나만 돌고(로그인 뒤 실행과 겹치지 않는다), 도는 중에 들어온 항목도 같은 실행 또는 다음 시도에서 보낸다. 관측 호출의 5초 기한을 따르고, 타이머는 프로세스 종료를 막지 않는다(`unref`). 비면 멈춘다.
- 집계 로그: 관측 서버에 보내지 않는 거절(창 안의 반복 Origin 거절 · 형식 오류 · 속도 제한, 그리고 표 포화 `saturated`)은 요청마다 로그를 남기지 않고 이유별 60초에 1줄(`login:unrecorded_rejections reason=<이유> count=<n>`)로 남긴다. 창이 끝날 때와 종료(SIGTERM) 때 남은 건수를 내보낸다. 0 건이면 줄이 없다.
- "임시 제한 중" 표시: 마지막 관측 호출이 실패했거나 대기열에 항목이 있는 동안 로그인 화면과 로그인 뒤의 모든 화면(공통 틀)에 표시한다.
- 시도 기록: 자격 검증에 이른 요청은 `/auth/attempts`, 그 전에 거절한 요청은 `/auth/attempts/rejected`(`reason` = `rate_limited` · `origin_rejected` · `malformed`). 거절 기록은 IP 마다 고정 60초 창에 이유별 첫 1건만 보내고(꾸준히 두드려도 1건) 나머지는 건수만 앱 로그에 남긴다. 403·400·429 응답은 기록 전송을 기다리지 않는다 — 전송은 뒤에서 끝까지 하고 실패하면 대기열에 넣는다. 관측 서버 장애 중의 기록은 대기열에 두었다가 복귀 뒤 `replayed:true` + 임시 제한이 실제로 내린 `outcome` 으로 보낸다. 재전송 응답이 잠금 시작이면 그때 알림을 보낸다. 재전송에 관측 서버가 **422**(본문 자체가 틀림)를 준 항목만 버리고 `discarded=<건수> status=422` 를 앱 로그에 남긴다 — 401·429·5xx·연결 실패·시간 초과는 남겨 다음에 다시 보낸다. 관측 서버가 허용한 성공은 임시 제한의 메모리 횟수도 0 으로 만든다. 알림은 로그인 응답을 최대 2초만 기다린다.
- 종료 로그: 대기열에 넣을 때마다 `queued=<건수>`, SIGTERM 을 받으면 `login:shutdown queued=<대기 건수> dropped=<누적 유실 건수>` 1줄. 종료 자체는 Next 서버의 SIGTERM 처리(연결 정리 뒤 종료)가 한다. 강제 종료(SIGKILL) 때는 마지막 `queued=` 줄이 근사값이다.
