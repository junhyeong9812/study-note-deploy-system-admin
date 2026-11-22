/** 어드민의 화면 넷 — 내비게이션과 홈 메뉴가 같은 목록을 쓴다. 아직 만들지 않은 화면은 path 가 null(링크를 걸지 않고 "준비 중"). */
export type AdminScreenKey = "deploys" | "logs" | "status" | "login-attempts";

export interface AdminScreen {
  key: AdminScreenKey;
  title: string;
  description: string;
  path: string | null;
}

export const ADMIN_SCREENS: readonly AdminScreen[] = [
  { key: "deploys", title: "배포 이력", description: "서비스별 배포 결과 · 커밋 · 실패 단계 · 걸린 시간", path: "/deploys" },
  { key: "logs", title: "로그 조회", description: "기간 · 서비스 · 레벨 · 요청 ID · 검색어로 앱 로그 찾기", path: "/logs" },
  { key: "status", title: "상태 한눈에", description: "각 서버의 헬스와 감시 결과", path: null },
  { key: "login-attempts", title: "로그인 시도 기록", description: "어드민 로그인 성공 · 실패 · 잠금 기록", path: null },
];
