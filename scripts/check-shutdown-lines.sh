#!/bin/sh
# 멈출 때의 로그 줄이 실제 런타임에서 나오는지 확인한다(빌드한 standalone 서버 — 테스트는 처리기를 흉내 낼 뿐이다).
# 가짜 설정으로 `node server.js` 를 감싸지 않고 직접 띄운다(npx · 셸을 거치면 신호가 node 에 닿지 않는다) → Ready 뒤 1초 →
# 서명한 쿠키로 분석 화면을 한 번 열어 분석 서비스를 만든다 → 그 node 의 PID 에 SIGTERM → 15초 안에 끝나기를 기다린다 →
# `login:shutdown` 과 `incident-analysis:shutdown running=` 이 정확히 한 번씩이고 끝난 코드가 0 이면 PASS(exit 0), 아니면 FAIL(exit 1).
#
#   npm run build && sh scripts/check-shutdown-lines.sh [.next/standalone]
#
# 다른 서버는 부르지 않는다 — 주소는 모두 닿지 않는 127.0.0.1:9(설정은 이 스크립트가 그 자리에서 만든 가짜 값뿐이다). 띄운 node 는 끝날 때 반드시 끈다.
set -u

STANDALONE_DIRECTORY=${1:-.next/standalone}
if [ ! -f "$STANDALONE_DIRECTORY/server.js" ]; then
  echo "check-shutdown-lines: $STANDALONE_DIRECTORY/server.js 가 없다 — 먼저 npm run build" >&2
  exit 1
fi
STANDALONE_DIRECTORY=$(cd "$STANDALONE_DIRECTORY" && pwd)
NODE=${NODE:-node}
WORK_DIRECTORY=$(mktemp -d)
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then kill -KILL "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$WORK_DIRECTORY"
}
trap cleanup EXIT

# 가짜 설정 — 해시는 standalone 에 든 argon2 로(시작 검사가 읽을 수 있는지 본다), 키는 무작위
cd "$STANDALONE_DIRECTORY" || exit 1
PASSWORD_HASH=$("$NODE" -e "require('@node-rs/argon2').hash(require('crypto').randomBytes(16).toString('hex'),{memoryCost:19456,timeCost:2,parallelism:1}).then((hash)=>process.stdout.write(hash))") || exit 1
SESSION_KEY=$("$NODE" -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
PORT=$("$NODE" -e "const server=require('net').createServer();server.listen(0,'127.0.0.1',()=>{process.stdout.write(String(server.address().port));server.close();})")
UNREACHABLE=http://127.0.0.1:9

LOG_FILE="$WORK_DIRECTORY/server.log"
PORT=$PORT HOSTNAME=127.0.0.1 ADMIN_USER=shutdowncheck ADMIN_PASSWORD_HASH=$PASSWORD_HASH SESSION_SECRET=$SESSION_KEY ADMIN_ORIGIN=https://admin.check.invalid \
  OBSERVE_URL=$UNREACHABLE OBSERVE_SECRET=fake-observe-check ALERT_URL=$UNREACHABLE ALERT_SECRET=fake-alert-check \
  DEPLOY_MASTER_URL=$UNREACHABLE DEPLOY_SECRET=fake-deploy-check BACKEND_URL=$UNREACHABLE \
  LOG_REDIS_URL=redis://127.0.0.1:9 CLAUDE_RUNNER_URL=$UNREACHABLE CLAUDE_RUNNER_SECRET=fake-call-check \
  "$NODE" server.js > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Ready 를 기다린다(30초)
WAITED=0
until grep -q "Ready" "$LOG_FILE" 2>/dev/null; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "check-shutdown-lines: FAIL — 서버가 뜨지 않았다" >&2; cat "$LOG_FILE" >&2; exit 1; fi
  if [ "$WAITED" -ge 300 ]; then echo "check-shutdown-lines: FAIL — 30초 안에 Ready 가 없다" >&2; exit 1; fi
  sleep 0.1
  WAITED=$((WAITED + 1))
done
sleep 1

# 서명한 쿠키로 분석 화면을 한 번 — 분석 서비스를 만든다(분석은 시작하지 않는다)
SESSION_TOKEN=$("$NODE" -e "const payload='v1.'+Date.now();process.stdout.write(payload+'.'+require('crypto').createHmac('sha256',process.argv[1]).update(payload).digest('base64url'))" "$SESSION_KEY")
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Cookie: admin_session=$SESSION_TOKEN" "http://127.0.0.1:$PORT/incidents/analysis?incident=monitor%3Afront")
echo "check-shutdown-lines: 분석 화면 HTTP $STATUS(서버 PID $SERVER_PID)"

kill -TERM "$SERVER_PID"
WAITED=0
while kill -0 "$SERVER_PID" 2>/dev/null; do
  if [ "$WAITED" -ge 150 ]; then echo "check-shutdown-lines: FAIL — SIGTERM 뒤 15초 안에 끝나지 않았다" >&2; exit 1; fi
  sleep 0.1
  WAITED=$((WAITED + 1))
done
wait "$SERVER_PID"
EXIT_CODE=$?
SERVER_PID=""

LOGIN_LINES=$(grep -c "login:shutdown" "$LOG_FILE")
ANALYSIS_LINES=$(grep -c "incident-analysis:shutdown running=" "$LOG_FILE")
grep -E "login:shutdown|incident-analysis:shutdown" "$LOG_FILE"
echo "check-shutdown-lines: login:shutdown ${LOGIN_LINES}줄 · incident-analysis:shutdown ${ANALYSIS_LINES}줄 · 끝난 코드 $EXIT_CODE"
if [ "$STATUS" = "200" ] && [ "$LOGIN_LINES" -eq 1 ] && [ "$ANALYSIS_LINES" -eq 1 ] && [ "$EXIT_CODE" -eq 0 ]; then
  echo "check-shutdown-lines: PASS"
  exit 0
fi
echo "check-shutdown-lines: FAIL" >&2
exit 1
