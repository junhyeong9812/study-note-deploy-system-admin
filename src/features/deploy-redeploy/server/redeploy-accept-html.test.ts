/** 재배포 접수의 실패 화면(서버에서 그린 HTML) — 넣은 값은 글에서도 속성 값에서도 이스케이프된다.
 * `"` · `<` · `>` · `&` · `'` 를 담은 값을 HTML 을 만드는 함수에 바로 넣고, 나온 HTML 의 그 자리를 값으로 본다. */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { failurePage, retryFormHtml } from "@/features/deploy-redeploy/server/redeploy-accept";

const HOSTILE = `say "hi" <b>bold</b> & 'quoted'`;
const ESCAPED = "say &quot;hi&quot; &lt;b&gt;bold&lt;/b&gt; &amp; &#x27;quoted&#x27;";
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("실패 화면의 글 — 제목 · 설명", () => {
  it("제목과 설명에 넣은 값은 이스케이프된 글자로 나온다", async () => {
    const response = failurePage(400, `제목 ${HOSTILE}`, `설명 ${HOSTILE}`, null);
    const html = await response.text();
    expect(html).toMatch(new RegExp(`<h1[^>]*>제목 ${ESCAPED}</h1>`));
    expect(html).toContain(`<p>설명 ${ESCAPED}</p>`);
    expect(html).not.toContain(HOSTILE);
    expect(html).not.toContain("<b>bold");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});

describe("다시 보내기 폼 — 속성 값", () => {
  it("확인 값에 넣은 값은 value 속성 안에서 이스케이프되어 속성을 벗어나지 않는다", () => {
    const confirmation = `rc1.${HOSTILE}"><script>alert(1)</script>`;
    const html = retryFormHtml({ query: { service: "backend", commitSha: COMMIT_SHA }, confirmation, password: "fake-password-not-rendered" });
    const confirmationInputs = [...html.matchAll(/<input type="hidden" name="confirmation" value="([^"]*)">/g)].map((match) => match[1]);
    expect(confirmationInputs).toEqual([`rc1.${ESCAPED}&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;`]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("fake-password-not-rendered");
    expect(html).toContain(`<input type="hidden" name="commit" value="${COMMIT_SHA}">`);
  });
});
