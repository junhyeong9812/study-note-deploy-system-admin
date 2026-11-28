/** 테스트 전용 — 문제 화면 사례의 재료. 화면 꼴(클라이언트가 해석한 뒤)의 값과, 각 서버의 실제 응답 꼴(가짜 fetch 용)을 함께 둔다.
 * 응답 꼴은 실제 소스대로: 알림 서버 AlertController.kt(`/monitors` · `/incidents`) · 배포 마스터 store.go(Deployment JSON) ·
 * 관측 서버 LogController.kt(`/logs`) · MetricController.kt(`/metrics/latest` · `/metrics/containers` · `/metrics/series`). 주소 · 비밀값은 upstream-test-fakes 의 가짜. */
import type { AlertMonitorView, AlertMonitorsView } from "@/features/status/lib/status-overview";
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import type { FiringRule, LatestResources, ServerLatest } from "@/features/resources/lib/resource-metrics-client";
import type { LogEntryView, LogPage } from "@/features/logs/lib/log-query";
import type { IncidentSummary } from "@/features/log-trace/lib/incident-client";
import type { IncidentSources } from "@/features/incidents/lib/incident-list";
import { upstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** 화면의 "지금" — 2026-11-25T06:00:00.000Z */
export const NOW = Date.UTC(2026, 10, 25, 6, 0, 0, 0);

export function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export function ok<Value>(value: Value): UpstreamResult<Value> {
  return { ok: true, value };
}

export const UNREACHABLE = upstreamFailure("unreachable");

// ── 화면 꼴(클라이언트가 해석한 값) ──────────────────────────

export function monitor(overrides: Partial<AlertMonitorView> = {}): AlertMonitorView {
  return { name: "front", status: "UP", downSince: null, reason: "", ...overrides };
}

export function monitors(list: AlertMonitorView[]): AlertMonitorsView {
  return { monitors: list, lastRoundAt: iso(NOW - 10 * SECOND), undelivered: 0 };
}

let deploymentSequence = 0;

export function deployment(overrides: Partial<DeploymentSummary> = {}): DeploymentSummary {
  deploymentSequence += 1;
  return {
    requestId: `req-${String(deploymentSequence).padStart(4, "0")}`, state: "succeeded", service: "front", commitSha: "a".repeat(40), failedStage: null,
    acceptedAt: iso(NOW - 2 * HOUR), finishedAt: iso(NOW - 2 * HOUR + 3 * MINUTE), integrationMilliseconds: 60_000, deliveryMilliseconds: 30_000, ...overrides,
  };
}

export function firing(overrides: Partial<FiringRule> = {}): FiringRule {
  return { server: "s158", rule: "disk_warning", target: null, severity: "warning", since: iso(NOW - 30 * MINUTE), lastValue: 86.2, ...overrides };
}

export function serverLatest(server: string, overrides: Partial<ServerLatest> = {}): ServerLatest {
  return {
    server, measuredAt: iso(NOW - 20 * SECOND), receivedAt: iso(NOW - 19 * SECOND), ageMilliseconds: 19_000, stale: false,
    host: {
      cpuPct: 3.4, load1: 0.1, memTotal: 16_000_000_000, memUsed: 2_000_000_000, diskTotal: 500_000_000_000, diskUsed: 430_000_000_000,
      netRxBps: 0, netTxBps: 0, ioReadBps: 0, ioWriteBps: 0,
    },
    containers: [{ name: "front-app-green", seriesName: "front-app", state: "running", cpuPct: 0.7, memUsed: 119_000_000, restarts: 0 }],
    gpus: [], missing: [], ...overrides,
  };
}

export function latest(servers: ServerLatest[], firingRules: FiringRule[] | null = []): LatestResources {
  return { servers, unreadableServerNameCount: 0, firing: firingRules };
}

let logSequence = 0;

export function logLine(overrides: Partial<LogEntryView> = {}): LogEntryView {
  logSequence += 1;
  const at = overrides.at ?? iso(NOW - MINUTE);
  return { id: `${Date.parse(at)}-${logSequence}`, at, level: "error", service: "front", requestId: "", message: `오류 ${logSequence}`, ...overrides };
}

export function logPage(lines: LogEntryView[], overrides: Partial<LogPage> = {}): LogPage {
  return { logs: lines, nextBefore: null, from: iso(NOW - 10 * MINUTE), to: iso(NOW), ...overrides };
}

export function alertRecord(overrides: Partial<IncidentSummary> = {}): IncidentSummary {
  return { at: iso(NOW - 5 * MINUTE), kind: "monitor_down", key: "front", title: "응답 없음: front", deliveredBy: "mail", suppressed: false, ...overrides };
}

/** 네 출처가 모두 정상이고 열린 문제가 없는 상태. */
export function quietSources(overrides: Partial<IncidentSources> = {}): IncidentSources {
  return {
    monitors: ok(monitors([monitor({ name: "front" }), monitor({ name: "backend" })])),
    latest: ok(latest([serverLatest("s158")], [])),
    deployments: ok([deployment({ service: "front" }), deployment({ service: "backend" })]),
    errorLogs: ok(logPage([])),
    ...overrides,
  };
}

// ── 실제 응답 꼴(가짜 fetch 용) ─────────────────────────────

export function monitorsBody(list: { name: string; status: string; down_since: string; reason: string }[]): Record<string, unknown> {
  return { success: true, data: { monitors: list, last_round_at: iso(NOW - 10 * SECOND), undelivered: 0 } };
}

export function deploymentsBody(list: Record<string, unknown>[]): Record<string, unknown> {
  return { success: true, data: { deployments: list } };
}

export function deploymentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: "req-ok-1", service: "front", commit_sha: "a".repeat(40), state: "succeeded", accepted_at: "2026-11-25T04:00:00Z",
    finished_at: "2026-11-25T04:03:00Z", ci_ms: 60000, cd_ms: 30000, ...overrides,
  };
}

