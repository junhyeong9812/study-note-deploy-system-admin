/** 로그인 화면 — 세션 없이 열린다. 이미 로그인했으면 홈으로. */
import { redirect } from "next/navigation";
import { readVerifiedSession } from "@/features/auth/server/require-session";
import { LoginForm } from "@/features/auth/ui/LoginForm";
import styles from "@/app/login/page.module.css";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if ((await readVerifiedSession()) !== null) redirect("/");
  return (
    <main className={styles.main}>
      <section className={styles.card}>
        <h1 className={styles.title}>study-note 어드민</h1>
        <LoginForm />
      </section>
    </main>
  );
}
