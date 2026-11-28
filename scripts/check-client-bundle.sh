#!/bin/sh
# 클라이언트 산출물(.next/static — 브라우저로 가는 스크립트·스타일)에 비밀값 이름·테스트용 비밀값이 없는지 검색한다.
# 하나라도 나오면 실패(exit 1). 값은 출력하지 않는다 — 패턴 번호 · 환경 변수 이름 · 파일만.
#
#   sh scripts/check-client-bundle.sh [.next/static]               빌드 때(Dockerfile build 단계): 이름·테스트용 값 검사
#   sh scripts/check-client-bundle.sh --env-values [.next/static]  배포된 컨테이너 안에서: 위 검사 + 실제 환경 변수 값 검사
#       예) docker exec admin-app-blue sh scripts/check-client-bundle.sh --env-values
#
# 추가 검사 값: 환경 변수 CHECK_BUNDLE_EXTRA_VALUES(줄바꿈 구분) — 빌드 때 넣은 가짜 비밀값을 함께 찾는다.
set -eu

CHECK_ENVIRONMENT_VALUES=0
if [ "${1:-}" = "--env-values" ]; then
  CHECK_ENVIRONMENT_VALUES=1
  shift
fi
STATIC_DIRECTORY="${1:-.next/static}"
if [ ! -d "$STATIC_DIRECTORY" ]; then
  echo "check-client-bundle: $STATIC_DIRECTORY 가 없다 — 빌드 뒤에 실행해야 한다" >&2
  exit 1
fi
FILE_COUNT=$(find "$STATIC_DIRECTORY" -type f | wc -l)
if [ "$FILE_COUNT" -eq 0 ]; then
  echo "check-client-bundle: $STATIC_DIRECTORY 에 파일이 없다(빈 검사로 통과하지 않는다)" >&2
  exit 1
fi

# 비밀값·설정의 환경 변수 이름, 비밀값 헤더 이름, 테스트 Fake 의 비밀값·해시
FORBIDDEN_PATTERNS='ADMIN_USER
ADMIN_PASSWORD_HASH
SESSION_SECRET
ADMIN_ORIGIN
OBSERVE_URL
OBSERVE_SECRET
ALERT_URL
ALERT_SECRET
DEPLOY_MASTER_URL
DEPLOY_SECRET
BACKEND_URL
LOG_REDIS_URL
GITHUB_TOKEN
CLAUDE_RUNNER_URL
CLAUDE_RUNNER_SETTINGS_SECRET
CLAUDE_RUNNER_SECRET
X-Observe-Secret
X-Alert-Secret
X-Deploy-Secret
X-Claude-Runner-Settings-Secret
X-Claude-Runner-Secret
$argon2id$
fake-signing-key-for-tests-only
fake-password-xq7
fake-admin-id-zq
fake-observe-secret
fake-alert-secret
fake-github-token-marker
fake-claude-settings-secret-marker
fake-claude-call-secret-marker'

if [ -n "${CHECK_BUNDLE_EXTRA_VALUES:-}" ]; then
  FORBIDDEN_PATTERNS="$FORBIDDEN_PATTERNS
$CHECK_BUNDLE_EXTRA_VALUES"
fi

FOUND=0
PATTERN_FILE=$(mktemp)
trap 'rm -f "$PATTERN_FILE"' EXIT
printf '%s\n' "$FORBIDDEN_PATTERNS" | grep -v '^$' > "$PATTERN_FILE"
while IFS= read -r PATTERN; do
  # 값은 찍지 않고 몇 번째 패턴인지와 파일만 알린다(추가 검사 값이 진짜 비밀일 수 있다)
  MATCHES=$(grep -rlF -- "$PATTERN" "$STATIC_DIRECTORY" || true)
  if [ -n "$MATCHES" ]; then
    LINE_NUMBER=$(grep -nxF -- "$PATTERN" "$PATTERN_FILE" | head -1 | cut -d: -f1)
    echo "check-client-bundle: 금지 패턴 #$LINE_NUMBER 발견:" >&2
    echo "$MATCHES" >&2
    FOUND=1
  fi
done < "$PATTERN_FILE"

# 실제 환경 변수 값 — 값이 있는 키만, 값은 찍지 않는다. 너무 짧은 값은 우연히 겹칠 수 있어 이름만 알리고 건너뛴다.
VALUE_NAMES='ADMIN_USER ADMIN_PASSWORD_HASH SESSION_SECRET OBSERVE_URL OBSERVE_SECRET ALERT_URL ALERT_SECRET DEPLOY_MASTER_URL DEPLOY_SECRET BACKEND_URL LOG_REDIS_URL GITHUB_TOKEN CLAUDE_RUNNER_URL CLAUDE_RUNNER_SETTINGS_SECRET CLAUDE_RUNNER_SECRET'
MINIMUM_VALUE_LENGTH=8
CHECKED_VALUES=0
if [ "$CHECK_ENVIRONMENT_VALUES" -eq 1 ]; then
  for NAME in $VALUE_NAMES; do
    VALUE=$(printenv "$NAME" || true)
    if [ -z "$VALUE" ]; then
      echo "check-client-bundle: $NAME 비어 있음 — 건너뜀"
      continue
    fi
    if [ "${#VALUE}" -lt "$MINIMUM_VALUE_LENGTH" ]; then
      echo "check-client-bundle: $NAME 값이 ${MINIMUM_VALUE_LENGTH}자보다 짧음 — 건너뜀"
      continue
    fi
    MATCHES=$(grep -rlF -- "$VALUE" "$STATIC_DIRECTORY" || true)
    CHECKED_VALUES=$((CHECKED_VALUES + 1))
    if [ -n "$MATCHES" ]; then
      echo "check-client-bundle: 환경 변수 $NAME 의 값 발견:" >&2
      echo "$MATCHES" >&2
      FOUND=1
    fi
  done
fi

if [ "$FOUND" -ne 0 ]; then
  exit 1
fi
if [ "$CHECK_ENVIRONMENT_VALUES" -eq 1 ]; then
  echo "check-client-bundle: ok — 파일 $FILE_COUNT 개, 패턴 $(wc -l < "$PATTERN_FILE") 개 · 환경 변수 값 $CHECKED_VALUES 개 없음"
else
  echo "check-client-bundle: ok — 파일 $FILE_COUNT 개, 패턴 $(wc -l < "$PATTERN_FILE") 개 없음"
fi
