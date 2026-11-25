/** 테스트 전용 — 요청 추적 사례의 줄. 가짜 관측 서버(`GET /logs` 의 실제 규칙 흉내)는 연관 로그의 것을 그대로 쓴다(log-trace-test-fakes). */
import { fakeLogLine, javaInstantText, logIdOf, type FakeLogLine } from "@/features/log-trace/lib/log-trace-test-fakes";
import type { LogEntryView, LogLevel } from "@/features/logs/lib/log-query";

/** 채팅 한 건의 기준 시각(밀리초 0 — 시각 글자에 소수가 없다). */
export const TRACE_START_MILLISECONDS = Date.UTC(2026, 10, 22, 10, 0, 0, 0);
export const TRACE_REQUEST_ID = "req-0123456789ab";

/** front → backend → llm → backend → front 를 거친 요청(시작에서 몇 ms · 순번 · 서비스 · 수준 · 글).
 * 이웃한 줄 사이: 120 · 80 · 100 · 2400(backend → llm) · 0(llm 의 같은 밀리초 두 줄) · 800(llm → backend) · 100(backend → front). 전체 3600ms. */
export const CHAT_SCENARIO: readonly [number, number, string, LogLevel, string][] = [
  [0, 0, "front", "info", "POST /api/chat 받음"],
  [120, 0, "backend", "info", "chat 시작"],
  [200, 0, "backend", "warning", "검색 느림"],
  [300, 0, "backend", "warning", "문맥 잘림"],
  [2700, 0, "llm", "info", "chat queued position=1"],
  [2700, 1, "llm", "info", "chat ok tokens~120"],
  [3500, 0, "backend", "error", "응답 변환 실패"],
  [3600, 0, "front", "warning", "응답 500 전달"],
];

export function chatScenarioLines(requestId = TRACE_REQUEST_ID, start = TRACE_START_MILLISECONDS): FakeLogLine[] {
  return CHAT_SCENARIO.map(([offset, sequence, service, level, message]) =>
    fakeLogLine({ milliseconds: start + offset, sequence, service, level, requestId, message }));
}

/** 어드민 화면 꼴의 한 줄(LogEntryView) — 관측 서버가 준 시각 글자(Java Instant)와 같은 글자. */
export function entryOf(line: FakeLogLine): LogEntryView {
  return {
    id: logIdOf(line), at: javaInstantText(line.milliseconds), level: line.level as LogLevel, service: line.service,
    requestId: line.requestId, message: line.message,
  };
}
