/** 열린 문제의 식별자(순수) — 주소(`/incidents?incident=<식별자>`)에 실려 같은 문제를 다시 연다. 다음 조각은 배포 접수의 "누가"
 * `admin:<계정>:incident:<식별자>` 에 싣는다 — 배포 마스터의 requested_by 는 `^[A-Za-z0-9._:-]{1,128}$`(ci-cd feat/version-redeploy master.go:48).
 *
 * 꼴: `<종류 낱말>:<부분>[:<부분>…]` — 종류 낱말은 INCIDENT_ID_PREFIXES(monitor · deploy · resource · errors).
 * - 감시 대상 DOWN: [대상 이름] · 배포 실패: [서비스, 요청 ID] · 자원 임계값: [서버, 규칙[, 대상]] · 오류 로그: [서비스].
 * - 부분이 모두 `[A-Za-z0-9._-]+` 이고 전체가 INCIDENT_ID_MAXIMUM_LENGTH 이하면 그대로 잇는다(사람이 읽을 수 있게).
 * - 아니면(허용 밖 글자 · 빈 부분 · 너무 김) `<종류 낱말>:sha256-<16자>` — 16자 = 종류 낱말과 부분들을 줄바꿈으로 이은 글자(UTF-8)의 SHA-256 앞 16자(소문자 16진수).
 *   같은 입력은 언제나 같은 식별자, 다른 입력은 다른 식별자.
 * 길이 상한 64 — `admin:` + `:incident:` 16자를 더해도 계정 이름이 48자 이하면 128자 안에 든다(계정 길이 확인은 다음 조각의 몫).
 * 식별자는 종류 + 대상이다(같은 대상이 닫혔다 다시 열려도 같은 식별자 — 배포 실패만 요청 ID 로 한 번의 배포를 가린다). */
import { createHash } from "node:crypto";

export const INCIDENT_KINDS = ["monitor_down", "deploy_failed", "resource_threshold", "error_logs"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_ID_PREFIXES: Readonly<Record<IncidentKind, string>> = {
  monitor_down: "monitor", deploy_failed: "deploy", resource_threshold: "resource", error_logs: "errors",
};

export const INCIDENT_ID_MAXIMUM_LENGTH = 64;

/** 식별자의 꼴 — 종류 낱말 + `:` + 허용 글자. 길이는 isIncidentId 가 따로 본다. */
export const INCIDENT_ID_PATTERN = /^(?:monitor|deploy|resource|errors):[A-Za-z0-9._:-]+$/;

/** 그대로 이을 수 있는 부분의 글자(`:` 은 부분의 경계라서 부분 안에 두지 않는다). */
const READABLE_PART_PATTERN = /^[A-Za-z0-9._-]+$/;
const HASHED_LENGTH = 16;

export function incidentId(kind: IncidentKind, parts: readonly string[]): string {
  const prefix = INCIDENT_ID_PREFIXES[kind];
  const readable = `${prefix}:${parts.join(":")}`;
  if (parts.every((part) => READABLE_PART_PATTERN.test(part)) && readable.length <= INCIDENT_ID_MAXIMUM_LENGTH) return readable;
  const digest = createHash("sha256").update([prefix, ...parts].join("\n"), "utf8").digest("hex");
  return `${prefix}:sha256-${digest.slice(0, HASHED_LENGTH)}`;
}

export function monitorIncidentId(monitor: string): string {
  return incidentId("monitor_down", [monitor]);
}

export function deployIncidentId(service: string, requestId: string): string {
  return incidentId("deploy_failed", [service, requestId]);
}

export function resourceIncidentId(server: string, rule: string, target: string | null): string {
  return incidentId("resource_threshold", target === null ? [server, rule] : [server, rule, target]);
}

export function errorLogsIncidentId(service: string): string {
  return incidentId("error_logs", [service]);
}

/** 꼴(INCIDENT_ID_PATTERN)과 길이(INCIDENT_ID_MAXIMUM_LENGTH 이하)가 맞는가. */
export function isIncidentId(value: string): boolean {
  return value.length <= INCIDENT_ID_MAXIMUM_LENGTH && INCIDENT_ID_PATTERN.test(value);
}

/** 식별자의 종류 낱말 → 종류(모르는 낱말이면 null). 꼴 검사는 하지 않는다. */
export function incidentKindOfId(value: string): IncidentKind | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const prefix = value.slice(0, separator);
  return INCIDENT_KINDS.find((kind) => INCIDENT_ID_PREFIXES[kind] === prefix) ?? null;
}
