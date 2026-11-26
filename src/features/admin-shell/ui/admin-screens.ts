/** 어드민의 화면 넷 — 내비게이션과 홈 메뉴가 같은 목록을 쓴다. 지금은 넷 모두 화면이 있다(path 가 있다). path 가 null 이면 아직 만들지 않은 화면(링크를 걸지 않고 "준비 중") — 새 화면을 목록에 먼저 올릴 때 쓴다. */
export type AdminScreenKey = "deploys" | "logs" | "trace" | "traffic" | "status" | "resources" | "login-attempts";

export interface AdminScreen {
  key: AdminScreenKey;
  title: string;
  description: string;
  path: string | null;
}

export const ADMIN_SCREENS: readonly AdminScreen[] = [
  { key: "deploys", title: "배포 이력", description: "서비스별 배포 결과 · 커밋 · 실패 단계 · 걸린 시간", path: "/deploys" },
  { key: "logs", title: "로그 조회", description: "기간 · 서비스 · 레벨 · 요청 ID · 검색어로 앱 로그 찾기", path: "/logs" },
  { key: "trace", title: "요청 추적", description: "요청 ID 하나가 거친 서비스 · 차례 · 오래 걸린 틈", path: "/trace" },
  { key: "traffic", title: "통신 지도", description: "서비스 사이에 오가는 요청 · 실패 · 느림과 수집 상태(30초마다 갱신)", path: "/traffic" },
  { key: "status", title: "상태 한눈에", description: "각 서버의 헬스와 감시 결과", path: "/status" },
  { key: "resources", title: "서버 자원", description: "서버별 CPU · 메모리 · 디스크 · 네트워크 · GPU 와 울리는 임계값", path: "/resources" },
  { key: "login-attempts", title: "로그인 시도 기록", description: "어드민 로그인 성공 · 실패 · 잠금 기록", path: "/login-attempts" },
];
