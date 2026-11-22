/** 상태 한눈에 화면의 판정과 글자(순수) — 데이터 계층이 준 다섯 칸(StatusOverview)을 요약 · 정렬 · 설명 글자로 옮긴다.
 * 요약의 세 갈래:
 * - 문제: 그 서버에 닿았고, 그 서버가 비정상이라고 답했다(감시 대상 DOWN · 헬스 낱말이 ok 아님(시작 중 제외) · backend 의존성 DOWN · 못 보낸 알림).
 * - 확인 못 함: 그 서버에 닿지 못했거나 답을 해석하지 못했다(칸이 실패 — UpstreamFailure).
 * - 확인 중: 닿았지만 아직 판정 전이다(감시 대상 UNKNOWN · 헬스 starting).
 * 상태 낱말의 뜻은 각 서버의 README · 코드에서 옮겼다(alert README "API" 표 · AlertController.kt health · MonitorTracker.kt,
 * observe README "헬스" 표 · CollectorHealth.kt, backend DependencyHealthController.kt, ci-cd cmd/server/main.go). 받은 값만 쓰고 없는 값을 짓지 않는다. */
import type {
  AlertMonitorView, AlertMonitorsView, BackendDependenciesView, ServiceHealthView, StatusCheckName, StatusOverview,
} from "@/features/status/lib/status-overview";
import { DEPLOY_HISTORY_DEFAULT_LIMIT, DEPLOY_SERVICES } from "@/features/deploys/lib/deploy-history-query";
import { deploysHref } from "@/features/deploys/ui/deploys-address";
import { LOG_QUERY_DEFAULT_LIMIT } from "@/features/logs/lib/log-query";
import { logsHref } from "@/features/logs/ui/logs-address";
import type { UpstreamResult } from "@/shared/lib/upstream-result";

export const STATUS_PATH = "/status";

/** 화면의 칸 순서(감시 대상이 맨 위). */
export const STATUS_CARD_ORDER: readonly StatusCheckName[] = ["alertMonitors", "alertHealth", "observeHealth", "backendDependencies", "deployMasterHealth"];

/** 칸 → 카드 제목과 실패 줄의 출처("<출처>: <가린 이유>"). */
export const STATUS_CARD_LABELS: Readonly<Record<StatusCheckName, { title: string; source: string }>> = {
  alertMonitors: { title: "감시 대상", source: "알림 서버" },
  alertHealth: { title: "알림 서버", source: "알림 서버" },
  observeHealth: { title: "관측 서버", source: "관측 서버" },
  backendDependencies: { title: "backend 의존성", source: "backend" },
  deployMasterHealth: { title: "배포 서버(master)", source: "배포 서버" },
};

/** 화면의 상태 갈래 — 색 + 기호 + 글자로 보인다. */
export type StatusTone = "healthy" | "problem" | "pending" | "unknown" | "caution";

export const TONE_LABELS: Readonly<Record<StatusTone, string>> = {
  healthy: "정상", problem: "문제", pending: "확인 중", unknown: "확인 못 함", caution: "정상(최근 실패)",
};
export const TONE_MARKS: Readonly<Record<StatusTone, string>> = { healthy: "✓", problem: "✕", pending: "…", unknown: "?", caution: "!" };

/** 헬스 낱말의 뜻(한국어 설명) — 판정 갈래와 함께. */
export interface HealthWordDescription { label: string; meaning: string; tone: StatusTone }

/** 알림 서버 GET /health(alert README "API" 표 · AlertController.kt health). */
export const ALERT_HEALTH_WORDS: Readonly<Record<string, HealthWordDescription>> = {
  ok: { label: "정상", meaning: "활성 자리이고 마지막 감시 바퀴가 2분 안에 돌았음", tone: "healthy" },
  starting: { label: "시작 중", meaning: "뜬 지 2분이 안 됐고 아직 첫 감시 바퀴 전", tone: "pending" },
  standby: { label: "대기", meaning: "대기 자리라 감시하지 않음 — 밖에서 계속 이렇게 보이면 아무도 감시하지 않는 상태", tone: "problem" },
  stalled: { label: "멈춤", meaning: "활성인데 2분 넘게 감시 바퀴가 돌지 않음", tone: "problem" },
};