export function logsBody(lines: Record<string, unknown>[], from: string, to: string, nextBefore = ""): Record<string, unknown> {
  return { success: true, data: { logs: lines, next_before: nextBefore, from, to } };
}

export function logRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `${NOW - MINUTE}-0`, at: iso(NOW - MINUTE), level: "error", service: "front", request_id: "", message: "boom", ...overrides };
}

export function alertRecordsBody(list: Record<string, unknown>[]): Record<string, unknown> {
  return { success: true, data: { incidents: list } };
}

export function alertRecordRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { at: iso(NOW - 5 * MINUTE), kind: "monitor_down", key: "front", title: "응답 없음: front", detail: "상세", delivered_by: "mail", suppressed: false, ...overrides };
}

export function latestBody(servers: Record<string, unknown>[], firingRows: Record<string, unknown>[] = []): Record<string, unknown> {
  return { success: true, data: { servers, firing: firingRows } };
}

export function latestServerRow(server: string, containerNames: [name: string, seriesName: string][] = [["front-app-green", "front-app"]]): Record<string, unknown> {
  return {
    server, at: iso(NOW - 20 * SECOND), received_at: iso(NOW - 19 * SECOND), age_ms: 19000, stale: false,
    host: { cpu_pct: 3.4, load1: 0.1, mem_total: 16_000_000_000, mem_used: 2_000_000_000, disk_total: 500_000_000_000, disk_used: 430_000_000_000,
      net_rx_bps: 0, net_tx_bps: 0, io_read_bps: 0, io_write_bps: 0 },
    containers: containerNames.map(([name, seriesName]) => ({ name, series_name: seriesName, cpu_pct: 0.7, mem_used: 119_000_000, restarts: 0, state: "running" })),
    gpus: [], missing: [],
  };
}

export function firingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { server: "s158", rule: "disk_warning", target: null, severity: "warning", since: iso(NOW - 30 * MINUTE), last_value: 86.2, ...overrides };
}

export function seenContainersBody(server: string, atMilliseconds: number, names: string[]): Record<string, unknown> {
  return { success: true, data: { server, from: iso(atMilliseconds - 5 * MINUTE), to: iso(atMilliseconds + 5 * MINUTE),
    containers: names.map((name) => ({ name, last_seen_at: iso(atMilliseconds) })) } };
}

/** 관측 서버의 계열 응답 — 요청의 인자를 되돌려 적는다(점 없음). */
export function emptySeriesBody(parameters: URLSearchParams): Record<string, unknown> {
  return { success: true, data: {
    server: parameters.get("server"), scope: parameters.get("scope"), name: parameters.get("name"),
    from: iso(Date.parse(parameters.get("from")!)), to: iso(Date.parse(parameters.get("to")!)), step_ms: 30000, source: "raw", points: [],
  } };
}

export function commitsBody(shas: string[], relation = "ancestor"): Record<string, unknown> {
  return { success: true, data: {
    commits: shas.map((sha, index) => ({ sha, author_name: "jun", authored_at: iso(NOW - (index + 1) * HOUR), subject: `커밋 ${index}`, body: "", body_truncated: false })),
    truncated: false, range_complete: true, relation,
  } };
}
