/** 홈 — 로그인 뒤 첫 화면. 공통 틀(내비게이션 · 로그아웃 · 임시 제한 표시) + 네 화면의 메뉴(지금은 넷 모두 링크. path 가 null 인 화면이 생기면 "준비 중"). */
import { AdminShell } from "@/features/admin-shell/ui/AdminShell";
import { ADMIN_SCREENS } from "@/features/admin-shell/ui/admin-screens";
import { requireSession } from "@/features/auth/server/require-session";
import { isTemporaryRestrictionActive } from "@/features/auth/server/temporary-restriction-status";
import styles from "@/app/page.module.css";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await requireSession();
  return (
    <AdminShell current={null} temporaryRestriction={isTemporaryRestrictionActive()}>
      <main className={styles.main}>
        <ul className={styles.menu}>
          {ADMIN_SCREENS.map((screen) => (
            <li key={screen.key}>
              {screen.path === null ? (
                <div className={styles.menuItem}>
                  <span className={styles.menuTitle}>{screen.title}</span>
                  <span className={styles.menuDescription}>{screen.description}</span>
                  <span className={styles.pending}>준비 중</span>
                </div>
              ) : (
                <a className={`${styles.menuItem} ${styles.menuLink}`} href={screen.path}>
                  <span className={styles.menuTitle}>{screen.title}</span>
                  <span className={styles.menuDescription}>{screen.description}</span>
                </a>
              )}
            </li>
          ))}
        </ul>
      </main>
    </AdminShell>
  );
}