/** 관측 서버 GET /health(observe README "헬스" 표 · CollectorHealth.kt). */
export const OBSERVE_HEALTH_WORDS: Readonly<Record<string, HealthWordDescription>> = {
  ok: { label: "정상", meaning: "마지막으로 성공한 수집 바퀴가 60초 안", tone: "healthy" },
  starting: { label: "시작 중", meaning: "뜬 지 60초 안이고 아직 한 바퀴도 성공하지 못함", tone: "pending" },
  failing: { label: "수집 실패", meaning: "마지막 수집 바퀴가 실패함(저장 실패 · Redis 오류 · 스키마 생성 실패)", tone: "problem" },
  unreachable: { label: "저장소에 닿지 못함", meaning: "관측 서버가 지금 Redis 나 DB 에 닿지 못함", tone: "problem" },
  stalled: { label: "멈춤", meaning: "수집 바퀴가 60초 넘게 끝나지 않음(첫 바퀴 전 포함)", tone: "problem" },
};

/** 배포 서버 GET /health(ci-cd cmd/server/main.go — 성공 봉투면 "ok"로 넘어온다). */
export const DEPLOY_MASTER_HEALTH_WORDS: Readonly<Record<string, HealthWordDescription>> = {
  ok: { label: "정상", meaning: "헬스 경로가 성공으로 답함(이 경로는 살아 있는지만 알린다)", tone: "healthy" },
};

/** backend 의존성 이름 → 설명(DependencyHealthController.kt defaultChecks). 모르는 이름은 설명 없이 이름만. */
export const BACKEND_DEPENDENCY_LABELS: Readonly<Record<string, string>> = {
  elasticsearch: "검색 색인 — 클러스터가 red 면 정상이 아님",
  embedding: "임베딩 서버",
  redis: "Redis — 로그 중앙 큐",
};

/** 감시 대상 상태(MonitorTracker.kt) → 갈래와 설명.
 * UP 인데 사유가 있으면 1~2번 연속 실패한 것이다(3번 연속이면 DOWN — 성공하면 사유가 지워진다). UNKNOWN 은 뜬 뒤 아직 판정 전. */
export function describeMonitor(monitor: AlertMonitorView): { tone: StatusTone; meaning: string } {
  if (monitor.status === "DOWN") return { tone: "problem", meaning: "3번 연속 확인에 실패함" };
  if (monitor.status === "UNKNOWN") {
    return { tone: "pending", meaning: monitor.reason === "" ? "아직 확인 전" : "확인에 실패하고 있으나 아직 3번 연속은 아님" };
  }
  if (monitor.reason !== "") return { tone: "caution", meaning: "최근 확인에 실패함 — 3번 연속이면 문제로 바뀜" };
  return { tone: "healthy", meaning: "마지막 확인 성공" };
}

const MONITOR_ORDER: Readonly<Record<StatusTone, number>> = { problem: 0, pending: 1, caution: 2, unknown: 3, healthy: 4 };

