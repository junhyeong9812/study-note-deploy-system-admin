"use client";
/** 로그인 폼 — fetch 로 /api/auth/login 을 부른다. 실패 문구는 한 가지(ID·비밀번호 구별 없음), 잠금·속도 제한은 각각의 문구. */
import { useState, type FormEvent } from "react";
import styles from "@/features/auth/ui/LoginForm.module.css";

const MESSAGES = {
  invalid_credentials: "ID 또는 비밀번호가 맞지 않습니다.",
  locked: "로그인 실패가 이어져 잠시 잠겼습니다. 15분 뒤 다시 시도하세요.",
  rate_limited: "요청이 너무 많습니다. 1분 뒤 다시 시도하세요.",
  other: "로그인하지 못했습니다. 잠시 뒤 다시 시도하세요.",
} as const;

/** 비밀번호 보이기/가리기 — 보이는 상태에 따른 입력 칸 type 과 버튼 이름. 상태는 화면 메모리에만 둔다(저장하지 않는다). */
export function passwordVisibilityView(passwordVisible: boolean) {
  return passwordVisible
    ? { inputType: "text", toggleLabel: "비밀번호 가리기" }
    : { inputType: "password", toggleLabel: "비밀번호 보이기" };
}

const TEMPORARY_RESTRICTION_NOTICE = "관측 서버에 닿지 않아 임시 제한 중입니다(더 엄한 잠금 기준이 적용됩니다).";

export function LoginForm() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [temporaryRestriction, setTemporaryRestriction] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const passwordView = passwordVisibilityView(passwordVisible);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ id: String(form.get("id") ?? ""), password: String(form.get("password") ?? "") }),
      });
      const body: unknown = await response.json().catch(() => null);
      const envelope = (typeof body === "object" && body !== null ? body : {}) as {
        data?: { temporaryRestriction?: boolean };
        error?: { code?: string; temporaryRestriction?: boolean };
      };
      const restricted = envelope.data?.temporaryRestriction === true || envelope.error?.temporaryRestriction === true;
      setTemporaryRestriction(restricted);
      if (response.ok) {
        // 임시 제한 중이면 표시를 잠깐 보여 준 뒤 이동한다
        if (restricted) await new Promise((resolve) => setTimeout(resolve, 1500));
        window.location.assign("/");
        return;
      }
      const code = envelope.error?.code;
      setErrorMessage(code === "invalid_credentials" || code === "locked" || code === "rate_limited" ? MESSAGES[code] : MESSAGES.other);
    } catch {
      setErrorMessage(MESSAGES.other);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <label className={styles.field}>
        <span className={styles.label}>ID</span>
        <input className={styles.input} name="id" autoComplete="username" required maxLength={200} />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>비밀번호</span>
        <span className={styles.passwordBox}>
          <input className={`${styles.input} ${styles.passwordInput}`} name="password" type={passwordView.inputType} autoComplete="current-password" required maxLength={1024} />
          <button
            className={styles.visibilityToggle}
            type="button"
            aria-label={passwordView.toggleLabel}
            aria-pressed={passwordVisible}
            title={passwordView.toggleLabel}
            // 마우스로 눌러도 입력 칸의 포커스를 빼앗지 않는다(키보드 Enter/Space 는 그대로 동작)
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setPasswordVisible((visible) => !visible)}
          >
            {passwordVisible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </span>
      </label>
      {temporaryRestriction && <p className={styles.notice} role="status">{TEMPORARY_RESTRICTION_NOTICE}</p>}
      {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
      <button className={styles.button} type="submit" disabled={submitting}>{submitting ? "확인 중…" : "로그인"}</button>
    </form>
  );
}

function EyeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2 12s3.5-7 10-7c2 0 3.8.7 5.3 1.7M22 12s-3.5 7-10 7c-2 0-3.8-.7-5.3-1.7" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}
