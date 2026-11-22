# study-note-deploy-system-admin

운영자 한 명이 배포 이력 · 로그 · 서비스 상태 · 로그인 시도 기록을 읽기 전용으로 보는 어드민 화면(Next.js 15 App Router).
어드민 백엔드는 따로 두지 않는다 — 이 앱의 서버 쪽 코드가 master · 관측 · 알림 · backend 서버를 직접 부른다.
지금 있는 것: 로그인(`/login`) · 로그인 뒤 홈(`/`, 메뉴 자리) · `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/health`.

## 구성

- `src/middleware.ts` — 공통 진입. **기본 거절**: `classifyPath`(`src/features/auth/lib/auth-boundary.ts`)가 public 이라고 한 경로(`/login` · `/api/auth/login` · `/api/health` · `/favicon.ico` · `/_next/static/…`)만 세션 없이 통과. 나머지는 서명한 세션 쿠키가 없으면 화면은 `/login` 으로(307), `/api/…` 는 401. 런타임은 Node.js(`config.runtime = "nodejs"`, Next 15.5 stable) — 세션 검증이 `node:crypto` HMAC 을 쓴다. argon2 · ioredis 는 임포트하지 않는다.
- `src/features/auth/server/require-session.ts` — 두 번째 겹. 보호 화면은 `requireSession()`(없으면 `/login`), 데이터 경로는 `requireApiSession()`(없으면 401)을 **직접** 호출한다. 새 화면·경로·다른 서버를 부르는 서버 쪽 함수도 반드시 호출한다.
- `src/features/auth/lib/` — 세션(HMAC-SHA256, 12시간, 연장 없음) · 자격(argon2id, ID 가 틀려도 더미 해시로 같은 검증) · Origin(설정값과 글자까지 같음) · 속도 제한(IP 마다 60초 10회, 자리별 메모리) · 관측 서버 판정 · 임시 제한(관측 서버 장애 시 3회 → 15분) · 대기열(상한 500, 복귀 뒤 `replayed:true`) · 잠금 알림.
- `src/features/auth/server/login-service.ts` — 속도 제한 · 임시 제한 · 대기열을 프로세스 안에 하나만 둔다(`globalThis`).
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

  - `deploy/active/` 는 서버에만 있고 git 에 없다. `edge-allow.conf` 가 없으면 nginx 가 뜨지 않는다(닫힌 쪽으로 실패).
  - 배포·전환·수동 조작은 ci-cd 저장소 README 의 "무중단 배포" 절을 따른다. 자리 포트: blue `127.0.0.1:18001`, green `127.0.0.1:18002`.
- 비밀번호 해시 만들기(한 줄 — 평문이 셸 기록에 남지 않게 읽어서 넣는다. 기본값 m=19456,t=2,p=1 이 더미 해시와 같아 검증 시간이 비슷하다):

  ```sh
  docker run --rm -it admin-app:local node -e 'const r=require("readline").createInterface({input:process.stdin,output:process.stderr});r.question("password: ",p=>{r.close();require("@node-rs/argon2").hash(p,{algorithm:2}).then(h=>console.log(h))})'
  ```

- 세션 서명 키: `openssl rand -hex 32`.

## 환경 변수

`.env.example` 에 키 이름과 설명. 로그인에 필요한 키(`ADMIN_USER` · `ADMIN_PASSWORD_HASH`(argon2id) · `SESSION_SECRET`(32자 이상) · `ADMIN_ORIGIN` · `OBSERVE_URL` · `OBSERVE_SECRET`) 중 하나라도 비면 앱은 뜨고(헬스 ok) 로그인은 전부 거절하며, 시작 로그에 비어 있는 키 **이름**만 한 줄 남긴다. `ALERT_URL`·`ALERT_SECRET` 이 비면 잠금 알림이 실패하고 앱 로그에 한 줄 남는다. `DEPLOY_MASTER_URL` · `DEPLOY_SECRET` · `BACKEND_URL` 은 다음 task(화면 넷)용 자리다.

## 보안 경계 요약

- 비밀값(`X-Observe-Secret` · `X-Alert-Secret` · `X-Deploy-Secret` · 세션 서명 키 · 비밀번호 해시)은 서버 프로세스의 환경 변수에만 있다. 다른 서버 호출은 전부 서버 쪽 코드에서 한다.
- 세션: `admin_session` 쿠키(`HttpOnly; Secure; SameSite=Strict; Path=/`, 12시간). 쿠키만으로 판정하므로 로그아웃 전에 복사된 쿠키는 만료까지 유효하다(수용 — 전체 무효화 = `SESSION_SECRET` 교체). `Secure` 이므로 브라우저는 https(엣지)로만 쿠키를 보낸다.
- 로그인 · 로그아웃은 `Origin` 이 `ADMIN_ORIGIN` 과 글자까지 같을 때만 받는다. Server Action 은 쓰지 않는다.
- 잠금은 관측 서버가 판정한다(연속 5회 → 15분). 관측 서버에 닿지 않으면 자리 메모리의 임시 제한(3회 → 15분)으로 판정하고 화면에 "임시 제한 중"을 표시한다. 잠금이 시작되면(임시 제한 포함) 알림 서버에 이벤트 1건.
- 클라이언트 IP: nginx 가 **엣지 IP 와 사설 대역에서 온 연결만** 받고(나머지는 응답 없이 닫음), 앱에 넘기는 `X-Real-IP` 를 다시 쓴다 — 엣지에서 온 연결이면 엣지가 넣은 값, 아니면 실제 접속 주소. 앱은 `X-Real-IP` 하나만 읽고(`X-Forwarded-For` 는 보지 않는다), 없으면 `unknown` 한 통으로 센다.
- 보호 화면·데이터 응답은 요청마다 렌더링하고 `Cache-Control: no-store`.
