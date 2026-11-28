/** 분석 화면(서버 컴포넌트 — 스크립트 없음). 받은 값만 그린다 — 서버 모듈 · 클라이언트 · 설정을 임포트하지 않는다.
 * - 답의 다섯 칸 · 보낸 글은 React 의 글자 출력으로만(마크다운 · HTML 을 풀지 않고 링크로 만들지 않는다). 답의 글은 제어 문자(줄바꿈 · 탭 밖)와 서식 문자(Cf)를 지운다.
 * - 권하는 조치는 표시 글뿐(단추 · 폼 · 링크 없음 — 실행은 12-6 이 재배포의 확인 화면으로 넘긴다) · "분석은 틀릴 수 있습니다"가 늘 있다.
 * - 진행 중일 때만 `<meta http-equiv="refresh">`(INCIDENT_ANALYSIS_REFRESH_SECONDS). 보낸 글 그대로는 `<details>` 안의 `<pre>`(저장된 글).
 * - 미리보기: 보낼 글 그대로 · 바이트 수 · 자 수 · 줄인 것 · 가린 것 + POST 폼(숨은 칸 incident · preview · prompt, 단추 하나) — 폼은 미리보기에만.
 * - "분석 요청" 링크는 문제가 열려 있고 저장소가 있고 진행 중이 아닐 때만. 계약: IncidentAnalysisScreen.test.ts 머리 주석. */
import type { ReactNode } from "react";
import { ANALYSIS_ACTION_LABELS, ANALYSIS_CONFIDENCE_LABELS, type AnalysisAnswer } from "@/features/incident-analysis/lib/analysis-answer";
import {
  ANALYSIS_FAILURE_TEXTS, INCIDENT_ANALYSIS_REFRESH_SECONDS, INCIDENT_ANALYSIS_START_PATH, INCIDENT_ANALYSIS_TEXT, incidentAnalysisHref,
  type AnalysisPreviewView, type IncidentAnalysisScreenData, type IncidentAnalysisScreenOutcome,
} from "@/features/incident-analysis/lib/incident-analysis-screen";
import type { AnalysisEntry } from "@/features/incident-analysis/lib/incident-analysis-service";
import { INCIDENTS_PATH, incidentHref } from "@/features/incidents/lib/incidents-query";
import { formatKoreanTime } from "@/features/deploys/lib/deploy-format";
import { UPSTREAM_FAILURE_MESSAGES } from "@/shared/lib/upstream-result";
import parts from "@/shared/ui/screen-parts.module.css";
import styles from "@/features/incident-analysis/ui/IncidentAnalysisScreen.module.css";

