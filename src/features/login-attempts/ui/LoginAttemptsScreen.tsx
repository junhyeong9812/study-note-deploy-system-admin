/** 로그인 시도 기록 화면의 본문(서버 컴포넌트) — 현재 잠금 상태 · 조회 폼(기간 · 건수) · 조회 범위 · 시도 표 · 더 보기 · 0건 · 관측 서버 실패 · 잘못된 입력.
 * 받은 값(진입 함수가 칸을 고른 결과)과 주소의 글자만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 폼은 GET 제출, 더 보기 · 최신부터 · 조건 지우기는 링크라 브라우저 스크립트 없이 동작한다.
 * 잠금 상태와 목록은 따로 그린다 — 하나가 실패해도 다른 하나는 그대로 보인다(실패한 자리만 "확인 못 함" · "불러오지 못했습니다"). */
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import {
  LOGIN_ATTEMPTS_DEFAULT_LIMIT, LOGIN_ATTEMPTS_MAXIMUM_LIMIT, LOGIN_ATTEMPTS_MAXIMUM_RANGE_MILLISECONDS,
} from "@/features/login-attempts/lib/login-attempts-query";
import type { LoginAttemptsScreenView } from "@/features/login-attempts/server/login-attempts";
import { LoginAttemptTable } from "@/features/login-attempts/ui/LoginAttemptTable";
import { LOGIN_ATTEMPTS_PATH, loginAttemptsHref, type LoginAttemptsFormValues } from "@/features/login-attempts/ui/login-attempts-address";
import { OBSERVE_FAILURE_LIMIT, OBSERVE_LOCK_MINUTES, describeLockStatus, failureText } from "@/features/login-attempts/ui/login-attempts-view";
import styles from "@/features/login-attempts/ui/LoginAttemptsScreen.module.css";
import logStyles from "@/features/logs/ui/LogSearchScreen.module.css";
import parts from "@/shared/ui/screen-parts.module.css";

const MAXIMUM_RANGE_DAYS = Math.round(LOGIN_ATTEMPTS_MAXIMUM_RANGE_MILLISECONDS / (24 * 60 * 60 * 1000));
const PROBLEM_ID = "login-attempts-query-problem";

/** 입력 이름 → 화면 글자와 바로잡는 법(잘못된 입력 안내). */
const FIELD_HINTS: Readonly<Record<string, { label: string; hint: string }>> = {
  from: { label: "시작 시각", hint: `시각 꼴이 맞는지, 끝 시각보다 늦지 않은지, 기간이 ${MAXIMUM_RANGE_DAYS}일을 넘지 않는지 확인하세요.` },
  to: { label: "끝 시각", hint: "시각 꼴이 맞는지 확인하세요." },
  before: { label: "이어 보기 위치", hint: "처음부터 다시 조회하세요." },
  limit: { label: "건수", hint: `1~${LOGIN_ATTEMPTS_MAXIMUM_LIMIT} 의 정수입니다.` },
};

/** 폼 칸 → 그 칸이 맡는 입력 이름(잘못된 칸 표시). */
const FORM_FIELD_NAMES = { fromKst: "from", toKst: "to", limit: "limit" } as const;

function KoreanTime({ value }: { value: string }) {
  return <time dateTime={value} title={`UTC ${value}`}>{formatKoreanTime(value)}</time>;
}

function LockStatus({ lock }: { lock: LoginAttemptsScreenView["lock"] }) {
  const described = describeLockStatus(lock);
  const sectionClass = `${styles.lock} ${described.kind === "locked" ? styles.lockLocked : described.kind === "unknown" ? styles.lockUnknown : ""}`;
  return (
    <section className={sectionClass} aria-labelledby="login-lock-heading">
      <div className={styles.lockHeading}>
        <h2 id="login-lock-heading" className={styles.lockTitle}>현재 잠금 상태</h2>
        {described.kind === "unknown" && (
          <span className={`${styles.badge} ${styles.toneUnknown}`}><span aria-hidden="true" className={styles.badgeMark}>?</span>확인 못 함</span>
        )}
        {described.kind === "locked" && (
          <span className={`${styles.badge} ${styles.toneLocked}`}><span aria-hidden="true" className={styles.badgeMark}>!</span>잠김</span>
        )}
        {described.kind === "unlocked" && (
          <span className={`${styles.badge} ${styles.toneSuccess}`}><span aria-hidden="true" className={styles.badgeMark}>✓</span>잠기지 않음</span>
        )}
      </div>
      {described.kind === "unknown" && <p className={styles.lockDetail}>{described.detail}</p>}
      {described.kind === "locked" && (
        <p className={styles.lockDetail}>
          풀리는 시각(KST) {described.lockedUntil === null ? "알 수 없음" : <strong><KoreanTime value={described.lockedUntil} /></strong>}
          {" "}· 연속 실패 <strong>{described.failures}회</strong> · 잠금 중에는 맞는 비밀번호도 거절합니다.
        </p>
      )}
      {described.kind === "unlocked" && (
        <p className={styles.lockDetail}>
          연속 실패 <strong>{described.failures}회</strong>
          {" "}· {described.remaining > 0 ? <>{described.remaining}회 더 실패하면 {OBSERVE_LOCK_MINUTES}분 잠금</> : <>다음 실패에 잠금</>}
        </p>
      )}
      <p className={styles.lockNote}>
        관측 서버 기준 연속 {OBSERVE_FAILURE_LIMIT}회 실패면 {OBSERVE_LOCK_MINUTES}분 잠금 · 이 화면을 연 때의 상태입니다(자동으로 새로 고치지 않습니다).
      </p>
    </section>
  );
}

