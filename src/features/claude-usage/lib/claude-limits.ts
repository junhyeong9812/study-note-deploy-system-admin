/** Claude 실행 자리의 상한 — 꼴 · 어드민 폼의 해석 · "올림"의 판정(순수 — 설정 · 환경 변수 · Next 를 읽지 않는다).
 *
 * - 용도의 목록은 어드민에 박지 않는다 — **실행 자리의 응답에서** 온다. 이름의 꼴은 CLAUDE_PURPOSE_NAME_PATTERN,
 *   한 응답에 1개 이상 CLAUDE_PURPOSES_MAXIMUM 개 이하 · 중복 없음(isClaudePurposeList). 이 꼴을 벗어난 응답은 해석하지 않는다(unparseable).
 * - 폼의 칸(application/x-www-form-urlencoded — 칸마다 정확히 하나): 닫힌 목록 = 고정 칸 + **서버가 방금 다시 읽은 지금 상한의 용도마다** 두 칸.
 *   enabled = "true" | "false" · total_per_day · total_per_hour · purpose_<용도>_per_day · purpose_<용도>_per_hour(10진 숫자 1~4자리, 0~1000)
 *   · password(선택 — 없거나 빈 글자 허용, 1024자 넘으면 malformed).
 *   지금 상한의 용도가 폼에 빠졌거나(일부만 바꾸지 않는다) 지금 상한에 없는 용도의 칸이 오면 malformed.
 * - 올림: 꺼져 있던 것을 켜면 올림 · 전체 둘과 모든 용도의 하루 · 한 시간 가운데 하나라도 지금보다 크면 올림
 *   (지금 상한에 없는 용도가 next 에 있으면 올림 — 닫힌 쪽). 그 밖(내림 · 끔 · 같은 값)은 올림이 아니다.
 *   지금 값을 읽지 못한 경우는 이 함수에 오지 않는다 — 용도를 모르면 바꾸지 않는다(route 가 503). */
import { LOGIN_PASSWORD_MAX_LENGTH } from "@/features/auth/lib/login-body";

/** 화면의 주소 · 상한을 바꾸는 폼이 보내는 곳(결과 화면이 화면으로 돌아가는 링크도 이 주소). */
export const CLAUDE_USAGE_PATH = "/claude-usage";
export const CLAUDE_LIMITS_ACTION = "/api/claude-usage/limits";

/** 용도 이름의 꼴 — 실행 자리가 준 이름은 이것으로 거른 뒤에만 화면 · 폼의 칸 이름에 싣는다. */
export const CLAUDE_PURPOSE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** 한 응답의 용도 수 상한. */
export const CLAUDE_PURPOSES_MAXIMUM = 8;

/** 알려진 용도의 한국어 이름 — 모르는 이름은 이름 그대로 보인다(claudePurposeTitle). 용도가 생길 때 더하면 되고, 안 더해도 화면은 돈다. */
export const CLAUDE_PURPOSE_LABELS: Readonly<Record<string, string>> = { chat: "채팅" };

/** 실행 자리가 받는 상한의 범위(0~1000의 정수 — runner/server.py MAX_LIMIT). */
export const CLAUDE_LIMIT_MINIMUM = 0;
export const CLAUDE_LIMIT_MAXIMUM = 1000;

export interface ClaudeLimitPair {
  perDay: number;
  perHour: number;
}

/** 바꾸려는 값(폼에서) — 실행 자리 PUT /limits 의 enabled · total · purposes(용도 이름 → 상한, 실행 자리가 준 차례). */
export interface ClaudeLimitsChange {
  enabled: boolean;
  total: ClaudeLimitPair;
  purposes: Record<string, ClaudeLimitPair>;
}

/** 실행 자리의 지금 상한(GET /limits · PUT /limits 의 data) — 바꾼 적이 없으면 changedAt · changedBy 가 null. */
export interface ClaudeLimits extends ClaudeLimitsChange {
  changedAt: string | null;
  changedBy: string | null;
}

/** 화면의 용도 이름 — 알려진 이름이면 "채팅 (chat)", 모르면 이름 그대로("analysis" 가 표에 없으면 "analysis"). */
export function claudePurposeTitle(name: string): string {
  const label = Object.hasOwn(CLAUDE_PURPOSE_LABELS, name) ? CLAUDE_PURPOSE_LABELS[name] : undefined;
  return label === undefined ? name : `${label} (${name})`;
}

/** 폼의 칸 이름 — "total" 이면 total_per_day · total_per_hour, 용도면 purpose_<용도>_per_day · …_per_hour.
 * 단순화: 용도 이름이 "total" 이어도 칸 이름은 purpose_total_* 라 겹치지 않는다 — scope 는 { purpose } 로 가른다. */
