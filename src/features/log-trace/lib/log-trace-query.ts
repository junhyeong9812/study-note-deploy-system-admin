/** 연관 로그의 입력 검증(순수) — 관측 서버 · master · 알림 서버를 부르기 **전에** 거절한다(명세 §11.2 · ② 세부 5 "입력의 상한을 넘는 값은 줄여서 받지 않고 거절").
 * 입력 이름: selected(필수 — 고른 로그의 id). 그 밖의 이름은 보지 않는다.
 * 로그 id 는 관측 서버의 스트림 ID 글자 `<밀리초>-<순번>`(observe log/LogEntry.kt:9-19 StreamId — toString `"$millis-$sequence"`,
 * parse `^(\d{1,15})-(\d{1,9})$`)이고, 응답의 `at` 은 그 밀리초의 시각이다(api/LogController.kt:113 `"at" to it.id.at`).
 * 그래서 주소에는 id 하나만 담는다 — 시각은 id 에서 읽고, 그 줄이 실제로 있는지는 관측 서버에서 다시 확인한다(주소의 값을 믿지 않는다).
 * 빈 값 · 없음 · 배열(같은 이름 여러 번) · 형식 밖은 invalid_input(field "selected"). */
import type { SearchParamsInput, UpstreamFailure } from "@/shared/lib/upstream-result";

/** 관측 서버의 스트림 ID 와 같은 꼴(LogEntry.kt:15). */
export const LOG_ID_PATTERN = /^\d{1,15}-\d{1,9}$/;

/** 순번 자리의 최댓값(9자리) — 이 값의 다음 커서는 다음 밀리초의 0 번이다. */
export const LOG_ID_MAXIMUM_SEQUENCE = 999_999_999;

export interface LogTraceQuery {
  /** 고른 로그의 id(받은 글자 그대로) */
  selectedLogId: string;
  /** id 앞부분의 밀리초(epoch) — 모든 시간 창의 기준 */
  selectedAtMilliseconds: number;
}

export function parseLogTraceQuery(input: SearchParamsInput): { ok: true; query: LogTraceQuery } | UpstreamFailure {
  void input;
  throw new Error("not implemented");
}

/** 관측 서버 `before`(엄격히 작은 쪽 — LogStore.kt:83 `(stream_ms, stream_seq) < (?, ?)`)에 넘길 "이 id 바로 다음" 커서.
 * 순번 < 999999999 → `<밀리초>-<순번+1>`, 순번 = 999999999 → `<밀리초+1>-0`. 형식 밖의 id 는 받지 않는다(부르는 쪽이 먼저 검증). */
export function cursorJustAfter(logId: string): string {
  void logId;
  throw new Error("not implemented");
}
