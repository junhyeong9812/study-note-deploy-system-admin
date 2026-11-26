/** 주인 표시 화면 — 받은 값만 그린다(서버 컴포넌트 · 스크립트 없음). 쿠키의 값 · 서명은 그리지 않는다.
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 몸은 구현 워커가 채운다(글 · 구조는 src/app/owner-mark/owner-mark-page.test.ts). */
import type { OwnerMarkScreen as OwnerMarkScreenData } from "@/features/owner-mark/server/owner-mark-screen";

export function OwnerMarkScreen(_props: { screen: OwnerMarkScreenData }) {
  return null;
}
