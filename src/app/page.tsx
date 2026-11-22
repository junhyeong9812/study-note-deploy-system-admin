/** 홈 — 로그인 뒤 첫 화면. 네 화면의 메뉴 자리와 로그아웃만(화면은 다음 task). */
import { requireSession } from "@/features/auth/server/require-session";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import { TemporaryRestrictionNotice } from "@/features/auth/ui/TemporaryRestrictionNotice";
import { LogoutButton } from "@/features/auth/ui/LogoutButton";
import styles from "@/app/page.module.css";

export const dynamic = "force-dynamic";

const MENU_ITEMS = [
  { title: "배포 이력", description: "서비스별 배포 결과 · 커밋 · 실패 단계 · 걸린 시간" },
  { title: "로그 조회", description: "기간 · 서비스 · 레벨 · 요청 ID · 검색어로 앱 로그 찾기" },
  { title: "상태 한눈에", description: "각 서버의 헬스와 감시 결과" },
  { title: "로그인 시도 기록", description: "어드민 로그인 성공 · 실패 · 잠금 기록" },
];

export default async function HomePage() {
  await requireSession();
  return (
    <>
      <header className={styles.header}>
        <span className={styles.brand}>study-note 어드민</span>
        <LogoutButton />
      </header>
      <main className={styles.main}>
        {isTemporaryRestrictionActive() && <div className={styles.notice}><TemporaryRestrictionNotice /></div>}
        <ul className={styles.menu}>
          {MENU_ITEMS.map((item) => (
            <li key={item.title} className={styles.menuItem}>
              <span className={styles.menuTitle}>{item.title}</span>
              <span className={styles.menuDescription}>{item.description}</span>
              <span className={styles.pending}>준비 중</span>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
