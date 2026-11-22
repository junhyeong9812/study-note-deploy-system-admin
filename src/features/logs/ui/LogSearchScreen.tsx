/** 로그 조회 화면의 본문(서버 컴포넌트) — 조회 폼 · 조회 범위 · 결과 표 · 더 보기 · 0건 · 관측 서버 실패 · 잘못된 입력.
 * 받은 값(진입 함수가 칸을 고른 결과)과 주소의 글자만 그린다 — 다른 서버를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * 폼은 GET 제출, 더 보기 · 요청 ID · 최신부터 · 조건 지우기는 링크라 브라우저 스크립트 없이 동작한다. */
import type { LogSearchView } from "@/features/logs/server/log-search";
import {
  LOG_LEVELS, LOG_QUERY_DEFAULT_LIMIT, LOG_QUERY_MAXIMUM_LIMIT, LOG_QUERY_MAXIMUM_RANGE_MILLISECONDS, LOG_SEARCH_TEXT_MAXIMUM_LENGTH,
  LOG_SEARCH_TEXT_MINIMUM_LENGTH,
} from "@/features/logs/lib/log-query";
import { LogTable, formatKoreanLogTime } from "@/features/logs/ui/LogTable";
import { LOGS_PATH, logsHref, requestFlowHref, type LogFormValues } from "@/features/logs/ui/logs-address";
import styles from "@/features/logs/ui/LogSearchScreen.module.css";

const MAXIMUM_RANGE_DAYS = Math.round(LOG_QUERY_MAXIMUM_RANGE_MILLISECONDS / (24 * 60 * 60 * 1000));
const PROBLEM_ID = "log-query-problem";

/** 입력 이름 → 화면 글자와 바로잡는 법(잘못된 입력 안내). */
const FIELD_HINTS: Readonly<Record<string, { label: string; hint: string }>> = {
  from: { label: "시작 시각", hint: `시각 꼴이 맞는지, 끝 시각보다 늦지 않은지, 기간이 ${MAXIMUM_RANGE_DAYS}일을 넘지 않는지 확인하세요.` },
  to: { label: "끝 시각", hint: "시각 꼴이 맞는지 확인하세요." },
  service: { label: "서비스", hint: "영문 소문자 · 숫자 · - 로 40자 이하입니다." },
  level: { label: "수준", hint: `${LOG_LEVELS.join(" · ")} 중 하나입니다.` },
  request_id: { label: "요청 ID", hint: "영문 · 숫자 · _ . - 로 80자 이하입니다." },
  q: { label: "낱말", hint: `앞뒤 공백을 빼고 ${LOG_SEARCH_TEXT_MINIMUM_LENGTH}자 이상, ${LOG_SEARCH_TEXT_MAXIMUM_LENGTH}자 이하입니다.` },
  before: { label: "이어 보기 위치", hint: "처음부터 다시 조회하세요." },
  limit: { label: "건수", hint: `1~${LOG_QUERY_MAXIMUM_LIMIT} 의 정수입니다.` },
};

/** 폼 칸 → 그 칸이 맡는 입력 이름(잘못된 칸 표시). */
const FORM_FIELD_NAMES = { fromKst: "from", toKst: "to", service: "service", level: "level", requestId: "request_id", text: "q", limit: "limit" } as const;

function KoreanTime({ value }: { value: string }) {
  return <time dateTime={value} title={`UTC ${value}`}>{formatKoreanLogTime(value)}</time>;
}