/** 문제인 대상이 위로 — 문제 → 확인 중 → 최근 실패 → 정상. 같은 갈래 안에서는 받은 순서 그대로. */
export function sortMonitors(monitors: readonly AlertMonitorView[]): AlertMonitorView[] {
  return monitors
    .map((monitor, index) => ({ monitor, index, order: MONITOR_ORDER[describeMonitor(monitor).tone] }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map((entry) => entry.monitor);
}

/** 이름이 배포 서비스 허용 목록(DEPLOY_SERVICES)과 똑같을 때만 그 서비스의 로그 · 배포 이력 주소. 아니면 null(대응이 불확실하면 링크를 달지 않는다). */
export function serviceLinksOf(name: string): { logsHref: string; deploysHref: string } | null {
  const service = DEPLOY_SERVICES.find((candidate) => candidate === name);
  if (service === undefined) return null;
  return {
    logsHref: logsHref({ service, level: "error", requestId: null, text: null, from: null, to: null, before: null, limit: LOG_QUERY_DEFAULT_LIMIT }),
    deploysHref: deploysHref({ service, limit: DEPLOY_HISTORY_DEFAULT_LIMIT }),
  };
}

/** 칸 → 그 카드에 이어 보기 링크를 달 서비스 이름(로그의 service 이름이 배포 서비스 이름과 같은 것만). */
export const CARD_SERVICES: Readonly<Partial<Record<StatusCheckName, string>>> = {
  alertHealth: "alert", observeHealth: "observe", backendDependencies: "backend",
};

/** 헬스 칸 하나의 갈래 — 모르는 낱말이면 문제(데이터 계층이 열거를 거르므로 정상 흐름에서는 닿지 않는다). */
export function healthTone(health: ServiceHealthView, words: Readonly<Record<string, HealthWordDescription>>): StatusTone {
  if (health.healthy) return "healthy";
  return words[health.status]?.tone ?? "problem";
}

export interface SummaryItem {
  /** 화면 글자(예: "감시 대상 backend" · "관측 서버(수집 실패)") */
  label: string;
}

export interface StatusSummary {
  problems: SummaryItem[];
  unreachable: SummaryItem[];
  pending: SummaryItem[];
  /** 문제 · 확인 못 함 · 확인 중이 모두 0 */
  allHealthy: boolean;
}

function healthItems(name: StatusCheckName, cell: UpstreamResult<ServiceHealthView>, words: Readonly<Record<string, HealthWordDescription>>,
                     summary: StatusSummary) {
  if (!cell.ok) return;
  const tone = healthTone(cell.value, words);
  const label = `${STATUS_CARD_LABELS[name].title}(${words[cell.value.status]?.label ?? cell.value.status})`;
  if (tone === "problem") summary.problems.push({ label });
  if (tone === "pending") summary.pending.push({ label });
}

function monitorItems(view: AlertMonitorsView, summary: StatusSummary) {
  for (const monitor of view.monitors) {
    const tone = describeMonitor(monitor).tone;
    if (tone === "problem") summary.problems.push({ label: `감시 대상 ${monitor.name}` });
    if (tone === "pending") summary.pending.push({ label: `감시 대상 ${monitor.name}` });
  }
  if (view.undelivered > 0) summary.problems.push({ label: `못 보낸 알림 ${view.undelivered}건` });
}

function dependencyItems(view: BackendDependenciesView, summary: StatusSummary) {
  const down = view.components.filter((component) => component.status === "DOWN");
  for (const component of down) summary.problems.push({ label: `backend 의존성 ${component.name}` });
  if (view.status === "DOWN" && down.length === 0) summary.problems.push({ label: "backend 의존성" });
}

/** 다섯 칸 → 한 줄 요약의 재료. 실패한 칸은 "확인 못 함"(그 칸 안의 값은 없다). */
export function summarizeStatus(overview: StatusOverview): StatusSummary {
  const summary: StatusSummary = { problems: [], unreachable: [], pending: [], allHealthy: false };
  for (const name of STATUS_CARD_ORDER) {
    if (!overview[name].ok) summary.unreachable.push({ label: STATUS_CARD_LABELS[name].title });
  }
  if (overview.alertMonitors.ok) monitorItems(overview.alertMonitors.value, summary);
  healthItems("alertHealth", overview.alertHealth, ALERT_HEALTH_WORDS, summary);
  healthItems("observeHealth", overview.observeHealth, OBSERVE_HEALTH_WORDS, summary);
  if (overview.backendDependencies.ok) dependencyItems(overview.backendDependencies.value, summary);
  healthItems("deployMasterHealth", overview.deployMasterHealth, DEPLOY_MASTER_HEALTH_WORDS, summary);
  summary.allHealthy = summary.problems.length === 0 && summary.unreachable.length === 0 && summary.pending.length === 0;
  return summary;
}
