/** 주인 표시 화면 — 받은 값만 그린다(서버 컴포넌트 · 스크립트 없음). 쿠키의 값 · 서명 · 열쇠는 그리지 않는다(판정의 낱말과 시각만).
 * 칸 둘: 이 브라우저의 상태(주인 · 만든 날 · 끝나는 날 / 표시 없음 / 쓸 수 없음(까닭의 낱말) / 판정할 수 없음) ·
 * 단추(표시하기 → POST /api/owner-mark · 지우기 → POST /api/owner-mark/clear — 숨은 칸 없음). 설정이 쓸 수 없으면 표시하기 대신 "설정 없음"(이름으로). */
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import { OWNER_MARK_PROBLEM_SETTING_NAMES, type OwnerMarkSettings, type OwnerMarkVerdict } from "@/features/owner-mark/lib/owner-mark";
import type { OwnerMarkScreen as OwnerMarkScreenData } from "@/features/owner-mark/server/owner-mark-screen";
import parts from "@/shared/ui/screen-parts.module.css";
import styles from "@/features/owner-mark/ui/OwnerMarkScreen.module.css";

function koreanTime(milliseconds: number): string {
  return formatKoreanTime(new Date(milliseconds).toISOString());
}

function StatusBody({ verdict, settingsOk }: { verdict: OwnerMarkVerdict; settingsOk: boolean }) {
  if (verdict.owner) {
    return (
      <>
        <p className={styles.owner}>주인으로 표시됨</p>
        <p className={styles.meta}>{`만든 날 ${koreanTime(verdict.createdAt)} · 끝나는 날 ${koreanTime(verdict.expiresAt)}`}</p>
      </>
    );
  }
  if (verdict.reason === "no_cookie") {
    return (
      <>
        <p>표시 없음</p>
        {/* 공개 접미사 · 도메인 밖이면 브라우저가 쿠키를 조용히 버린다 — 설정 검사로는 가릴 수 없어 까닭의 후보를 보인다 */}
        {settingsOk && (
          <p className={styles.meta}>
            표시하기를 눌렀는데도 표시 없음이면: OWNER_COOKIE_DOMAIN 이 이 어드민과 사이트가 함께 속한 도메인이 아니거나 공개 접미사(co.kr · github.io 류)이거나, 브라우저가 쿠키를 막았을 수 있습니다.
          </p>
        )}
      </>
    );
  }
  if (verdict.reason === "no_secret") return <p className={styles.failure}>판정할 수 없음 — 열쇠 설정 없음 (no_secret)</p>;
  return <p className={styles.failure}>{`표시가 있으나 쓸 수 없음 (${verdict.reason})`}</p>;
}

function settingsProblemText(settings: Extract<OwnerMarkSettings, { ok: false }>): string {
  const names = [...new Set(settings.problems.flatMap((problem) => OWNER_MARK_PROBLEM_SETTING_NAMES[problem]))];
  const outside = settings.problems.includes("admin_outside_domain")
    ? " 어드민의 주소(ADMIN_ORIGIN)가 OWNER_COOKIE_DOMAIN 의 아래가 아니면 브라우저가 쿠키를 버립니다."
    : "";
  return `설정 없음 — ${names.join(" · ")} 을(를) 확인하세요.${outside}`;
}

function ActionForm({ action, label }: { action: string; label: string }) {
  return (
    <form method="post" action={action}>
      <button type="submit">{label}</button>
    </form>
  );
}

export function OwnerMarkScreen({ screen }: { screen: OwnerMarkScreenData }) {
  const { settings, verdict } = screen;
  const canClear = settings.ok || settings.clearableDomain !== null;
  return (
    <main className={styles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>주인 표시</h1>
      </div>
      <p className={styles.lead}>
        주인으로 표시한 이 브라우저에서만 Claude 대체 답변과 실습을 쓸 수 있습니다. 표시는 30일 동안 남고, 언제든 "주인 표시 지우기"로 없앨 수 있습니다.
        OWNER_COOKIE_SECRET 을 바꾸면 모든 표시가 한꺼번에 없어집니다.
      </p>
      <section className={styles.section} aria-labelledby="owner-mark-status-title">
        <h2 className={styles.sectionTitle} id="owner-mark-status-title">이 브라우저의 상태</h2>
        <StatusBody verdict={verdict} settingsOk={settings.ok} />
      </section>
      <section className={styles.section} aria-labelledby="owner-mark-actions-title">
        <h2 className={styles.sectionTitle} id="owner-mark-actions-title">표시하기 · 지우기</h2>
        {!settings.ok && <p className={styles.failure} role="alert">{settingsProblemText(settings)}</p>}
        <div className={styles.actions}>
          {settings.ok && <ActionForm action="/api/owner-mark" label="이 브라우저를 주인으로 표시" />}
          {canClear && <ActionForm action="/api/owner-mark/clear" label="주인 표시 지우기" />}
        </div>
      </section>
    </main>
  );
}
