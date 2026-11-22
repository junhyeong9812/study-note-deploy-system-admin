/** 알림 서버 알림 기록 클라이언트 — `GET <ALERT_URL>/incidents?limit=<n>`, 헤더 `X-Alert-Secret`, 5초 기한, GET 만, redirect:"manual"(순수 — 설정을 읽지 않는다).
 * 계약(alert AlertController.kt:96-106 · incident/IncidentStore.kt:84-87):
 * - limit 은 1~200 으로 잘려 쓰인다(coerceIn) — 이 클라이언트는 1~200 의 정수만 보낸다(밖이면 호출하지 않고 invalid_input, field "limit").
 * - 정렬은 기록 순서의 역순(`ORDER BY id DESC` — 최신 기록부터). at 순서와 같다고 가정하지 않는다.
 * - 응답 `{success:true,data:{incidents:[{at,kind,key,title,detail,delivered_by(""=못 보냄),suppressed}]}}` · at 은 Java Instant 글자(소수 0~9자리, Z).
 * - 오류: 401 unauthorized · 503 history_unavailable(기록 저장소 없음) → unauthorized · unavailable(상태 함께, 원문 없음). 그 밖의 2xx 아님은 failureForHttpStatus.
 * 화면에 넘기는 칸: at · kind · key · title · deliveredBy · suppressed. detail(본문 — 감시 사유 · 내부 주소가 들 수 있다)은 넘기지 않는다.
 * key · title 은 maskUpstreamReason 을 거친 값(주소 꼴 → `(주소)`, 줄바꿈 → 공백, 120자).
 * 한 항목이라도 꼴이 다르면(칸 빠짐 · 형이 다름 · at 이 parseIsoUtc 로 읽히지 않음) 전체 unparseable. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

/** 알림 서버의 상한(AlertController.kt:101 coerceIn(1, 200)). */
export const INCIDENT_LIST_MAXIMUM_LIMIT = 200;

/** 알림 기록 한 줄(화면 꼴). */
export interface IncidentSummary {
  /** 알림 서버가 준 글자 그대로 */
  at: string;
  /** monitor_down · monitor_up · monitor_still_down · event · summary(모르는 낱말도 그대로 — 열거로 거절하지 않는다) */
  kind: string;
  /** 대상 이름 또는 이벤트 key — 가린 값 */
  key: string;
  /** 가린 값 */
  title: string;
  /** delivered_by 가 "" 이면 null(못 보냄) */
  deliveredBy: string | null;
  suppressed: boolean;
}

export interface IncidentClientOptions {
  baseUrl: string;      // 끝의 / 허용
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;   // 기본 AbortSignal.timeout — 5000 으로 부른다
}

export interface IncidentClient {
  /** 알림 서버가 준 순서 그대로(최신 기록부터). */
  listIncidents(limit: number): Promise<UpstreamResult<IncidentSummary[]>>;
}

export function createIncidentClient(options: IncidentClientOptions): IncidentClient {
  void options;
  throw new Error("not implemented");
}
