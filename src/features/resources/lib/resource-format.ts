/** 서버 자원 화면의 값 글자(순수). 값이 없으면(null · NaN · ±Infinity) 언제나 RESOURCE_NO_VALUE_TEXT — 0 으로 보이지 않게.
 * - 바이트: 1024 단위. 1024 미만은 정수 `"512 B"`, 그 위는 소수 한 자리와 KiB · MiB · GiB · TiB(가장 큰 단위가 1 이상이 되는 것, TiB 가 끝)
 *   — `"1.0 KiB"` · `"1.5 MiB"` · `"14.9 GiB"`. 반올림한 값이 1024.0 이 되면 다음 단위로(`"1.0 MiB"` — `"1024.0 KiB"` 가 아니다).
 * - 초당 바이트: 바이트 글자 + `"/s"`(`"1.2 KiB/s"`).
 * - 퍼센트: 소수 한 자리 + `"%"`(`"3.4%"` · `"0.0%"` · `"100.0%"`). 100 을 넘어도 그대로(컨테이너 CPU 는 코어 하나 = 100 — `"250.0%"`).
 * - 온도: 반올림한 정수 + `"°C"`.
 * - 지난 시간: 1분 미만 `"1분 안"`, 1시간 미만 `"N분 전"`(내림), 1일 미만 `"N시간 전"`(내림), 그 위 `"N일 전"`(내림). 음수는 0 으로 본다.
 * 모든 소수 반올림은 Math.round(x × 10) / 10 과 같은 결과다(toFixed 의 이진 오차에 기대지 않는다). */

export const RESOURCE_NO_VALUE_TEXT = "없음";

export function formatBytes(value: number | null): string {
  void value;
  throw new Error("not implemented");
}

export function formatBytesPerSecond(value: number | null): string {
  void value;
  throw new Error("not implemented");
}

export function formatPercent(value: number | null): string {
  void value;
  throw new Error("not implemented");
}

export function formatCelsius(value: number | null): string {
  void value;
  throw new Error("not implemented");
}

export function formatAge(milliseconds: number | null): string {
  void milliseconds;
  throw new Error("not implemented");
}
