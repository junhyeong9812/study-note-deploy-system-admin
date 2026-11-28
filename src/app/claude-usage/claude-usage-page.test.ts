/** Claude 사용량 화면(/claude-usage) — 실제 렌더(서버 컴포넌트 → HTML). 진입 함수와 전역 fetch(가짜 실행 자리)를 거쳐 본다.
 * 명세 §1("사용량을 측정하고, 어드민 화면에서 보고 제한할 수 있게") · §2(상한 · 켬/끔 · 바꾼 사람 · 시각) · §14.
 * - 세 칸(실행 자리 상태 · 사용량 · 상한)과 최근 호출 — 한 칸이 실패해도 다른 칸은 그대로, 실패한 칸은 "지금 읽지 못했습니다"(0 으로 메우지 않는다).
 * - 상한 대비 · 상한에 닿음 · 꺼짐 · 헬스의 세 상태 · 접근성(표의 머리 · 단추 · 칸의 이름 · role) · 스크립트 없이 쓰는 폼.
 * - 비밀값 · 실행 자리의 주소 · 머리글 이름은 HTML · 화면 데이터 어디에도 없다. 세션이 없으면 실행 자리를 부르지 않는다. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("@/features/auth/server/temporary-restriction-status", () => ({ isTemporaryRestrictionActive: () => false }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookieValue !== undefined && name === "admin_session" ? { name, value: state.cookieValue } : undefined),
    has: () => state.cookieValue !== undefined,
    getAll: () => [],
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw new Error(`redirect:${location}`); } }));

import ClaudeUsagePage from "@/app/claude-usage/page";
import { GET as claudeUsageGet } from "@/app/api/claude-usage/route";
import { issueSessionToken } from "@/features/auth/lib/session";
import { FAKE_ORIGIN, FAKE_SIGNING_KEY } from "@/features/auth/lib/test-fakes";
import {
  CLAUDE_FORBIDDEN_IN_RESULTS, FAKE_CLAUDE_RUNNER_SETTINGS_SECRET, FAKE_CLAUDE_RUNNER_URL, createFakeClaudeRunner, defaultRunnerLimits, runnerCall,
  runnerUsageData, useTwoPurposes, type FakeClaudeRunner,
} from "@/features/claude-usage/lib/claude-runner-test-fakes";
import { UPSTREAM_FAILURE_MESSAGES } from "@/shared/lib/upstream-result";
import { expectNoForbiddenText, jsonBody, leakyErrorBody, leakyNetworkError, textResponse } from "@/shared/lib/upstream-test-fakes";

let runner: FakeClaudeRunner;

async function render(): Promise<string> {
  const element = await ClaudeUsagePage();
  const rendererModuleName = "react-dom/server";
  const renderer = (await import(/* @vite-ignore */ rendererModuleName)) as { renderToStaticMarkup: (node: unknown) => string };
  return renderer.renderToStaticMarkup(element);
}

function textOf(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'");
}

type SectionKey = "health" | "usage" | "recent" | "limits";

/** 한 칸(section) — aria-labelledby="claude-<칸>-title" 의 section 안(제목 h2 의 id 가 그 이름). */
function section(html: string, key: SectionKey): string {
  const match = new RegExp(`<section[^>]*aria-labelledby="claude-${key}-title"[^>]*>([\\s\\S]*?)</section>`).exec(html);
  expect(match, `${key} 칸이 없다`).not.toBeNull();
  expect(match![1], `${key} 칸의 제목`).toMatch(new RegExp(`<h2[^>]*id="claude-${key}-title"`));
  return match![1];
}

