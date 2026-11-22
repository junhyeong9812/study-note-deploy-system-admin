/** diff 줄 나누기 — 명세 §10.2 "파일별 diff(더한 줄 · 뺀 줄 색 + 기호)" · "글자 그대로". */
import { describe, expect, it } from "vitest";
import { diffLines } from "@/features/deploy-detail/lib/diff-lines";

describe("diffLines", () => {
  it("구간 머리 · 맥락 · 뺀 줄 · 더한 줄 — 줄 번호는 머리에서 센다", () => {
    expect(diffLines("@@ -10,3 +20,3 @@ function x() {\n context\n-old\n+new\n tail")).toEqual([
      { kind: "hunk", text: "@@ -10,3 +20,3 @@ function x() {", oldNumber: null, newNumber: null },
      { kind: "context", text: "context", oldNumber: 10, newNumber: 20 },
      { kind: "deletion", text: "old", oldNumber: 11, newNumber: null },
      { kind: "addition", text: "new", oldNumber: null, newNumber: 21 },
      { kind: "context", text: "tail", oldNumber: 12, newNumber: 22 },
    ]);
  });

  it("수가 없는 머리(@@ -1 +1 @@)와 '\\ No newline' 알림", () => {
    const lines = diffLines("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b");
    expect(lines.map((line) => [line.kind, line.oldNumber, line.newNumber])).toEqual([
      ["hunk", null, null], ["deletion", 1, null], ["note", null, null], ["addition", null, 1],
    ]);
  });

  it("글자는 그대로(HTML · 탭 · \\r 해석 없음)", () => {
    const lines = diffLines("@@ -1 +1 @@\n+<script>x</script>\t\r");
    expect(lines[1].text).toBe("<script>x</script>\t\r");
  });

  it("머리를 읽지 못하면 번호는 null", () => {
    expect(diffLines("@@\n-a\n+b").map((line) => line.oldNumber ?? line.newNumber)).toEqual([null, null, null]);
  });
});
