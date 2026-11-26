/** 상한 폼의 해석과 "올림"의 판정(명세 §14 — 상한을 올리거나 꺼 둔 것을 켜는 변경만 비밀번호를 다시 확인한다).
 * 용도의 목록은 어드민에 박지 않는다 — 실행 자리의 응답에서 온다(꼴: 1~8개 · ^[a-z][a-z0-9_]{0,31}$ · 중복 없음).
 * 폼은 칸마다 정확히 하나 · 닫힌 칸 목록 = 고정 칸 + 서버가 다시 읽은 지금 상한의 용도마다 두 칸 · 수는 10진 정수 0~1000(실행 자리가 받는 범위). */
import { describe, expect, it } from "vitest";
import {
  CLAUDE_LIMIT_MAXIMUM, CLAUDE_PURPOSES_MAXIMUM, claudeLimitFieldName, claudePurposeTitle, isClaudePurposeList, isRaisingChange, parseClaudeLimitsForm,
  type ClaudeLimitsChange,
} from "@/features/claude-usage/lib/claude-limits";

function formFields(overrides: Record<string, string | string[] | null> = {}): URLSearchParams {
  const base: Record<string, string | string[] | null> = {
    enabled: "true", total_per_day: "30", total_per_hour: "10", purpose_chat_per_day: "20", purpose_chat_per_hour: "5", password: "",
    ...overrides,
  };
  const fields = new URLSearchParams();
  for (const [name, value] of Object.entries(base)) {
    if (value === null) continue;
    for (const each of Array.isArray(value) ? value : [value]) fields.append(name, each);
  }
  return fields;
}

const CHAT = ["chat"] as const;
const TWO = ["chat", "analysis"] as const;

type ChangeValues = { enabled: boolean; totalDay: number; totalHour: number; chatDay: number; chatHour: number; analysisDay?: number; analysisHour?: number };

/** analysisDay · analysisHour 를 주면 용도 둘(chat · analysis). */
function change(overrides: Partial<ChangeValues> = {}): ClaudeLimitsChange {
  const values: ChangeValues = { enabled: true, totalDay: 30, totalHour: 10, chatDay: 30, chatHour: 10, ...overrides };
  const purposes: ClaudeLimitsChange["purposes"] = { chat: { perDay: values.chatDay, perHour: values.chatHour } };
  if (values.analysisDay !== undefined || values.analysisHour !== undefined) purposes.analysis = { perDay: values.analysisDay ?? 6, perHour: values.analysisHour ?? 2 };
  return { enabled: values.enabled, total: { perDay: values.totalDay, perHour: values.totalHour }, purposes };
}

