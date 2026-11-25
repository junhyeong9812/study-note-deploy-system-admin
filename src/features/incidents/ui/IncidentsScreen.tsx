/** 문제 화면의 본문(서버 컴포넌트 — 스크립트 · 폼 · 단추 없음, 읽기 전용). 받은 값만 그린다 — 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 목록: 문제마다 종류 · 대상 · 언제부터 · 심한 정도를 글로(색만으로 전하지 않는다) + 그 문제로 가는 링크. 목록 위에 확인하지 못한 출처의 줄 · 빈 목록의 말.
 * 문제 하나: 칸마다 제목(EVIDENCE_SECTION_TITLES)이 있는 구역 — 로그 줄은 로그 화면의 그 줄로, 배포는 배포 이력의 그 배포로, 자원은 서버 자원 화면의 그 서버로 가는 링크.
 * 글(로그 · 알림 · 커밋)은 React 의 글자 출력(이스케이프)으로만. 근거 묶음은 fitIncidentEvidence 를 거친 것 — 글(incidentEvidenceText)과 같은 내용이다.
 *
 * 테스트가 고정한 꼴(app/incidents/incidents-page.test.ts):
 * - 본문은 `<main>` 하나. 목록은 `<section aria-labelledby="incident-list">` 안의 표 — 머리 칸 `<th scope="col">` 종류 · 대상 · 언제부터 · 심한 정도.
 *   줄마다 대상 칸에 그 문제로 가는 링크(incidentHref). 언제부터 = formatKoreanTime(since), since 가 없으면 감시 대상은 "모름" · 오류 로그는 "최근 10분".
 *   오류 로그의 대상 칸은 `<서비스> — <errorCountText>`. 확인하지 못한 출처의 줄(text) · errorLogsTruncated 글 · emptyText 는 표 위에.
 * - 문제 하나: 구역마다 `<section aria-labelledby="evidence-<칸>">` + `<h2 id="evidence-<칸>">` — 칸 = facts · alertHistory · logs · deployments · resources
 *   (이 차례), 줄인 것이 있으면 그 뒤에 evidence-reductions. facts 의 값 · 시각은 글과 같은 글자 그대로(KST 는 덧붙여도 된다). 커밋 · 요청 ID 는 전체 글자.
 * - 닫힘 · 확인하지 못함 · 입력 거절(UPSTREAM_FAILURE_MESSAGES.invalid_input)에는 `<a href="/incidents">문제 목록으로</a>`.
 * - 본문의 링크는 /incidents · /logs · /deploys · /resources 로만(요청 추적 화면은 아직 없다). 폼 · 단추 · 입력 칸 · on* 속성 없음. */
import type { IncidentsScreenOutcome } from "@/features/incidents/server/incidents-screen";

export interface IncidentsScreenProps {
  outcome: IncidentsScreenOutcome;
}

export function IncidentsScreen(props: IncidentsScreenProps) {
  void props;
  throw new Error("not implemented");
}
