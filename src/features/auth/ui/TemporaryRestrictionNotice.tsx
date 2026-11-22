/** "임시 제한 중" 표시 — 관측 서버에 닿지 않는 동안(세부 4) 로그인 화면과 로그인 뒤 화면에 보인다. 서버에서 렌더한다. */
import styles from "@/features/auth/ui/TemporaryRestrictionNotice.module.css";

export function TemporaryRestrictionNotice() {
  return (
    <p className={styles.notice} role="status">
      <strong className={styles.label}>임시 제한 중</strong>
      <span>관측 서버에 닿지 않아 로그인 잠금을 이 서버의 메모리로 판정합니다(더 엄한 기준). 로그인 기록은 관측 서버가 돌아오면 보냅니다.</span>
    </p>
  );
}