/** 사용량 표의 한 줄 — 머리 칸(th scope=row)의 글로 찾아, 그 줄의 td 글들. */
function usageRow(fragment: string, rowTitle: string): string[] {
  const rows = [...fragment.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
  const row = rows.find((each) => {
    const head = /<th[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/.exec(each);
    return head !== null && textOf(head[1]).trim() === rowTitle;
  });
  expect(row, `${rowTitle} 줄이 없다`).toBeDefined();
  return [...row!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => textOf(match[1]).trim());
}

function columnHeads(fragment: string): string[] {
  return [...fragment.matchAll(/<th[^>]*scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((match) => textOf(match[1]).trim());
}

function readFailureText(reason: keyof typeof UPSTREAM_FAILURE_MESSAGES): string {
  return `지금 읽지 못했습니다 — ${UPSTREAM_FAILURE_MESSAGES[reason]}`;
}

/** role="alert" 인 요소의 글. */
function alerts(fragment: string): string[] {
  return [...fragment.matchAll(/<(p|div)[^>]*role="alert"[^>]*>([\s\S]*?)<\/\1>/g)].map((match) => textOf(match[2]).trim());
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", FAKE_SIGNING_KEY);
  vi.stubEnv("ADMIN_ORIGIN", FAKE_ORIGIN);
  vi.stubEnv("LOG_REDIS_URL", "");
  vi.stubEnv("CLAUDE_RUNNER_URL", FAKE_CLAUDE_RUNNER_URL);
  vi.stubEnv("CLAUDE_RUNNER_SETTINGS_SECRET", FAKE_CLAUDE_RUNNER_SETTINGS_SECRET);
  state.cookieValue = issueSessionToken(FAKE_SIGNING_KEY, Date.now() - 60_000);
  runner = createFakeClaudeRunner();
  vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== new URL(FAKE_CLAUDE_RUNNER_URL).origin) throw new Error(`unexpected upstream ${url.hostname}`);
    return runner.fetch(String(input), init);
  }));
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

describe("정상 — 세 칸과 최근 호출", () => {
  it("제목 · 새로 고침 링크 · 칸 넷 · 내비게이션의 이 화면(지금 화면 표시)", async () => {
    const html = await render();
    expect(html).toContain(">Claude 사용량</h1>");
    expect(html).toMatch(/<a[^>]*href="\/claude-usage"[^>]*>지금 새로 고침<\/a>/);
    for (const key of ["health", "usage", "recent", "limits"] as const) section(html, key);
    expect(html).toMatch(/<a[^>]*href="\/claude-usage"[^>]*aria-current="page"[^>]*>Claude 사용량<\/a>/);
  });

  it("실행 자리 상태 — 정상", async () => {
    const health = section(await render(), "health");
    expect(textOf(health)).toContain("정상");
    expect(alerts(health)).toEqual([]);
  });

  it("사용량 표 — 열 머리(scope=col) · 전체와 용도의 줄(scope=row) · 오늘과 최근 한 시간의 '건수 / 상한' · 여유", async () => {
    runner.counts = { total: { today: 7, last_hour: 2 }, purposes: { chat: { today: 6, last_hour: 1 } } };
    runner.limits = defaultRunnerLimits({ total: { per_day: 40, per_hour: 12 }, purposes: { chat: { per_day: 25, per_hour: 8 } } });
    const usage = section(await render(), "usage");
    expect(usage).toContain("<table");
    expect(columnHeads(usage)).toEqual(["범위", "오늘(서울 자정부터)", "최근 한 시간", "상태"]);
    expect(usageRow(usage, "전체")).toEqual(["7 / 40", "2 / 12", "여유"]);
    expect(usageRow(usage, "채팅 (chat)")).toEqual(["6 / 25", "1 / 8", "여유"]);
    expect(alerts(usage)).toEqual([]);
  });

  it("최근 호출 표 — 시각 · 용도 · 결과 · 걸린 시간 · 토큰(입력 · 출력), 토큰을 모르면 —", async () => {
    runner.recent = [
      runnerCall({ started_at: "2026-11-26T13:05:00+09:00", duration_ms: 8123 }),
      runnerCall({ request_id: "req-124", result: "limit_reached", duration_ms: 0, usage: null }),
    ];
    const recent = section(await render(), "recent");
    expect(columnHeads(recent)).toEqual(["시각", "용도", "결과", "걸린 시간", "토큰"]);
    const rows = [...recent.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => textOf(cell[1]).trim()))
      .filter((cells) => cells.length > 0);
    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toContain("13:05");
    expect(rows[0].slice(1)).toEqual(["chat", "succeeded", "8.1초", "입력 11 · 출력 22"]);
    expect(rows[1].slice(1, 3)).toEqual(["chat", "limit_reached"]);
    expect(rows[1][4]).toBe("—");
  });

  it("최근 호출이 없으면 '아직 호출이 없습니다'(빈 표가 아니다)", async () => {
    runner.recent = [];
    const recent = section(await render(), "recent");
    expect(textOf(recent)).toContain("아직 호출이 없습니다");
    expect(recent).not.toContain("<table");
  });

  it("상한 — 지금 값 · 켜짐 · 바꾼 적 없음", async () => {
    const limits = textOf(section(await render(), "limits"));
    expect(limits).toContain("켜짐");
    expect(limits).toContain("아직 바꾼 적 없음");
  });

  it("상한 — 마지막으로 바꾼 사람과 시각", async () => {
    runner.limits = defaultRunnerLimits({ changed_at: "2026-11-26T12:34:56+09:00", changed_by: "admin:fake-admin-id-zq" });
    const limits = textOf(section(await render(), "limits"));
    expect(limits).toContain("admin:fake-admin-id-zq");
    expect(limits).toContain("12:34");
    expect(limits).not.toContain("아직 바꾼 적 없음");
  });
});

