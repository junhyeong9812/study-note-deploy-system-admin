/** 파일 patch(unified diff 글자 — master git 조회의 patch) → 화면의 줄(순수). 글자는 바꾸지 않는다 — 줄의 갈래와 줄 번호만 붙인다.
 * 줄 나누기는 patchLines 하나만 쓴다(상한 판정 · 전체 줄 수 · 화면 표 · "앞 N줄" 문구가 같은 규칙).
 * 갈래: `@@` 로 시작 = 구간 머리(hunk), `+` = 더한 줄, `-` = 뺀 줄, `\` = 알림("\ No newline at end of file"), 그 밖 = 맥락.
 * 줄 번호는 구간 머리 `@@ -옛시작[,수] +새시작[,수] @@` 에서 센다(머리를 읽지 못하면 그 구간의 번호는 null). */

export type DiffLineKind = "hunk" | "addition" | "deletion" | "context" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  /** 줄 앞 기호를 뺀 글자(구간 머리 · 알림은 줄 전체) */
  text: string;
  /** 옛 파일의 줄 번호(더한 줄 · 머리 · 알림은 null) */
  oldNumber: number | null;
  /** 새 파일의 줄 번호(뺀 줄 · 머리 · 알림은 null) */
  newNumber: number | null;
}

/** patch 의 줄 — `\n` 으로 나누되 끝의 줄바꿈 하나는 줄로 세지 않는다(실제 master 응답의 patch 는 `\n` 으로 끝난다). */
export function patchLines(patch: string): string[] {
  return (patch.endsWith("\n") ? patch.slice(0, -1) : patch).split("\n");
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function diffLines(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNumber: number | null = null;
  let newNumber: number | null = null;
  for (const line of patchLines(patch)) {
    if (line.startsWith("@@")) {
      const header = HUNK_HEADER_PATTERN.exec(line);
      oldNumber = header ? Number(header[1]) : null;
      newNumber = header ? Number(header[2]) : null;
      lines.push({ kind: "hunk", text: line, oldNumber: null, newNumber: null });
    } else if (line.startsWith("+")) {
      lines.push({ kind: "addition", text: line.slice(1), oldNumber: null, newNumber });
      if (newNumber !== null) newNumber += 1;
    } else if (line.startsWith("-")) {
      lines.push({ kind: "deletion", text: line.slice(1), oldNumber, newNumber: null });
      if (oldNumber !== null) oldNumber += 1;
    } else if (line.startsWith("\\")) {
      lines.push({ kind: "note", text: line, oldNumber: null, newNumber: null });
    } else {
      lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldNumber, newNumber });
      if (oldNumber !== null) oldNumber += 1;
      if (newNumber !== null) newNumber += 1;
    }
  }
  return lines;
}
