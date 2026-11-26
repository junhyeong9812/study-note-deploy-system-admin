/** Claude 사용량 화면 — 받은 값만 그린다(서버 컴포넌트 · 스크립트 없음). 실행 자리를 부르지 않고, 서버 모듈 · 클라이언트 · 설정을 값으로 임포트하지 않는다.
 * 칸 넷(실행 자리 상태 · 사용량 · 최근 호출 · 상한) — 한 칸이 실패하면 그 칸만 "지금 읽지 못했습니다 — <고정 사유>"(0 으로 메우지 않는다 · 표 · 폼을 그리지 않는다).
 * 용도의 줄 · 칸은 실행 자리의 응답에 있는 용도 그대로(모르는 이름은 이름 그대로). 상한을 바꾸는 폼은 POST /api/claude-usage/limits 로 스크립트 없이 보낸다 —
 * 지금 값 · 바꾼 사람 · 비밀번호는 폼에 싣지 않는다(서버가 다시 읽고 서버가 정한다 — 넓히는 바꿈이면 서버가 확인 화면에서 비밀번호를 묻는다). */
import type { ReactNode } from "react";
import { formatDuration, formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import {
  CLAUDE_LIMITS_ACTION, CLAUDE_LIMIT_MAXIMUM, CLAUDE_LIMIT_MINIMUM, CLAUDE_USAGE_PATH, claudeLimitFieldName, claudePurposeTitle, type ClaudeLimitPair, type ClaudeLimits,
} from "@/features/claude-usage/lib/claude-limits";
import type { ClaudeRecentCall, ClaudeRunnerHealth, ClaudeUsage, ClaudeUsageCount } from "@/features/claude-usage/lib/claude-runner-client";
import type { ClaudeUsageScreen as ClaudeUsageScreenData } from "@/features/claude-usage/server/claude-usage-screen";
import type { UpstreamFailure } from "@/shared/lib/upstream-result";
import parts from "@/shared/ui/screen-parts.module.css";
import styles from "@/features/claude-usage/ui/ClaudeUsageScreen.module.css";

/** 실행 자리 헬스의 상태 → 글(README "GET /health"). */
const HEALTH_PROBLEM_TEXT: Readonly<Record<Exclude<ClaudeRunnerHealth["status"], "ok">, string>> = {
  token_missing: "구독 토큰이 없습니다",
  claude_unavailable: "claude 실행 파일을 쓸 수 없습니다",
  ledger_unavailable: "사용량 장부를 읽거나 쓸 수 없습니다",
};

type SectionKey = "health" | "usage" | "recent" | "limits";

function Section({ sectionKey, title, children }: { sectionKey: SectionKey; title: string; children: ReactNode }) {
  const titleId = `claude-${sectionKey}-title`;
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h2 className={styles.sectionTitle} id={titleId}>{title}</h2>
      {children}
    </section>
  );
}

function ReadFailure({ failure }: { failure: UpstreamFailure }) {
  return <p className={styles.failure} role="alert">{`지금 읽지 못했습니다 — ${failure.message}`}</p>;
}

function HealthBody({ health }: { health: ClaudeRunnerHealth }) {
  if (health.status === "ok") return <p className={styles.healthy}>정상</p>;
  return <p className={styles.failure} role="alert">{`${HEALTH_PROBLEM_TEXT[health.status]} (${health.status})`}</p>;
}

/** 줄의 상태 — 꺼짐이 먼저, 그다음 하루 · 한 시간 가운데 하나라도 상한에 닿았는가(상한이 0 이면 0 건이어도 닿음). */
function countState(count: ClaudeUsageCount, enabled: boolean): string {
  if (!enabled) return "꺼짐";
  return count.today >= count.perDay || count.lastHour >= count.perHour ? "상한에 닿음" : "여유";
}

function UsageRow({ title, count, enabled }: { title: string; count: ClaudeUsageCount; enabled: boolean }) {
  const state = countState(count, enabled);
  return (
    <tr>
      <th scope="row">{title}</th>
      <td>{`${count.today} / ${count.perDay}`}</td>
      <td>{`${count.lastHour} / ${count.perHour}`}</td>
      <td className={state === "상한에 닿음" ? styles.reached : undefined}>{state}</td>
    </tr>
  );
}

function UsageBody({ usage }: { usage: ClaudeUsage }) {
  return (
    <>
      {!usage.enabled && <p className={styles.failure} role="status">꺼져 있음 — Claude 를 부르지 않습니다</p>}
      <p className={styles.meta}>{`기준 시각 ${formatKoreanTime(usage.now)} · 하루는 ${formatKoreanTime(usage.dayStartedAt)} 부터`}</p>
      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr><th scope="col">범위</th><th scope="col">오늘(서울 자정부터)</th><th scope="col">최근 한 시간</th><th scope="col">상태</th></tr>
          </thead>
          <tbody>
            <UsageRow title="전체" count={usage.total} enabled={usage.enabled} />
            {Object.entries(usage.purposes).map(([name, count]) => <UsageRow key={name} title={claudePurposeTitle(name)} count={count} enabled={usage.enabled} />)}
          </tbody>
        </table>
      </div>
    </>
  );
}