describe("용도 목록의 꼴 · 이름 · 칸 이름", () => {
  it("상한의 위쪽은 1000 · 용도는 8개까지", () => {
    expect(CLAUDE_LIMIT_MAXIMUM).toBe(1000);
    expect(CLAUDE_PURPOSES_MAXIMUM).toBe(8);
  });

  it.each([
    [["chat"]], [["chat", "analysis"]], [["a"]], [["study_2"]], [["a".repeat(32)]], [["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]],
  ] as [string[]][])("%j → 받는다", (names) => {
    expect(isClaudePurposeList(names)).toBe(true);
  });

  it.each([
    ["빈 목록", []], ["9개", ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]], ["중복", ["chat", "chat"]],
    ["대문자", ["Chat"]], ["숫자로 시작", ["1chat"]], ["밑줄로 시작", ["_chat"]], ["33자", ["a".repeat(33)]], ["하이픈", ["chat-2"]],
    ["태그", ["<script>"]], ["공백", ["chat "]], ["빈 이름", [""]], ["한글", ["채팅"]],
  ] as [string, string[]][])("%s → 거절", (_label, names) => {
    expect(isClaudePurposeList(names)).toBe(false);
  });

  it("화면의 이름 — 알려진 이름은 한국어 이름을 붙이고, 모르는 이름은 그대로", () => {
    expect(claudePurposeTitle("chat")).toBe("채팅 (chat)");
    expect(claudePurposeTitle("analysis")).toBe("analysis");
    expect(claudePurposeTitle("toString")).toBe("toString");   // 객체의 물려받은 이름에 걸리지 않는다
  });

  it("칸 이름 — total_per_day · total_per_hour · purpose_<용도>_per_day · purpose_<용도>_per_hour", () => {
    expect(claudeLimitFieldName("total", "perDay")).toBe("total_per_day");
    expect(claudeLimitFieldName("total", "perHour")).toBe("total_per_hour");
    expect(claudeLimitFieldName({ purpose: "chat" }, "perDay")).toBe("purpose_chat_per_day");
    expect(claudeLimitFieldName({ purpose: "analysis" }, "perHour")).toBe("purpose_analysis_per_hour");
  });
});

describe("parseClaudeLimitsForm — 맞는 폼", () => {
  it("여섯 칸을 바꾸려는 값으로 · 비밀번호는 그대로", () => {
    expect(parseClaudeLimitsForm(formFields({ password: "pw-xq7" }), CHAT)).toEqual({
      ok: true, password: "pw-xq7",
      change: { enabled: true, total: { perDay: 30, perHour: 10 }, purposes: { chat: { perDay: 20, perHour: 5 } } },
    });
  });

  it("enabled=false 는 끔", () => {
    const result = parseClaudeLimitsForm(formFields({ enabled: "false" }), CHAT);
    expect(result.ok && result.change.enabled).toBe(false);
  });

  it("비밀번호 칸이 없어도 · 비어도 받는다(빈 글자)", () => {
    for (const fields of [formFields({ password: null }), formFields({ password: "" })]) {
      const result = parseClaudeLimitsForm(fields, CHAT);
      expect(result).toMatchObject({ ok: true, password: "" });
    }
  });

  it.each([["0", 0], ["1000", 1000], ["007", 7]])("수 %j → %d(경계 안 · 앞의 0 허용)", (text, value) => {
    const result = parseClaudeLimitsForm(formFields({ total_per_day: text }), CHAT);
    expect(result.ok && result.change.total.perDay).toBe(value);
  });
});

describe("parseClaudeLimitsForm — 수의 칸이 틀리면 invalid_value(그 칸 이름)", () => {
  it.each([
    ["1001", "total_per_day"], ["-1", "total_per_hour"], ["1.5", "purpose_chat_per_day"], ["", "purpose_chat_per_hour"],
    [" 5", "total_per_day"], ["1e2", "total_per_day"], ["٣", "total_per_day"], ["10000", "total_per_hour"], ["0x10", "total_per_day"],
  ])("%j 를 %s 에", (text, field) => {
    expect(parseClaudeLimitsForm(formFields({ [field]: text }), CHAT)).toEqual({ ok: false, reason: "invalid_value", field });
  });
});

describe("parseClaudeLimitsForm — 꼴이 틀리면 malformed", () => {
  it.each([
    ["enabled 없음", { enabled: null }],
    ["enabled 가 on", { enabled: "on" }],
    ["enabled 가 True", { enabled: "True" }],
    ["수의 칸 하나 없음", { purpose_chat_per_hour: null }],
    ["같은 칸이 둘", { total_per_day: ["30", "40"] }],
    ["비밀번호가 둘", { password: ["a", "b"] }],
    ["비밀번호 1025자", { password: "p".repeat(1025) }],
    ["지금 상한에 없는 용도의 칸", { purpose_study_per_day: "5", purpose_study_per_hour: "1" }],
    ["브라우저가 보낸 '지금 값' 칸", { current_total_per_day: "1000" }],
    ["바꾼 사람 칸", { changed_by: "someone-else" }],
  ] as [string, Record<string, string | string[] | null>][])("%s", (_label, overrides) => {
    expect(parseClaudeLimitsForm(formFields(overrides), CHAT)).toEqual({ ok: false, reason: "malformed" });
  });

  it("비밀번호 1024자는 받는다", () => {
    expect(parseClaudeLimitsForm(formFields({ password: "p".repeat(1024) }), CHAT).ok).toBe(true);
  });
});

describe("parseClaudeLimitsForm — 칸의 목록은 지금 상한의 용도에서(어드민에 박지 않는다)", () => {
  const twoFields = (overrides: Record<string, string | string[] | null> = {}) =>
    formFields({ purpose_analysis_per_day: "6", purpose_analysis_per_hour: "2", ...overrides });

  it("용도 둘 — 여섯 수의 칸을 받는다(용도의 차례는 지금 상한의 차례)", () => {
    const result = parseClaudeLimitsForm(twoFields(), TWO);
    expect(result).toEqual({
      ok: true, password: "",
      change: { enabled: true, total: { perDay: 30, perHour: 10 }, purposes: { chat: { perDay: 20, perHour: 5 }, analysis: { perDay: 6, perHour: 2 } } },
    });
    expect(result.ok && Object.keys(result.change.purposes)).toEqual(["chat", "analysis"]);
  });

  it("용도 하나만 아는 폼은 받지 않는다 — 지금 상한의 용도(analysis)가 빠지면 malformed(일부만 바꾸지 않는다)", () => {
    expect(parseClaudeLimitsForm(formFields(), TWO)).toEqual({ ok: false, reason: "malformed" });
    expect(parseClaudeLimitsForm(twoFields({ purpose_analysis_per_hour: null }), TWO)).toEqual({ ok: false, reason: "malformed" });
  });

  it("지금 상한이 chat 하나인데 analysis 칸이 오면 malformed", () => {
    expect(parseClaudeLimitsForm(twoFields(), CHAT)).toEqual({ ok: false, reason: "malformed" });
  });

  it("chat 이 없는 실행 자리 — chat 칸 없이 그 용도의 칸만으로 받는다", () => {
    const fields = formFields({ purpose_chat_per_day: null, purpose_chat_per_hour: null, purpose_analysis_per_day: "7", purpose_analysis_per_hour: "3" });
    expect(parseClaudeLimitsForm(fields, ["analysis"])).toMatchObject({ ok: true, change: { purposes: { analysis: { perDay: 7, perHour: 3 } } } });
    expect(parseClaudeLimitsForm(formFields(), ["analysis"])).toEqual({ ok: false, reason: "malformed" });
  });

  it("용도의 수의 칸이 틀리면 그 칸 이름으로 invalid_value", () => {
    expect(parseClaudeLimitsForm(twoFields({ purpose_analysis_per_day: "1001" }), TWO)).toEqual({ ok: false, reason: "invalid_value", field: "purpose_analysis_per_day" });
  });
});

describe("isRaisingChange — 올림: 꺼진 것을 켬 · 전체 둘과 모든 용도의 값 가운데 하나라도 지금보다 큼", () => {
  it("용도 둘 — analysis 하나만 올려도 올림 · 둘 다 내리면 올림이 아니다", () => {
    const current = change({ analysisDay: 6, analysisHour: 2 });
    expect(isRaisingChange(current, change({ analysisDay: 7, analysisHour: 2 }))).toBe(true);
    expect(isRaisingChange(current, change({ analysisDay: 6, analysisHour: 3, chatDay: 0 }))).toBe(true);
    expect(isRaisingChange(current, change({ analysisDay: 5, analysisHour: 1, chatDay: 29 }))).toBe(false);
  });

  it("지금 상한에 없는 용도가 바꿀 값에 있으면 올림(닫힌 쪽)", () => {
    expect(isRaisingChange(change(), change({ analysisDay: 0, analysisHour: 0 }))).toBe(true);
  });

  it("같은 값은 올림이 아니다", () => {
    expect(isRaisingChange(change(), change())).toBe(false);
  });

  it.each([
    ["전체 하루", { totalDay: 31 }], ["전체 한 시간", { totalHour: 11 }], ["채팅 하루", { chatDay: 31 }], ["채팅 한 시간", { chatHour: 11 }],
  ] as const)("%s 를 1 올림 → 올림", (_label, overrides) => {
    expect(isRaisingChange(change(), change(overrides))).toBe(true);
  });

  it("하나를 올리고 나머지를 내려도 올림", () => {
    expect(isRaisingChange(change(), change({ totalDay: 1, totalHour: 1, chatDay: 1, chatHour: 11 }))).toBe(true);
  });

  it("꺼진 것을 켜면 값이 같거나 낮아도 올림", () => {
    expect(isRaisingChange(change({ enabled: false }), change({ enabled: true }))).toBe(true);
    expect(isRaisingChange(change({ enabled: false }), change({ enabled: true, totalDay: 0, chatDay: 0 }))).toBe(true);
  });

  it("끄면서 값을 올리면 올림", () => {
    expect(isRaisingChange(change(), change({ enabled: false, chatHour: 11 }))).toBe(true);
  });

  it.each([
    ["모두 내림", change({ totalDay: 29, totalHour: 9, chatDay: 0, chatHour: 0 })],
    ["끔", change({ enabled: false })],
    ["끄면서 내림", change({ enabled: false, totalDay: 1 })],
    ["꺼진 채로 내림", change({ enabled: false, totalHour: 1 })],
  ] as const)("%s → 올림이 아니다", (label, next) => {
    const current = label === "꺼진 채로 내림" ? change({ enabled: false }) : change();
    expect(isRaisingChange(current, next)).toBe(false);
  });
});