describe("상한을 바꾸는 폼 — 스크립트 없이 보낸다", () => {
  it("POST /api/claude-usage/limits · 지금 값으로 채운 수의 칸 넷(0~1000 정수) · 켬/끔 · 이름 있는 단추 · 비밀번호 칸은 없다(넓히면 다음 화면에서 — §16)", async () => {
    runner.limits = defaultRunnerLimits({ total: { per_day: 40, per_hour: 12 }, purposes: { chat: { per_day: 25, per_hour: 8 } } });
    const limits = section(await render(), "limits");
    const forms = [...limits.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)];
    expect(forms).toHaveLength(1);
    const [, attributes, body] = forms[0];
    expect(attributes).toMatch(/method="post"/i);
    expect(attributes).toContain('action="/api/claude-usage/limits"');
    const expected: [string, string][] = [["total_per_day", "40"], ["total_per_hour", "12"], ["purpose_chat_per_day", "25"], ["purpose_chat_per_hour", "8"]];
    for (const [name, value] of expected) {
      const input = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(body)?.[0];
      expect(input, `${name} 칸`).toBeDefined();
      expect(input).toContain(`value="${value}"`);
      expect(input).toContain('type="number"');
      expect(input).toContain('min="0"');
      expect(input).toContain('max="1000"');
      expect(input).toContain('step="1"');
      const id = /id="([^"]+)"/.exec(input!)?.[1];
      expect(id, `${name} 의 id`).toBeDefined();
      expect(body, `${name} 의 label`).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>[^<]+`));
    }
    const radios = [...body.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((match) => match[0]);
    expect(radios).toHaveLength(2);
    expect(radios.every((radio) => radio.includes('name="enabled"'))).toBe(true);
    const onRadio = radios.find((radio) => radio.includes('value="true"'))!;
    const offRadio = radios.find((radio) => radio.includes('value="false"'))!;
    expect(onRadio).toMatch(/checked/);
    expect(offRadio).not.toMatch(/checked/);
    for (const radio of [onRadio, offRadio]) expect(body).toMatch(new RegExp(`<label[^>]*for="${/id="([^"]+)"/.exec(radio)![1]}"`));
    expect(body).not.toMatch(/<input[^>]*type="password"/);
    expect(body).toMatch(/<button[^>]*type="submit"[^>]*>상한 바꾸기<\/button>/);
    // 폼에는 '지금 값'이나 바꾼 사람을 싣는 칸이 없다 — 서버가 다시 읽고, 서버가 정한다
    const names = [...body.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(names)).toEqual(new Set(["enabled", "total_per_day", "total_per_hour", "purpose_chat_per_day", "purpose_chat_per_hour"]));
  });

  it("꺼져 있으면 '끔'이 골라져 있다", async () => {
    runner.limits = defaultRunnerLimits({ enabled: false });
    const limits = section(await render(), "limits");
    const offRadio = /<input[^>]*type="radio"[^>]*value="false"[^>]*>|<input[^>]*value="false"[^>]*type="radio"[^>]*>/.exec(limits)?.[0];
    expect(offRadio).toMatch(/checked/);
    expect(textOf(limits)).toContain("꺼짐");
  });

  it("단추 곁에 '올리거나 켜면 다음 화면에서 비밀번호를 다시 확인합니다' 안내", async () => {
    expect(textOf(section(await render(), "limits"))).toContain("상한을 올리거나 켜면 다음 화면에서 비밀번호를 다시 확인합니다");
  });
});

