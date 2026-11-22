/** 배포 이력 화면의 표시 글자(순수) — 시각은 KST 로, 걸린 시간은 사람이 읽는 단위로, 상태 · 실패 단계는 한국어 이름으로.
 * ICU 의 시간대 자료에 기대지 않는다(KST 는 서머타임이 없어 UTC+9 고정). */
import type { DeployState } from "@/features/deploys/lib/deploy-history-client";

const KST_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000;

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** ISO-8601 → `YYYY-MM-DD HH:MM:SS`(KST). 읽을 수 없으면 받은 글자 그대로. */
export function formatKoreanTime(isoText: string): string {
  const epoch = Date.parse(isoText);
  if (Number.isNaN(epoch)) return isoText;
  const shifted = new Date(epoch + KST_OFFSET_MILLISECONDS);
  return `${shifted.getUTCFullYear()}-${twoDigits(shifted.getUTCMonth() + 1)}-${twoDigits(shifted.getUTCDate())} `
    + `${twoDigits(shifted.getUTCHours())}:${twoDigits(shifted.getUTCMinutes())}:${twoDigits(shifted.getUTCSeconds())}`;
}

/** 밀리초 → `0.4초` · `12초` · `2분 5초` · `1시간 3분`. 0 은 "—"(그 단계를 지나지 않았다). */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "—";
  if (milliseconds < 10_000) return `${(Math.round(milliseconds / 100) / 10).toString()}초`;
  const totalSeconds = Math.round(milliseconds / 1000);
  if (totalSeconds < 60) return `${totalSeconds}초`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}분 ${totalSeconds % 60}초`;
  return `${Math.floor(totalMinutes / 60)}시간 ${totalMinutes % 60}분`;
}

export type DeployStateTone = "success" | "failure" | "progress";

/** 상태 → 배지의 글자와 색 갈래(색과 글자 둘 다로 구분한다). */
export function describeDeployState(state: DeployState): { label: string; tone: DeployStateTone; detail: string | null } {
  switch (state) {
    case "succeeded": return { label: "성공", tone: "success", detail: null };
    case "failed": return { label: "실패", tone: "failure", detail: null };
    case "accepted": return { label: "진행 중", tone: "progress", detail: "접수" };
    case "ci_running": return { label: "진행 중", tone: "progress", detail: "CI" };
    case "cd_running": return { label: "진행 중", tone: "progress", detail: "CD" };
  }
}

/** 실패 단계의 이름(ci-cd internal/agent/pipeline.go:20-24 · internal/master/master.go:26-29). 모르는 값은 null(원래 낱말만 보인다). */
const FAILED_STAGE_LABELS: Readonly<Record<string, string>> = {
  ci_fetch: "소스 받기",
  ci_test: "테스트",
  ci_build: "이미지 빌드",
  cd_up: "자리 교체",
  cd_health: "헬스 확인",
  agent_unreachable: "agent 닿지 않음",
  agent_rejected: "agent 거절",
  agent_busy: "agent 작업 중",
  interrupted: "중단됨",
  store_failed: "기록 실패",
};

export function failedStageLabel(stage: string): string | null {
  return Object.hasOwn(FAILED_STAGE_LABELS, stage) ? FAILED_STAGE_LABELS[stage] : null;
}

/** 글자의 앞부분(커밋 7자 · 요청 ID 8자). */
export function shortPrefix(text: string, length: number): string {
  return text.length > length ? text.slice(0, length) : text;
}