function tokenText(call: ClaudeRecentCall): string {
  const usage = call.usage;
  if (usage === null || (usage.inputTokens === null && usage.outputTokens === null)) return "—";
  return `입력 ${usage.inputTokens ?? "—"} · 출력 ${usage.outputTokens ?? "—"}`;
}

function RecentBody({ recent }: { recent: ClaudeRecentCall[] }) {
  if (recent.length === 0) return <p className={styles.empty}>아직 호출이 없습니다.</p>;
  return (
    <div className={styles.scroller}>
      <table className={styles.table}>
        <thead>
          <tr><th scope="col">시각</th><th scope="col">용도</th><th scope="col">결과</th><th scope="col">걸린 시간</th><th scope="col">토큰</th></tr>
        </thead>
        <tbody>
          {recent.map((call, index) => (
            <tr key={`${call.requestId}-${index}`}>
              <td>{formatKoreanTime(call.startedAt)}</td>
              <td>{call.purpose}</td>
              <td>{call.result}</td>
              <td>{formatDuration(call.durationMs)}</td>
              <td>{tokenText(call)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LimitFields({ legend, scope, pair }: { legend: string; scope: "total" | { purpose: string }; pair: ClaudeLimitPair }) {
  return (
    <fieldset className={styles.fieldset}>
      <legend>{legend}</legend>
      {(["perDay", "perHour"] as const).map((window) => {
        const name = claudeLimitFieldName(scope, window);
        const id = `claude-limit-${name}`;
        return (
          <div className={styles.field} key={window}>
            <label htmlFor={id}>{`${legend} ${window === "perDay" ? "하루" : "한 시간"}`}</label>
            <input id={id} name={name} type="number" min={CLAUDE_LIMIT_MINIMUM} max={CLAUDE_LIMIT_MAXIMUM} step={1} defaultValue={pair[window]} required />
          </div>
        );
      })}
    </fieldset>
  );
}

function LimitsBody({ limits }: { limits: ClaudeLimits }) {
  return (
    <>
      <p>{limits.enabled ? "켜짐" : "꺼짐"}</p>
      <p className={styles.meta}>
        {limits.changedAt === null && limits.changedBy === null
          ? "아직 바꾼 적 없음"
          : `마지막으로 바꾼 사람 ${limits.changedBy ?? "—"} · ${limits.changedAt === null ? "—" : formatKoreanTime(limits.changedAt)}`}
      </p>
      <form className={styles.form} method="post" action={CLAUDE_LIMITS_ACTION}>
        <fieldset className={styles.fieldset}>
          <legend>켬 / 끔</legend>
          <span className={styles.choice}>
            <input id="claude-enabled-true" type="radio" name="enabled" value="true" defaultChecked={limits.enabled} />
            <label htmlFor="claude-enabled-true">켬</label>
          </span>
          <span className={styles.choice}>
            <input id="claude-enabled-false" type="radio" name="enabled" value="false" defaultChecked={!limits.enabled} />
            <label htmlFor="claude-enabled-false">끔</label>
          </span>
        </fieldset>
        <LimitFields legend="전체" scope="total" pair={limits.total} />
        {Object.entries(limits.purposes).map(([name, pair]) => (
          <LimitFields key={name} legend={claudePurposeTitle(name)} scope={{ purpose: name }} pair={pair} />
        ))}
        <p className={styles.note}>{`상한은 ${CLAUDE_LIMIT_MINIMUM}~${CLAUDE_LIMIT_MAXIMUM} 의 정수입니다. 0 이면 그 범위는 부르지 않습니다.`}</p>
        <p className={styles.note}>상한을 올리거나 켜면 다음 화면에서 비밀번호를 다시 확인합니다. 내리거나 끄는 것은 곧바로 바뀝니다.</p>
        <button className={styles.submit} type="submit">상한 바꾸기</button>
      </form>
    </>
  );
}

export function ClaudeUsageScreen({ screen }: { screen: ClaudeUsageScreenData }) {
  const { health, usage, limits } = screen;
  return (
    <main className={styles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>Claude 사용량</h1>
        <a className={styles.refresh} href={CLAUDE_USAGE_PATH}>지금 새로 고침</a>
      </div>
      <Section sectionKey="health" title="실행 자리 상태">
        {health.ok ? <HealthBody health={health.value} /> : <ReadFailure failure={health} />}
      </Section>
      <Section sectionKey="usage" title="사용량">
        {usage.ok ? <UsageBody usage={usage.value} /> : <ReadFailure failure={usage} />}
      </Section>
      <Section sectionKey="recent" title="최근 호출">
        {usage.ok ? <RecentBody recent={usage.value.recent} /> : <ReadFailure failure={usage} />}
      </Section>
      <Section sectionKey="limits" title="상한">
        {limits.ok ? <LimitsBody limits={limits.value} /> : <ReadFailure failure={limits} />}
      </Section>
    </main>
  );
}
