/** 로그인 뒤 화면의 공통 틀 — 머리(이름 · 화면 넷 내비게이션 · 로그아웃) + "임시 제한 중" 표시 + 본문.
 * 서버 컴포넌트. 임시 제한 여부는 화면(src/app)이 서버 쪽 상태 함수로 정해 넘긴다(이 파일은 서버 모듈을 임포트하지 않는다). */
import type { ReactNode } from "react";
import { LogoutButton } from "@/features/auth/ui/LogoutButton";
import { TemporaryRestrictionNotice } from "@/features/auth/ui/TemporaryRestrictionNotice";
import { ADMIN_SCREENS, type AdminScreenKey } from "@/features/admin-shell/ui/admin-screens";
import styles from "@/features/admin-shell/ui/AdminShell.module.css";

export interface AdminShellProps {
  /** 지금 화면(홈이면 null) */
  current: AdminScreenKey | null;
  temporaryRestriction: boolean;
  children: ReactNode;
}

export function AdminShell({ current, temporaryRestriction, children }: AdminShellProps) {
  return (
    <>
      <header className={styles.header}>
        <a className={styles.brand} href="/">study-note 어드민</a>
        <nav className={styles.navigation} aria-label="화면">
          <ul className={styles.navigationList}>
            {ADMIN_SCREENS.map((screen) => (
              <li key={screen.key}>
                {screen.path === null ? (
                  <span className={styles.pendingItem} aria-disabled="true">
                    {screen.title}<span className={styles.pendingMark}>준비 중</span>
                  </span>
                ) : (
                  <a className={styles.navigationLink} href={screen.path} aria-current={current === screen.key ? "page" : undefined}>
                    {screen.title}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.logout}><LogoutButton /></div>
      </header>
      {temporaryRestriction && <div className={styles.notice}><TemporaryRestrictionNotice /></div>}
      {children}
    </>
  );
}
