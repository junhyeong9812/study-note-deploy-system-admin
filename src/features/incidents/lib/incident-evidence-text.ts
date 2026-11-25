/** 근거 묶음 → 글(순수) — 다음 조각(12-4)이 Claude 에게 넘길 글. 화면과 **같은 내용**이다: 화면도 글도 같은 묶음(fitIncidentEvidence 를 거친 것)에서 만든다.
 *
 * 글의 꼴(줄 단위, `\n` 으로 잇는다):
 * ```
 * # 문제: <종류 이름> — <대상>
 * - 식별자: <id>
 * - 심한 정도: <위험|경고>
 * - 언제부터: <since 글자 | 모름>
 *
 * ## 무엇이 · 언제부터
 * - <label>: <value>            (facts 순서)
 *
 * ## 관련 알림
 * <칸의 글>
 * ## 로그
 * ## 배포
 * ## 자원
 * ## 줄인 것                     (reductions 가 있을 때만 — 줄마다 `- <글>`)
 * ```
 * 칸이 값이 아니면 그 칸의 글은 evidenceCellNotice 한 줄. 값의 줄(빠짐없이 — 화면에 보이는 것은 글에도 있다):
 * - 관련 알림: `기간: <from> ~ <to>` · 기록마다 `- <at> <kind> <key> <title>` · 없으면 `없음` · coversWindow false 면 EVIDENCE_TEXT.alertNotCovered.
 * - 로그: `기간: <from> ~ <to>` · 서비스 거름 · 요청 ID · 줄마다 `- <at> <level> <service> <requestId|-> <message>` · noticeText.
 * - 배포(window): `기간` · 배포마다 `- <acceptedAt> <service> <commitSha> <state>[ <failedStage>] <requestId>` · coversWindow false 면 deployNotCovered.
 *   배포(range): `앞 성공 배포: <requestId> <commitSha>` 또는 noPreviousDeploy · 같은 커밋이면 sameCommit · 커밋마다 `- <sha> <subject>` · truncated 면 `(더 있음)`.
 * - 자원(trace): 서버(또는 위치를 못 찾은 사유)와 값마다 `- <label>: 그때 <atLogText> · 창의 최대 <maximumText>`.
 *   자원(server): `서버 <server>: CPU <cpuText> · 메모리 <memoryText> · 디스크 <diskText>`.
 * 로그 · 알림의 글(message · title · key)은 믿을 수 없는 입력이다 — 이 함수는 그대로 옮기기만 한다(가리기 · 지시문 처리는 다음 조각의 몫).
 *
 * 크기 상한(fitIncidentEvidence): 글의 UTF-8 바이트가 INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES 를 넘으면 아래 차례로 줄이고, 줄인 것을 reductions 에 한 줄씩 적는다
 * (글의 "줄인 것" · 화면에 그대로 보인다 — 조용히 자르지 않는다):
 * 1. 로그 줄 — 오래된 줄부터 하나씩 뺀다(최신 줄을 남긴다). 단 EVIDENCE_LOG_MINIMUM_LINES 줄까지만.
 * 2. 그래도 넘으면 로그 한 줄의 글(message)이 EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH 자(코드 포인트)를 넘는 줄을 모두 앞 그만큼으로 자른다.
 * 3. 그래도 넘으면 관련 알림 기록 — 오래된 것(뒤)부터 뺀다(0건까지).
 * 4. 그래도 넘으면 배포의 커밋 목록(range) — 뒤(오래된 쪽)부터 뺀다(0개까지).
 * 5. 그래도 넘으면 남은 로그 줄도 오래된 것부터 뺀다(0줄까지).
 * reductions(이 차례, 해당하는 것만 한 줄씩):
 *   `로그 <원래>줄 중 오래된 <뺀 합>줄을 뺐습니다(크기 상한)` · `로그 <자른 수>줄의 글을 앞 <상한>자로 잘랐습니다(크기 상한)` ·
 *   `관련 알림 <원래>건 중 오래된 <뺀>건을 뺐습니다(크기 상한)` · `커밋 <원래>개 중 <뺀>개를 뺐습니다(크기 상한)`.
 * 줄인 뒤의 글(줄인 것 포함)은 상한 이하다. 상한 이하면 받은 묶음과 같은 값(reductions []). 받은 묶음은 바꾸지 않는다.
 *
 * 줄바꿈이 든 글(스택 등)은 이어지는 줄마다 앞에 두 칸(`  `)을 붙인다 — 글의 `## ` 제목 구조를 로그 글이 흉내 내지 못하게. */
import type { IncidentEvidence } from "@/features/incidents/lib/incident-evidence";

/** Claude 실행 자리의 입력 상한(60KB — findings.md 4절)에서 분석의 지시문 몫을 남긴 크기. */
export const INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES = 48_000;
export const EVIDENCE_LOG_MESSAGE_MAXIMUM_LENGTH = 1_000;
export const EVIDENCE_LOG_MINIMUM_LINES = 10;

export function incidentEvidenceText(evidence: IncidentEvidence): string {
  void evidence;
  throw new Error("not implemented");
}

/** UTF-8 바이트 수. */
export function evidenceTextBytes(text: string): number {
  void text;
  throw new Error("not implemented");
}

/** 크기 상한에 맞춘 묶음(새 객체 — 받은 묶음을 바꾸지 않는다). maximumBytes 는 테스트용(기본 INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES). */
export function fitIncidentEvidence(evidence: IncidentEvidence, maximumBytes: number = INCIDENT_EVIDENCE_TEXT_MAXIMUM_BYTES): IncidentEvidence {
  void evidence; void maximumBytes;
  throw new Error("not implemented");
}