describe("용도의 목록은 실행 자리의 응답에서 — 어드민에 박지 않는다", () => {
  it("용도 둘(chat · analysis) — 사용량 표 세 줄(전체 · 채팅 (chat) · analysis) · 모르는 이름은 이름 그대로", async () => {
    useTwoPurposes(runner, { analysis: { per_day: 2, per_hour: 2 } });
    const usage = section(await render(), "usage");
    const rowHeads = [...usage.matchAll(/<th[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/g)].map((match) => textOf(match[1]).trim());
    expect(rowHeads).toEqual(["전체", "채팅 (chat)", "analysis"]);
    expect(usageRow(usage, "전체")).toEqual(["5 / 30", "2 / 10", "여유"]);
    expect(usageRow(usage, "채팅 (chat)")).toEqual(["3 / 30", "1 / 10", "여유"]);
    expect(usageRow(usage, "analysis")).toEqual(["2 / 2", "1 / 2", "상한에 닿음"]);
  });

  it("용도 둘 — 폼의 수의 칸 여섯(용도마다 둘, 지금 값으로 채움 · label 이 있다)", async () => {
    useTwoPurposes(runner);
    const limits = section(await render(), "limits");
    const body = /<form[^>]*>([\s\S]*?)<\/form>/.exec(limits)![1];
    const numberInputs = [...body.matchAll(/<input[^>]*type="number"[^>]*>/g)].map((match) => match[0]);
    expect(numberInputs.map((input) => /name="([^"]+)"/.exec(input)![1])).toEqual([
      "total_per_day", "total_per_hour", "purpose_chat_per_day", "purpose_chat_per_hour", "purpose_analysis_per_day", "purpose_analysis_per_hour",
    ]);
    const analysisDay = numberInputs.find((input) => input.includes('name="purpose_analysis_per_day"'))!;
    expect(analysisDay).toContain('value="6"');
    expect(body).toMatch(new RegExp(`<label[^>]*for="${/id="([^"]+)"/.exec(analysisDay)![1]}"`));
    expect(textOf(body)).toContain("analysis");
  });

  it("/usage 와 /limits 의 용도가 서로 다르면 각 칸은 자기 응답대로(맞추지 않는다 · 실패로 보지 않는다)", async () => {
    runner.limits = defaultRunnerLimits({ purposes: { chat: { per_day: 30, per_hour: 10 }, analysis: { per_day: 6, per_hour: 2 } } });
    runner.override["GET /usage"] = () => jsonBody({ success: true, data: runnerUsageData(defaultRunnerLimits(), runner.counts, []) });
    const html = await render();
    const usage = section(html, "usage");
    expect(alerts(usage)).toEqual([]);
    expect(textOf(usage)).not.toContain("analysis");
    const limits = section(html, "limits");
    expect(alerts(limits)).toEqual([]);
    expect(limits).toContain('name="purpose_analysis_per_day"');
  });

  it("chat 이 없는 실행 자리도 그린다 — 그 용도의 줄 · 칸만", async () => {
    runner.limits = defaultRunnerLimits({ purposes: { analysis: { per_day: 6, per_hour: 2 } } });
    runner.counts = { total: { today: 1, last_hour: 1 }, purposes: { analysis: { today: 1, last_hour: 1 } } };
    const html = await render();
    const usage = section(html, "usage");
    expect(usageRow(usage, "analysis")).toEqual(["1 / 6", "1 / 2", "여유"]);
    expect(usage).not.toContain("채팅");
    expect(section(html, "limits")).not.toContain("purpose_chat_");
  });

  it("꼴 밖의 용도 이름(태그)은 화면에 싣지 않고 그 칸을 '읽지 못했습니다'로", async () => {
    runner.limits = defaultRunnerLimits({ purposes: { chat: { per_day: 30, per_hour: 10 }, "<img src=x onerror=alert(1)>": { per_day: 1, per_hour: 1 } } });
    const html = await render();
    expect(alerts(section(html, "limits"))).toEqual([readFailureText("unparseable")]);
    expect(alerts(section(html, "usage"))).toEqual([readFailureText("unparseable")]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });
});

