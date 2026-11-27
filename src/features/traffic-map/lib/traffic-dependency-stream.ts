/** 의존의 선 — 브라우저 쪽 상태(순수 — 브라우저 조각이 쓴다: 서버 모듈 · 설정 · 클라이언트 · fetch 없음). 통신 지도의 상태(traffic-map-stream-state)와 따로 접는다.
 * - dependencies: 깨진 사건(JSON 아님 · 칸 빠짐 · 형이 다름 · 닫힌 표 밖의 짝 · 모르는 상태 · 까닭)은 버리고 brokenEvents 를 센다(앞의 값 그대로) ·
 *   sequence 가 마지막 것보다 작거나 같으면 버린다 · 받아들이면 shown 을 간다. 모르는 칸은 버린다(사건에 `detail` 이 실려 와도 상태에 남지 않는다).
 * - open: lastSequence 를 비운다(다시 붙으면 전체를 새로 받는다).
 * - 낡음(isDependencyStale): shown 이 있고, 연결이 끊김 · 다시 붙음(새 값 전) · 세션 끝이거나 지금 - checkedAt 이 DEPENDENCY_STALE_MILLISECONDS 를 넘으면. */
import {
  DEPENDENCY_SOURCES, DEPENDENCY_STALE_MILLISECONDS, type DependencyLine, type DependencyState, type DependencyUnknownReason,
} from "@/features/traffic-map/lib/dependency-lines";
import type { TrafficDependencyEvent } from "@/features/traffic-map/lib/traffic-dependency-hub";
import type { TrafficStreamConnection } from "@/features/traffic-map/lib/traffic-map-stream-state";
import { parseIsoUtc } from "@/shared/lib/query-input";

export interface TrafficDependencyStreamState {
  shown: TrafficDependencyEvent | null;
  lastSequence: number | null;
  brokenEvents: number;
}

export type TrafficDependencyStreamAction = { type: "open" } | { type: "dependencies"; data: string };

export function initialTrafficDependencyStreamState(initial: TrafficDependencyEvent | null): TrafficDependencyStreamState {
  return { shown: initial, lastSequence: initial?.sequence ?? null, brokenEvents: 0 };
}

const STATES: readonly DependencyState[] = ["up", "down", "unknown"];
const REASONS: readonly DependencyUnknownReason[] = ["not_configured", "unreachable", "timeout", "unparseable", "not_reported"];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** 선 하나 — 닫힌 표의 짝 · 아는 상태 · 까닭(unknown 일 때만 낱말, 그 밖은 null)만. 아는 칸만으로 다시 만든다. */
function parseLine(value: unknown): DependencyLine | null {
  if (!isRecord(value)) return null;
  const { service, dependency, state, tookMs, reason } = value;
  const source = DEPENDENCY_SOURCES.find((each) => each.service === service);
  if (source === undefined || !(source.dependencies as readonly unknown[]).includes(dependency)) return null;
  if (typeof state !== "string" || !(STATES as readonly string[]).includes(state)) return null;
  if (tookMs !== null && !isCount(tookMs)) return null;
  if (state === "unknown" ? typeof reason !== "string" || !(REASONS as readonly string[]).includes(reason) : reason !== null) return null;
  return {
    service: source.service, dependency: dependency as DependencyLine["dependency"], state: state as DependencyState, tookMs,
    reason: reason as DependencyUnknownReason | null,
  };
}

/** 사건의 data — 꼴이 틀리면 null. */
export function parseTrafficDependencyEvent(data: string): TrafficDependencyEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(event) || !isCount(event.sequence) || typeof event.checkedAt !== "string" || parseIsoUtc(event.checkedAt) === null) return null;
  if (!Array.isArray(event.lines)) return null;
  const lines: DependencyLine[] = [];
  for (const row of event.lines) {
    const line = parseLine(row);
    if (line === null) return null;
    lines.push(line);
  }
  return { sequence: event.sequence, checkedAt: event.checkedAt, lines };
}

export function reduceTrafficDependencyStream(state: TrafficDependencyStreamState, action: TrafficDependencyStreamAction): TrafficDependencyStreamState {
  if (action.type === "open") return { ...state, lastSequence: null };
  const event = parseTrafficDependencyEvent(action.data);
  if (event === null) return { ...state, brokenEvents: state.brokenEvents + 1 };
  if (state.lastSequence !== null && event.sequence <= state.lastSequence) return state;
  return { ...state, shown: event, lastSequence: event.sequence };
}

export function isDependencyStale(state: TrafficDependencyStreamState, connection: TrafficStreamConnection, nowMilliseconds: number): boolean {
  if (state.shown === null) return false;
  if (connection === "reconnecting" || connection === "reopened" || connection === "session_ended") return true;
  const checkedAt = parseIsoUtc(state.shown.checkedAt);
  return checkedAt !== null && nowMilliseconds - checkedAt > DEPENDENCY_STALE_MILLISECONDS;
}