function LoginAttemptsForm({ values, invalidField }: { values: LoginAttemptsFormValues; invalidField: string | null }) {
  const invalid = (field: keyof typeof FORM_FIELD_NAMES) => (invalidField === FORM_FIELD_NAMES[field]
    ? { "aria-invalid": true, "aria-describedby": PROBLEM_ID } as const
    : {});
  const fieldClass = (field: keyof typeof FORM_FIELD_NAMES) => `${logStyles.field} ${invalidField === FORM_FIELD_NAMES[field] ? logStyles.fieldInvalid : ""}`;
  return (
    <form className={logStyles.form} method="get" action={LOGIN_ATTEMPTS_PATH} role="search" aria-label="로그인 시도 조회 조건">
      <div className={logStyles.fields}>
        <div className={fieldClass("fromKst")}>
          <label htmlFor="attempt-from">시작 시각(KST)</label>
          <input id="attempt-from" name="from_kst" type="datetime-local" step={1} defaultValue={values.fromKst} {...invalid("fromKst")} />
        </div>
        <div className={fieldClass("toKst")}>
          <label htmlFor="attempt-to">끝 시각(KST)</label>
          <input id="attempt-to" name="to_kst" type="datetime-local" step={1} defaultValue={values.toKst} {...invalid("toKst")} />
        </div>
        <div className={fieldClass("limit")}>
          <label htmlFor="attempt-limit">건수</label>
          <input id="attempt-limit" name="limit" type="number" inputMode="numeric" min={1} max={LOGIN_ATTEMPTS_MAXIMUM_LIMIT}
            placeholder={String(LOGIN_ATTEMPTS_DEFAULT_LIMIT)} defaultValue={values.limit} {...invalid("limit")} />
        </div>
      </div>
      <p className={logStyles.formHint}>시각을 비우면 최근 {MAXIMUM_RANGE_DAYS}일(기록 보관 기간). 기간은 최대 {MAXIMUM_RANGE_DAYS}일. 빈 칸은 조건에 넣지 않습니다.</p>
      <div className={logStyles.actions}>
        <button className={logStyles.submit} type="submit">조회</button>
        <a className={logStyles.reset} href={LOGIN_ATTEMPTS_PATH}>조건 지우기</a>
      </div>
    </form>
  );
}

export interface LoginAttemptsScreenProps {
  view: LoginAttemptsScreenView;
  /** 폼에 다시 채울 값(주소의 글자 — loginAttemptsFormValues) */
  formValues: LoginAttemptsFormValues;
}

export function LoginAttemptsScreen({ view, formValues }: LoginAttemptsScreenProps) {
  const { attempts, query, nextPageQuery, lock } = view;
  const invalidField = !attempts.ok && attempts.reason === "invalid_input" ? attempts.field ?? "" : null;
  const page = attempts.ok ? attempts.value : null;
  const limit = query?.limit ?? LOGIN_ATTEMPTS_DEFAULT_LIMIT;
  const fieldHint = invalidField === null ? null : FIELD_HINTS[invalidField] ?? { label: invalidField, hint: "값을 확인하세요." };
  return (
    <main className={logStyles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>로그인 시도 기록</h1>
        {page !== null && (
          <p className={parts.count}>
            <strong>{page.attempts.length}건</strong>
            <span className={parts.countNote}>(최신순, 한 번에 최대 {limit}건)</span>
          </p>
        )}
      </div>

      <LockStatus lock={lock} />

      {fieldHint !== null && (
        <div className={parts.problem} role="alert" id={PROBLEM_ID}>
          <p className={parts.problemTitle}>조회 조건이 맞지 않습니다</p>
          <p className={parts.problemDetail}>
            <strong>{fieldHint.label}</strong>: {fieldHint.hint} <a href={LOGIN_ATTEMPTS_PATH}>조건 지우기</a>
          </p>
        </div>
      )}

      <LoginAttemptsForm values={formValues} invalidField={invalidField} />

      {!attempts.ok && attempts.reason !== "invalid_input" && (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>로그인 시도 기록을 불러오지 못했습니다</p>
          <p className={parts.problemDetail}>관측 서버: {failureText(attempts)}</p>
        </div>
      )}

      {page !== null && query !== null && (
        <section className={logStyles.results} aria-label="조회 결과">
          <p className={logStyles.range}>
            조회 범위(KST) <KoreanTime value={page.from} /> ~ <KoreanTime value={page.to} />
            {query.before !== null && (
              <> · 이어 보기 중 — <a href={loginAttemptsHref({ ...query, before: null })}>이 범위의 최신부터 보기</a></>
            )}
          </p>
          {page.attempts.length === 0 ? (
            <p className={parts.empty}>이 범위에 로그인 시도 기록이 없습니다.</p>
          ) : (
            <>
              <LoginAttemptTable attempts={page.attempts} />
              <p className={styles.legend}>
                거절(속도 제한 · 출처 다름 · 형식 오류)은 자격을 확인하기 전에 막은 요청이며, 같은 IP · 같은 이유는 1분에 첫 1건만 기록됩니다.
              </p>
            </>
          )}
          {nextPageQuery !== null ? (
            <p className={logStyles.more}>
              <a className={logStyles.moreLink} href={loginAttemptsHref(nextPageQuery)}>더 보기 — 이전 기록 {limit}건</a>
            </p>
          ) : page.attempts.length > 0 && (
            <p className={logStyles.end}>이 범위의 기록을 끝까지 보았습니다.</p>
          )}
        </section>
      )}
    </main>
  );
}