export function claudeLimitFieldName(scope: "total" | { purpose: string }, window: "perDay" | "perHour"): string {
  const suffix = window === "perDay" ? "per_day" : "per_hour";
  return scope === "total" ? `total_${suffix}` : `purpose_${scope.purpose}_${suffix}`;
}

/** 용도 이름 목록의 꼴 — 1~8개 · 이름마다 CLAUDE_PURPOSE_NAME_PATTERN · 중복 없음. */
export function isClaudePurposeList(names: readonly string[]): boolean {
  return names.length >= 1 && names.length <= CLAUDE_PURPOSES_MAXIMUM && new Set(names).size === names.length
    && names.every((name) => CLAUDE_PURPOSE_NAME_PATTERN.test(name));
}

export type ClaudeLimitsFormResult =
  /** confirmation: 넓히는 바꿈의 두 번째 걸음의 확인 값(칸이 없으면 빈 글자 · 128자 넘거나 둘이면 malformed) — 명세 §16.
   * 뼈대: 테스트 설계 워커가 칸을 더했다(지금 구현이 채우지 않아 선택으로 둔다 — 구현 워커가 필수로 바꾼다). */
  | { ok: true; change: ClaudeLimitsChange; password: string; confirmation?: string }
  /** 칸이 빠짐(지금 상한의 용도 포함) · 같은 칸이 둘 · 목록 밖의 칸(지금 상한에 없는 용도 포함) · enabled 가 true/false 가 아님 · 비밀번호가 너무 김 */
  | { ok: false; reason: "malformed" }
  /** 수의 칸이 10진 정수가 아님 · 범위(0~1000) 밖 — field 는 그 칸 이름(폼의 칸 이름 그대로) */
  | { ok: false; reason: "invalid_value"; field: string };

/** purposeNames = 서버가 방금 다시 읽은 지금 상한의 용도(그 차례가 change.purposes 의 차례). */
export function parseClaudeLimitsForm(fields: URLSearchParams, purposeNames: readonly string[]): ClaudeLimitsFormResult {
  const scopes: ("total" | { purpose: string })[] = ["total", ...purposeNames.map((purpose) => ({ purpose }))];
  const numberFields = scopes.flatMap((scope) => [claudeLimitFieldName(scope, "perDay"), claudeLimitFieldName(scope, "perHour")]);
  const allowed = new Set(["enabled", "password", ...numberFields]);
  for (const name of fields.keys()) if (!allowed.has(name)) return { ok: false, reason: "malformed" };
  for (const name of allowed) if (fields.getAll(name).length > 1) return { ok: false, reason: "malformed" };
  const enabledText = fields.get("enabled");
  if (enabledText !== "true" && enabledText !== "false") return { ok: false, reason: "malformed" };
  const password = fields.get("password") ?? "";
  if (password.length > LOGIN_PASSWORD_MAX_LENGTH) return { ok: false, reason: "malformed" };
  if (numberFields.some((name) => !fields.has(name))) return { ok: false, reason: "malformed" };
  const pairs: ClaudeLimitPair[] = [];
  for (const scope of scopes) {
    const pair: ClaudeLimitPair = { perDay: 0, perHour: 0 };
    for (const window of ["perDay", "perHour"] as const) {
      const name = claudeLimitFieldName(scope, window);
      const value = limitValue(fields.get(name) ?? "");
      if (value === null) return { ok: false, reason: "invalid_value", field: name };
      pair[window] = value;
    }
    pairs.push(pair);
  }
  const [total, ...purposePairs] = pairs;
  const purposes: Record<string, ClaudeLimitPair> = {};
  purposeNames.forEach((name, index) => { purposes[name] = purposePairs[index]; });
  return { ok: true, change: { enabled: enabledText === "true", total, purposes }, password };
}

/** 10진 숫자 1~4자리이고 범위(0~1000) 안이면 그 수, 아니면 null. */
function limitValue(text: string): number | null {
  if (!/^[0-9]{1,4}$/.test(text)) return null;
  const value = Number(text);
  return value >= CLAUDE_LIMIT_MINIMUM && value <= CLAUDE_LIMIT_MAXIMUM ? value : null;
}

export function isRaisingChange(current: ClaudeLimitsChange, next: ClaudeLimitsChange): boolean {
  if (!current.enabled && next.enabled) return true;
  const raises = (before: ClaudeLimitPair | undefined, after: ClaudeLimitPair) =>
    before === undefined || after.perDay > before.perDay || after.perHour > before.perHour;
  if (raises(current.total, next.total)) return true;
  return Object.entries(next.purposes).some(([name, pair]) => raises(Object.hasOwn(current.purposes, name) ? current.purposes[name] : undefined, pair));
}
