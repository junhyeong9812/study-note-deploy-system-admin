"use client";
/** 로그아웃 — POST /api/auth/logout 뒤 로그인 화면으로. */
import { useState } from "react";
import styles from "@/features/auth/ui/LogoutButton.module.css";

export function LogoutButton() {
  const [failed, setFailed] = useState(false);

  async function handleClick() {
    setFailed(false);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      if (response.ok || response.status === 401) {
        window.location.assign("/login");
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    }
  }

  return (
    <span className={styles.wrapper}>
      <button className={styles.button} type="button" onClick={handleClick}>로그아웃</button>
      {failed && <span className={styles.error} role="alert">로그아웃하지 못했습니다.</span>}
    </span>
  );
}
