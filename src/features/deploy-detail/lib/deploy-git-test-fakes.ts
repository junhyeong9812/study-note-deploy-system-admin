/** 테스트 전용 — 배포 master 의 git 조회 응답 꼴(ci-cd internal/agent/git_read.go 의 GitCommit · GitCommitRange · GitFileChange · GitCommitDetail,
 * 봉투 internal/shared/envelope.go)을 본뜬 가짜. 주소 · 비밀값은 upstream-test-fakes 의 문서용 가짜.
 * 화면에 넘기지 않아야 하는 칸에는 UPSTREAM_RAW_MARKER 를 넣는다.
 * patch 는 실제 master · agent 응답의 꼴을 따른다 — 언제나 `\n` 으로 끝난다(마지막 줄이 `\ No newline at end of file` 이어도 그 뒤에 `\n`).
 * 끝의 줄바꿈 하나는 줄로 세지 않는다(머리줄 포함 n 줄 patch = n 줄). */
import { UPSTREAM_RAW_MARKER, jsonBody, textResponse } from "@/shared/lib/upstream-test-fakes";

/** master 의 커밋 하나 요약(GitCommit). */
export function gitCommitJson(sha: string, overrides: Record<string, unknown> = {}) {
  return {
    sha,
    author_name: "Jun",
    authored_at: "2026-11-22T01:00:00Z",
    subject: `commit ${sha.slice(0, 7)}`,
    body: "",
    body_truncated: false,
    ...overrides,
  };
}

/** master 의 커밋 목록(GitCommitRange) — 기본은 ancestor · 온전 · 잘리지 않음. commits 는 B 쪽이 먼저. */
export function gitCommitRangeJson(commits: unknown[], overrides: Record<string, unknown> = {}) {
  return { commits, truncated: false, range_complete: true, relation: "ancestor", ...overrides };
}

/** master 의 파일 하나(GitFileChange). */
export function gitFileJson(path: string, overrides: Record<string, unknown> = {}) {
  return {
    path,
    previous_path: null,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    patch_truncated: false,
    ...overrides,
  };
}

/** master 의 커밋 하나(GitCommitDetail). */
export function gitCommitDetailJson(sha: string, files: unknown[], overrides: Record<string, unknown> = {}) {
  return { ...gitCommitJson(sha), files, files_truncated: false, ...overrides };
}

/** 성공 봉투 `{success:true,data}`(200). */
export function masterGitSuccess(data: unknown, status = 200): Response {
  return jsonBody({ success: true, data }, status);
}

/** 실패 봉투 `{success:false,error:{code,detail}}` — detail 에 원문 표식(넘기면 안 된다). */
export function masterGitFailure(status: number, code: string): Response {
  return jsonBody({ success: false, error: { code, detail: `${UPSTREAM_RAW_MARKER} /srv/deploy/backend` } }, status);
}

/** Go 의 기본 404(경로 없음 — git 조회가 없는 옛 master) — JSON 이 아니다. */
export function masterRouteMissing(): Response {
  return textResponse("404 page not found\n", 404, "text/plain; charset=utf-8");
}

/** n 줄짜리 patch(첫 줄은 구간 머리 — 실제 꼴대로 각 줄이 `\n` 으로 끝난다: n 줄 + 끝 줄바꿈). */
export function gitPatchWithLines(count: number): string {
  const lines = ["@@ -1,1 +1,1 @@"];
  for (let index = 1; index < count; index += 1) lines.push(`+line ${index}`);
  return `${lines.slice(0, count).join("\n")}\n`;
}

/** patch 의 줄(끝의 줄바꿈 하나는 줄로 세지 않는다). */
export function patchLines(patch: string): string[] {
  return (patch.endsWith("\n") ? patch.slice(0, -1) : patch).split("\n");
}