describe("상한에 닿음 · 꺼짐", () => {
  it.each([
    ["오늘이 하루 상한과 같음", { today: 30, last_hour: 1 }],
    ["최근 한 시간이 한 시간 상한과 같음", { today: 5, last_hour: 10 }],
  ] as const)("%s → 그 줄의 상태 '상한에 닿음'", async (_label, counts) => {
    runner.counts = { total: { ...counts }, purposes: { chat: { today: 0, last_hour: 0 } } };
    const usage = section(await render(), "usage");
    expect(usageRow(usage, "전체")[2]).toBe("상한에 닿음");
    expect(usageRow(usage, "채팅 (chat)")[2]).toBe("여유");
  });

  it("상한이 0 이면 0 건이어도 상한에 닿음", async () => {
    runner.limits = defaultRunnerLimits({ purposes: { chat: { per_day: 0, per_hour: 10 } } });
    runner.counts = { total: { today: 0, last_hour: 0 }, purposes: { chat: { today: 0, last_hour: 0 } } };
    const usage = section(await render(), "usage");
    expect(usageRow(usage, "채팅 (chat)")).toEqual(["0 / 0", "0 / 10", "상한에 닿음"]);
    expect(usageRow(usage, "전체")[2]).toBe("여유");
  });

  it("꺼져 있으면 모든 줄의 상태가 '꺼짐' · 칸 위에 'Claude 를 부르지 않습니다' 알림", async () => {
    runner.limits = defaultRunnerLimits({ enabled: false });
    const usage = section(await render(), "usage");
    expect(usageRow(usage, "전체")[2]).toBe("꺼짐");
    expect(usageRow(usage, "채팅 (chat)")[2]).toBe("꺼짐");
    expect(usage).toMatch(/role="status"[^>]*>[^<]*꺼져 있음 — Claude 를 부르지 않습니다/);
  });
});

describe("실행 자리 헬스의 상태를 글로", () => {
  it.each([
    ["token_missing", "구독 토큰이 없습니다"],
    ["claude_unavailable", "claude 실행 파일을 쓸 수 없습니다"],
    ["ledger_unavailable", "사용량 장부를 읽거나 쓸 수 없습니다"],
  ] as const)("%s → role=alert '%s (%s)'", async (status, words) => {
    runner.healthStatus = status;
    const health = section(await render(), "health");
    expect(alerts(health)).toEqual([`${words} (${status})`]);
    expect(textOf(health)).not.toContain("정상");
  });
});