function LogSearchForm({ values, invalidField, services }: { values: LogFormValues; invalidField: string | null; services: string[] }) {
  const invalid = (field: keyof typeof FORM_FIELD_NAMES) => (invalidField === FORM_FIELD_NAMES[field]
    ? { "aria-invalid": true, "aria-describedby": PROBLEM_ID } as const
    : {});
  const fieldClass = (field: keyof typeof FORM_FIELD_NAMES) => `${styles.field} ${invalidField === FORM_FIELD_NAMES[field] ? styles.fieldInvalid : ""}`;
  return (
    <form className={styles.form} method="get" action={LOGS_PATH} role="search" aria-label="로그 조회 조건">
      <div className={styles.fields}>
        <div className={fieldClass("fromKst")}>
          <label htmlFor="log-from">시작 시각(KST)</label>
          <input id="log-from" name="from_kst" type="datetime-local" step={1} defaultValue={values.fromKst} {...invalid("fromKst")} />
        </div>
        <div className={fieldClass("toKst")}>
          <label htmlFor="log-to">끝 시각(KST)</label>
          <input id="log-to" name="to_kst" type="datetime-local" step={1} defaultValue={values.toKst} {...invalid("toKst")} />
        </div>
        <div className={fieldClass("service")}>
          <label htmlFor="log-service">서비스</label>
          <input id="log-service" name="service" type="text" list="log-services" autoComplete="off" spellCheck={false}
            placeholder="전체" defaultValue={values.service} {...invalid("service")} />
          <datalist id="log-services">
            {services.map((service) => <option key={service} value={service} />)}
          </datalist>
        </div>
        <div className={fieldClass("level")}>
          <label htmlFor="log-level">수준</label>
          <select id="log-level" name="level" defaultValue={values.level} {...invalid("level")}>
            <option value="">전체</option>
            {LOG_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
            {values.level !== "" && !(LOG_LEVELS as readonly string[]).includes(values.level) && (
              <option value={values.level}>{values.level}(맞지 않음)</option>
            )}
          </select>
        </div>
        <div className={fieldClass("requestId")}>
          <label htmlFor="log-request-id">요청 ID</label>
          <input id="log-request-id" name="request_id" type="text" autoComplete="off" spellCheck={false}
            defaultValue={values.requestId} {...invalid("requestId")} />
        </div>
        <div className={`${fieldClass("text")} ${styles.fieldWide}`}>
          <label htmlFor="log-text">낱말(메시지에 든 글자, {LOG_SEARCH_TEXT_MINIMUM_LENGTH}자 이상)</label>
          <input id="log-text" name="q" type="search" autoComplete="off" defaultValue={values.text} {...invalid("text")} />
        </div>
        <div className={fieldClass("limit")}>
          <label htmlFor="log-limit">건수</label>
          <input id="log-limit" name="limit" type="number" inputMode="numeric" min={1} max={LOG_QUERY_MAXIMUM_LIMIT}
            placeholder={String(LOG_QUERY_DEFAULT_LIMIT)} defaultValue={values.limit} {...invalid("limit")} />
        </div>
      </div>
      <p className={styles.formHint}>시각을 비우면 최근 1시간. 기간은 최대 {MAXIMUM_RANGE_DAYS}일. 빈 칸은 조건에 넣지 않습니다.</p>
      <div className={styles.actions}>
        <button className={styles.submit} type="submit">조회</button>
        <a className={styles.reset} href={LOGS_PATH}>조건 지우기</a>
      </div>
    </form>
  );
}

export interface LogSearchScreenProps {
  view: LogSearchView;
  /** 폼에 다시 채울 값(주소의 글자 — logFormValues) */
  formValues: LogFormValues;
}

export function LogSearchScreen({ view, formValues }: LogSearchScreenProps) {
  const { logs, query, nextPageQuery } = view;
  const invalidField = !logs.ok && logs.reason === "invalid_input" ? logs.field ?? "" : null;
  const page = logs.ok ? logs.value : null;
  const services = page === null ? [] : [...new Set(page.logs.map((entry) => entry.service))].sort();
  const limit = query?.limit ?? LOG_QUERY_DEFAULT_LIMIT;
  const fieldHint = invalidField === null ? null : FIELD_HINTS[invalidField] ?? { label: invalidField, hint: "값을 확인하세요." };
  return (
    <main className={styles.main}>
      <div className={styles.heading}>
        <h1 className={styles.title}>로그 조회</h1>
        {page !== null && (
          <p className={styles.count}>
            <strong>{page.logs.length}건</strong>
            <span className={styles.countNote}>(최신순, 한 번에 최대 {limit}건)</span>
          </p>
        )}
      </div>

      {fieldHint !== null && (
        <div className={styles.problem} role="alert" id={PROBLEM_ID}>
          <p className={styles.problemTitle}>조회 조건이 맞지 않습니다</p>
          <p className={styles.problemDetail}>
            <strong>{fieldHint.label}</strong>: {fieldHint.hint} <a href={LOGS_PATH}>조건 지우기</a>
          </p>
        </div>
      )}

      <LogSearchForm values={formValues} invalidField={invalidField} services={services} />

      {!logs.ok && logs.reason !== "invalid_input" && (
        <div className={styles.problem} role="alert">
          <p className={styles.problemTitle}>로그를 불러오지 못했습니다</p>
          <p className={styles.problemDetail}>
            관측 서버: {logs.message}{logs.status !== undefined && <> · HTTP {logs.status}</>}
          </p>
        </div>
      )}

      {page !== null && query !== null && (
        <section className={styles.results} aria-label="조회 결과">
          <p className={styles.range}>
            조회 범위(KST) <KoreanTime value={page.from} /> ~ <KoreanTime value={page.to} />
            {query.before !== null && (
              <> · 이어 보기 중 — <a href={logsHref({ ...query, before: null })}>이 범위의 최신부터 보기</a></>
            )}
          </p>
          {page.logs.length === 0 ? (
            <p className={styles.empty}>조건에 맞는 로그가 없습니다.</p>
          ) : (
            <LogTable logs={page.logs} currentRequestId={query.requestId}
              requestHref={(requestId) => requestFlowHref(requestId, page, limit)} />
          )}
          {nextPageQuery !== null ? (
            <p className={styles.more}>
              <a className={styles.moreLink} href={logsHref(nextPageQuery)}>더 보기 — 이전 로그 {limit}건</a>
            </p>
          ) : page.logs.length > 0 && (
            <p className={styles.end}>이 범위의 로그를 끝까지 보았습니다.</p>
          )}
        </section>
      )}
    </main>
  );
}