/** 제어 문자(줄바꿈 · 탭 밖)와 서식 문자(Cf — 방향 바꾸기 · 폭 없는 글자 등)를 지운다. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function visibleText(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, (character) => (character === "\n" || character === "\t" ? character : ""));
}

function KoreanTime({ value }: { value: string }) {
  return <time dateTime={value} title={`UTC ${value}`}>{formatKoreanTime(value)}</time>;
}

function AnswerBlock({ answer }: { answer: AnalysisAnswer }) {
  return (
    <dl className={styles.summary}>
      <dt>{INCIDENT_ANALYSIS_TEXT.cause}</dt>
      <dd><p className={styles.answerText}>{visibleText(answer.cause)}</p></dd>
      <dt>{INCIDENT_ANALYSIS_TEXT.evidence}</dt>
      <dd>
        <ul className={styles.evidenceList}>
          {answer.evidence.map((item, index) => <li key={index} className={styles.answerText}>{visibleText(item)}</li>)}
        </ul>
      </dd>
      <dt>{INCIDENT_ANALYSIS_TEXT.confidence}</dt>
      <dd>{ANALYSIS_CONFIDENCE_LABELS[answer.confidence]}</dd>
      <dt>{INCIDENT_ANALYSIS_TEXT.remedy}</dt>
      <dd><p className={styles.answerText}>{visibleText(answer.remedy)}</p></dd>
      <dt>{INCIDENT_ANALYSIS_TEXT.recommendedAction}</dt>
      <dd><strong>{ANALYSIS_ACTION_LABELS[answer.recommendedAction]}</strong></dd>
    </dl>
  );
}

function EntryBlock({ entry }: { entry: AnalysisEntry }) {
  if (entry.kind === "unreadable") return <section className={styles.section}><p className={styles.failure}>{INCIDENT_ANALYSIS_TEXT.unreadable}</p></section>;
  const { attempt, status } = entry;
  const duration = attempt.durationMilliseconds === null ? "" : ` · ${Math.round(attempt.durationMilliseconds / 1000)}초`;
  return (
    <section className={styles.section} aria-label={`분석 ${attempt.requestId}`}>
      <p className={styles.meta}>
        보낸 시각(KST) <KoreanTime value={attempt.startedAt} />{` · ${attempt.account} · ${attempt.promptBytes}바이트${duration}`}
      </p>
      {entry.fromEarlierOpening && <p className={styles.note} role="note">{INCIDENT_ANALYSIS_TEXT.earlierOpening}</p>}
      {status === "running" && <p className={styles.note} role="status">{INCIDENT_ANALYSIS_TEXT.running}</p>}
      {status === "interrupted" && <p className={styles.failure}>{INCIDENT_ANALYSIS_TEXT.interrupted}</p>}
      {status === "failed" && attempt.failureReason !== null && <p className={styles.failure}>{ANALYSIS_FAILURE_TEXTS[attempt.failureReason]}</p>}
      {status === "succeeded" && attempt.answer !== null && <AnswerBlock answer={attempt.answer} />}
      <details>
        <summary>{INCIDENT_ANALYSIS_TEXT.sentText}</summary>
        <pre className={styles.sentText}>{attempt.prompt}</pre>
      </details>
    </section>
  );
}

function maskCountsText(counts: AnalysisPreviewView["maskCounts"]): string {
  const entries = Object.entries(counts).filter(([, count]) => (count ?? 0) > 0);
  return `가린 것: ${entries.length === 0 ? "없음" : entries.map(([kind, count]) => `${kind} ${count}`).join(" · ")}`;
}

function PreviewBlock({ incidentId, view }: { incidentId: string; view: AnalysisPreviewView }) {
  return (
    <section className={styles.section} aria-labelledby="analysis-preview">
      <h2 id="analysis-preview" className={styles.sectionTitle}>{INCIDENT_ANALYSIS_TEXT.previewTitle}</h2>
      <p className={styles.meta}>{`${view.bytes}바이트 · ${view.characters}자`}</p>
      {view.reductions.length > 0 && <ul className={styles.evidenceList}>{view.reductions.map((reduction) => <li key={reduction} className={styles.muted}>{reduction}</li>)}</ul>}
      <p className={styles.muted}>{maskCountsText(view.maskCounts)}</p>
      <pre className={styles.sentText}>{view.prompt}</pre>
      <form method="post" action={INCIDENT_ANALYSIS_START_PATH}>
        <input type="hidden" name="incident" value={incidentId} />
        <input type="hidden" name="preview" value={view.token} />
        <input type="hidden" name="prompt" value={view.prompt} />
        <button type="submit" className={styles.send}>{INCIDENT_ANALYSIS_TEXT.send}</button>
      </form>
    </section>
  );
}

function ScreenBody({ data }: { data: IncidentAnalysisScreenData }) {
  const { incident, history, preview } = data;
  const entries = history.ok ? history.entries : [];
  const running = entries.some((entry) => entry.kind === "attempt" && entry.status === "running");
  const canRequest = incident.state === "open" && history.ok && !running;
  return (
    <>
      {running && <meta httpEquiv="refresh" content={String(INCIDENT_ANALYSIS_REFRESH_SECONDS)} />}
      <p className={styles.meta}>
        조회 시각(KST) <KoreanTime value={data.checkedAt} /> · <a href={incidentHref(data.incidentId)}>{INCIDENT_ANALYSIS_TEXT.toIncident}</a>
      </p>
      {incident.state === "open" && <p><strong>{`${incident.kindLabel} — ${incident.target}`}</strong></p>}
      {incident.state === "closed" && <p className={styles.failure}>{INCIDENT_ANALYSIS_TEXT.closed}</p>}
      {incident.state === "unchecked" && <p className={styles.failure}>{INCIDENT_ANALYSIS_TEXT.unchecked}</p>}
      <p className={styles.note} role="note">{INCIDENT_ANALYSIS_TEXT.disclaimer}</p>
      {!history.ok && <p className={styles.failure}>{history.reason === "store_unavailable" ? INCIDENT_ANALYSIS_TEXT.storeUnavailable : INCIDENT_ANALYSIS_TEXT.notConfigured}</p>}
      {canRequest && preview === null && <p><a href={incidentAnalysisHref(data.incidentId, true)}>{INCIDENT_ANALYSIS_TEXT.requestLink}</a></p>}
      {preview !== null && preview.kind === "ready" && <PreviewBlock incidentId={data.incidentId} view={preview.view} />}
      {preview !== null && preview.kind === "unavailable" && <p className={styles.failure}>{preview.text}</p>}
      {history.ok && entries.length === 0 && <p className={parts.empty}>{INCIDENT_ANALYSIS_TEXT.noAnalysis}</p>}
      {entries.map((entry, index) => <EntryBlock key={entry.kind === "attempt" ? entry.attempt.requestId : `unreadable-${index}`} entry={entry} />)}
    </>
  );
}

export function IncidentAnalysisScreen({ outcome }: { outcome: IncidentAnalysisScreenOutcome }): ReactNode {
  return (
    <main className={styles.main}>
      <div className={parts.heading}>
        <h1 className={parts.title}>{INCIDENT_ANALYSIS_TEXT.title}</h1>
      </div>
      {outcome.kind === "invalid_input" ? (
        <div className={parts.problem} role="alert">
          <p className={parts.problemTitle}>{UPSTREAM_FAILURE_MESSAGES.invalid_input}</p>
          <p className={parts.problemDetail}>문제의 식별자가 맞지 않습니다 — 목록에서 다시 고르세요. <a href={INCIDENTS_PATH}>{INCIDENT_ANALYSIS_TEXT.toIncident}</a></p>
        </div>
      ) : <ScreenBody data={outcome.data} />}
    </main>
  );
}
