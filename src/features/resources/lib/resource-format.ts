/** 서버 자원 화면의 값 글자(순수). 값이 없으면(null · NaN · ±Infinity) 언제나 RESOURCE_NO_VALUE_TEXT — 0 으로 보이지 않게.
 * - 바이트: 1024 단위. 1024 미만은 정수 `"512 B"`, 그 위는 소수 한 자리와 KiB · MiB · GiB · TiB(가장 큰 단위가 1 이상이 되는 것, TiB 가 끝)
 *   — `"1.0 KiB"` · `"1.5 MiB"` · `"14.9 GiB"`. 반올림한 값이 1024.0 이 되면 다음 단위로(`"1.0 MiB"` — `"1024.0 KiB"` 가 아니다).
 * - 초당 바이트: 바이트 글자 + `"/s"`(`"1.2 KiB/s"`).
 * - 퍼센트: 소수 한 자리 + `"%"`(`"3.4%"` · `"0.0%"` · `"100.0%"`). 100 을 넘어도 그대로(컨테이너 CPU 는 코어 하나 = 100 — `"250.0%"`).
 * - 온도: 반올림한 정수 + `"°C"`.
 * - 지난 시간: 1분 미만 `"1분 안"`, 1시간 미만 `"N분 전"`(내림), 1일 미만 `"N시간 전"`(내림), 그 위 `"N일 전"`(내림). 음수는 0 으로 본다.
 * 모든 소수 반올림은 Math.round(x × 10) / 10 과 같은 결과다(toFixed 의 이진 오차에 기대지 않는다). */

export const RESOURCE_NO_VALUE_TEXT = "없음";

const BYTE_UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;

function hasValue(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/** Math.round(x × 10) / 10 의 소수 한 자리 글자(toFixed 는 반올림이 끝난 값을 적기만 한다). */
function oneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

export function formatBytes(value: number | null): string {
  if (!hasValue(value)) return RESOURCE_NO_VALUE_TEXT;
  if (Math.round(value) < 1024) return `${Math.round(value)} B`;
  let scaled = value / 1024;
  let unitIndex = 0;
  // 반올림한 값이 1024.0 이 되면 다음 단위로(TiB 가 끝)
  while (unitIndex < BYTE_UNITS.length - 1 && Math.round(scaled * 10) / 10 >= 1024) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${oneDecimal(scaled)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatBytesPerSecond(value: number | null): string {
  return hasValue(value) ? `${formatBytes(value)}/s` : RESOURCE_NO_VALUE_TEXT;
}

export function formatPercent(value: number | null): string {
  return hasValue(value) ? `${oneDecimal(value)}%` : RESOURCE_NO_VALUE_TEXT;
}

export function formatCelsius(value: number | null): string {
  return hasValue(value) ? `${Math.round(value)}°C` : RESOURCE_NO_VALUE_TEXT;
}

const MINUTE_MILLISECONDS = 60_000;
const HOUR_MILLISECONDS = 60 * MINUTE_MILLISECONDS;
const DAY_MILLISECONDS = 24 * HOUR_MILLISECONDS;

export function formatAge(milliseconds: number | null): string {
  if (!hasValue(milliseconds)) return RESOURCE_NO_VALUE_TEXT;
  const age = Math.max(0, milliseconds);
  if (age < MINUTE_MILLISECONDS) return "1분 안";
  if (age < HOUR_MILLISECONDS) return `${Math.floor(age / MINUTE_MILLISECONDS)}분 전`;
  if (age < DAY_MILLISECONDS) return `${Math.floor(age / HOUR_MILLISECONDS)}시간 전`;
  return `${Math.floor(age / DAY_MILLISECONDS)}일 전`;
}
