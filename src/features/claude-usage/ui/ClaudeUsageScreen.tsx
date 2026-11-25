/** Claude 사용량 화면 — 받은 값만 그린다(서버 컴포넌트 · 스크립트 없음).
 * 뼈대: 테스트 설계 워커가 계약만 고정했다. 몸은 구현 워커가 채운다(그리는 글 · 구조는 src/app/claude-usage/claude-usage-page.test.ts). */
import type { ClaudeUsageScreen as ClaudeUsageScreenData } from "@/features/claude-usage/server/claude-usage-screen";

export function ClaudeUsageScreen(_props: { screen: ClaudeUsageScreenData }) {
  return null;
}