describe("칸마다 — 한 칸이 실패해도 다른 칸은 그대로, 실패한 칸은 '지금 읽지 못했습니다'(0 으로 메우지 않는다)", () => {
  const usageFailures: [string, () => Response | Promise<Response>, keyof typeof UPSTREAM_FAILURE_MESSAGES][] = [
    ["401", () => jsonBody({ success: false, error: { code: "unauthorized" } }, 401), "unauthorized"],
    ["503 ledger_unavailable", () => textResponse(leakyErrorBody(), 503), "unavailable"],
    ["연결 실패", () => Promise.reject(leakyNetworkError()), "unreachable"],
    ["꼴이 틀림(건수 없음)", () => jsonBody({ success: true, data: { enabled: true, total: { per_day: 30, per_hour: 10 }, purposes: {}, recent: [] } }), "unparseable"],
  ];
  for (const [label, respond, reason] of usageFailures) {
    it(`사용량 ${label} → 사용량 · 최근 호출 칸만 '${readFailureText(reason)}' · 표 없음 · 상한 · 헬스는 그대로`, async () => {
      runner.override["GET /usage"] = () => respond();
      const html = await render();
      const usage = section(html, "usage");
      expect(alerts(usage)).toEqual([readFailureText(reason)]);
      expect(usage).not.toContain("<table");
      expect(textOf(usage)).not.toMatch(/\d+\s*\/\s*\d+/);
      expect(textOf(usage)).not.toContain("여유");
      const recent = section(html, "recent");
      expect(alerts(recent)).toEqual([readFailureText(reason)]);
      expect(textOf(recent)).not.toContain("아직 호출이 없습니다");
      const limits = section(html, "limits");
      expect(alerts(limits)).toEqual([]);
      expect(limits).toContain("<form");
      expect(textOf(section(html, "health"))).toContain("정상");
      expectNoForbiddenText(html, CLAUDE_FORBIDDEN_IN_RESULTS);
    });
  }

  it("상한만 실패(503) → 상한 칸만 알림 · 폼 없음(지금 값 없이 채운 폼을 보이지 않는다) · 사용량은 그대로", async () => {
    runner.override["GET /limits"] = () => jsonBody({ success: false, error: { code: "limits_unavailable" } }, 503);
    const html = await render();
    const limits = section(html, "limits");
    expect(alerts(limits)).toEqual([readFailureText("unavailable")]);
    expect(limits).not.toContain("<form");
    expect(usageRow(section(html, "usage"), "전체")).toEqual(["3 / 30", "1 / 10", "여유"]);
  });

  it("헬스만 실패 → 헬스 칸만 알림", async () => {
    runner.override["GET /health"] = () => Promise.reject(leakyNetworkError());
    const html = await render();
    expect(alerts(section(html, "health"))).toEqual([readFailureText("unreachable")]);
    expect(alerts(section(html, "usage"))).toEqual([]);
    expect(section(html, "limits")).toContain("<form");
  });

  it("실행 자리가 통째로 죽음 → 칸 넷 모두 알림 · 화면은 뜨고 내비게이션 · 로그아웃은 그대로", async () => {
    runner.fetch.mockImplementation(() => Promise.reject(leakyNetworkError()));
    const html = await render();
    for (const key of ["health", "usage", "recent", "limits"] as const) expect(alerts(section(html, key))).toEqual([readFailureText("unreachable")]);
    expect(html).toMatch(/<a[^>]*href="\/deploys"/);
    expect(html).toContain("로그아웃");
    expectNoForbiddenText(html, CLAUDE_FORBIDDEN_IN_RESULTS);
  });

  it("설정이 없으면(주소 · 비밀값 빈 값) 실행 자리를 부르지 않고 칸 넷 모두 '설정 없음'", async () => {
    vi.stubEnv("CLAUDE_RUNNER_URL", "");
    vi.stubEnv("CLAUDE_RUNNER_SETTINGS_SECRET", "");
    const html = await render();
    for (const key of ["health", "usage", "recent", "limits"] as const) expect(alerts(section(html, key))).toEqual([readFailureText("not_configured")]);
    expect(runner.fetch).not.toHaveBeenCalled();
  });

  it("주소가 http(s) 가 아니면 설정 없음 — 부르지 않는다", async () => {
    vi.stubEnv("CLAUDE_RUNNER_URL", "ftp://claude-runner.example.test");
    const html = await render();
    expect(alerts(section(html, "usage"))).toEqual([readFailureText("not_configured")]);
    expect(runner.fetch).not.toHaveBeenCalled();
  });

  it("비밀값만 비면 헬스는 읽고(인증 없음) 사용량 · 상한은 설정 없음", async () => {
    vi.stubEnv("CLAUDE_RUNNER_SETTINGS_SECRET", "");
    const html = await render();
    expect(textOf(section(html, "health"))).toContain("정상");
    expect(alerts(section(html, "usage"))).toEqual([readFailureText("not_configured")]);
    expect(alerts(section(html, "limits"))).toEqual([readFailureText("not_configured")]);
    expect(runner.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /health"]);
  });
});

describe("비밀값 · 주소 · 스크립트", () => {
  it("HTML 에 설정용 비밀값 · 실행 자리의 주소 · 머리글 이름이 없고, 화면이 더한 <script> 가 없다", async () => {
    runner.recent = [runnerCall({ request_id: "<script>alert(1)</script>", purpose: "<img src=x>" })];
    const html = await render();
    expectNoForbiddenText(html, CLAUDE_FORBIDDEN_IN_RESULTS);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toMatch(/\son[a-z]+="/i);
  });
});

describe("세션 — 없으면 로그인으로, 실행 자리를 부르지 않는다", () => {
  it("화면 → redirect:/login · 실행 자리 호출 0", async () => {
    state.cookieValue = undefined;
    await expect(render()).rejects.toThrow("redirect:/login");
    expect(runner.fetch).not.toHaveBeenCalled();
  });

  it("GET /api/claude-usage → 401 · 실행 자리 호출 0", async () => {
    state.cookieValue = undefined;
    const response = await claudeUsageGet(new Request(new URL("/api/claude-usage", FAKE_ORIGIN)));
    expect(response.status).toBe(401);
    expect(runner.fetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/claude-usage — 화면 데이터(JSON)", () => {
  it("200 · no-store · 세 칸의 결과 · 비밀값 · 주소 없음", async () => {
    const response = await claudeUsageGet(new Request(new URL("/api/claude-usage", FAKE_ORIGIN)));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const text = await response.text();
    expectNoForbiddenText(text, CLAUDE_FORBIDDEN_IN_RESULTS);
    const body = JSON.parse(text) as { success: boolean; data: Record<string, { ok: boolean; value?: unknown }> };
    expect(body.success).toBe(true);
    expect(body.data.health).toEqual({ ok: true, value: { status: "ok" } });
    expect(body.data.usage).toMatchObject({ ok: true, value: { total: { today: 3, lastHour: 1, perDay: 30, perHour: 10 } } });
    expect(body.data.limits).toMatchObject({ ok: true, value: { enabled: true, changedBy: null } });
  });

  it("사용량을 읽지 못하면 그 칸은 실패(값 없음) — 0 으로 메우지 않는다", async () => {
    runner.override["GET /usage"] = () => textResponse(leakyErrorBody(), 503);
    const body = await (await claudeUsageGet(new Request(new URL("/api/claude-usage", FAKE_ORIGIN)))).json() as { data: Record<string, Record<string, unknown>> };
    expect(body.data.usage).toEqual({ ok: false, reason: "unavailable", status: 503, message: UPSTREAM_FAILURE_MESSAGES.unavailable });
    expect(body.data.limits.ok).toBe(true);
  });
});
