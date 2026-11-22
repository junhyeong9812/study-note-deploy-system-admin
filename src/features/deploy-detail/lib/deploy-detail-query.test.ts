/** 배포 상세 — 입력 검증 · 범위 계산 · 저장소 허용 목록(명세 §10.2 "SHA 는 16진수 7~40자만, 요청 ID 는 기존 형식만" ·
 * "B = 이 배포의 커밋. A = 같은 서비스에서 이 배포보다 앞서 성공한 가장 최근 배포의 커밋" · "서비스 이름 → 저장소 이름은 코드에 고정한 표"). */
import { describe, expect, it } from "vitest";
import type { DeploymentSummary } from "@/features/deploys/lib/deploy-history-client";
import { DEPLOY_SERVICES } from "@/features/deploys/lib/deploy-history-query";
import {
  COMMIT_SHA_PATTERN, DEPLOY_REQUEST_ID_PATTERN, isCommitSha, parseDeployDetailQuery,
} from "@/features/deploy-detail/lib/deploy-detail-query";
import { findDeployRange, isSameCommit } from "@/features/deploy-detail/lib/deploy-range";
import { GITHUB_REPOSITORY_NAMES, GITHUB_REPOSITORY_OWNER, githubRepositoryFor } from "@/features/deploy-detail/lib/github-repository";
import { expectFailure } from "@/shared/lib/upstream-test-fakes";

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

function expectInvalid(input: Record<string, string | string[] | undefined>, field: string) {
  const result = parseDeployDetailQuery(input);
  expectFailure(result, "invalid_input");
  expect(!result.ok && result.field).toBe(field);
}

describe("parseDeployDetailQuery — 입력 검증(호출 전에 거절)", () => {
  it("service · selected 만 — commit 은 null", () => {
    expect(parseDeployDetailQuery({ service: "backend", selected: "request-id_1" })).toEqual({
      ok: true, query: { service: "backend", selectedRequestId: "request-id_1", commitSha: null },
    });
  });

  it("빈 commit 은 고르지 않음(null)", () => {
    expect(parseDeployDetailQuery({ service: "front", selected: "a", commit: "" })).toEqual({
      ok: true, query: { service: "front", selectedRequestId: "a", commitSha: null },
    });
  });

  it.each([...DEPLOY_SERVICES])("허용 목록의 service %s", (service) => {
    const result = parseDeployDetailQuery({ service, selected: "request-1", commit: FULL_SHA });
    expect(result).toEqual({ ok: true, query: { service, selectedRequestId: "request-1", commitSha: FULL_SHA } });
  });

  it.each(["abcdef0", "ABCDEF0", "0123456789abcdef0123456789abcdef01234567", "aBcDeF0123"])("commit %j(16진수 7~40자)는 받은 글자 그대로", (commit) => {
    const result = parseDeployDetailQuery({ service: "front", selected: "a", commit });
    expect(result).toEqual({ ok: true, query: { service: "front", selectedRequestId: "a", commitSha: commit } });
  });

  it.each([
    "abcdef", "0123456789abcdef0123456789abcdef012345678", "ghijklm", "abcdef0 ", " abcdef0", "abc-def0", "../abcdef0",
    "abcdef0...fedcba9", "abcdef0%2F", "０１２３４５６",
  ])("commit %j → invalid_input(commit)", (commit) => {
    expectInvalid({ service: "front", selected: "a", commit }, "commit");
  });

  it("요청 ID 의 경계 — 64자는 받고 65자는 거절", () => {
    expect(parseDeployDetailQuery({ service: "front", selected: "a".repeat(64) })).toMatchObject({ ok: true });
    expectInvalid({ service: "front", selected: "a".repeat(65) }, "selected");
  });

  it.each(["a b", "a/b", "a.b", "../x", "요청", "a;b", "a%20b", "a?b", "a#b"])("selected %j → invalid_input(selected)", (selected) => {
    expectInvalid({ service: "front", selected }, "selected");
  });

  it("selected 가 없거나 비면 거절(필수)", () => {
    expectInvalid({ service: "front" }, "selected");
    expectInvalid({ service: "front", selected: "" }, "selected");
  });

  it.each(["", "unknown", "ci-cd", "Front", " front", "front ", "constructor", "__proto__", "toString", "../front"])(
    "service %j → invalid_input(service)", (service) => {
      expectInvalid({ service, selected: "a" }, "service");
    });

  it("service 가 없으면 거절(필수)", () => {
    expectInvalid({ selected: "a" }, "service");
  });

  it.each(["service", "selected", "commit"])("%s 가 여러 번(배열)이면 거절", (name) => {
    const input: Record<string, string | string[]> = { service: "front", selected: "a", commit: FULL_SHA };
    input[name] = [input[name] as string, input[name] as string];
    expectInvalid(input, name);
  });

  it("형식 상수 — SHA 7~40 16진수 · 요청 ID 는 master 의 형식", () => {
    expect(COMMIT_SHA_PATTERN.test("abcdef0")).toBe(true);
    expect(DEPLOY_REQUEST_ID_PATTERN.test("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
    expect(isCommitSha("abcdef0")).toBe(true);
    expect(isCommitSha("abcdef")).toBe(false);
    expect(isCommitSha("g".repeat(7))).toBe(false);
    expect(isCommitSha("a".repeat(40))).toBe(true);
    expect(isCommitSha("a".repeat(41))).toBe(false);
  });
});

function deployment(requestId: string, overrides: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    requestId, state: "succeeded", service: "backend", commitSha: "ffffffffffffffffffffffffffffffffffffffff",
    failedStage: null, acceptedAt: "2026-11-22T01:00:00Z", finishedAt: "2026-11-22T01:05:00Z",
    integrationMilliseconds: 1000, deliveryMilliseconds: 1000, ...overrides,
  };
}

const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_OLDER = "cccccccccccccccccccccccccccccccccccccccc";
const SHA_OTHER = "dddddddddddddddddddddddddddddddddddddddd";
const SHA_NEWER = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

describe("findDeployRange — A·B", () => {
  it("정상 — A = 같은 서비스에서 앞선 가장 최근 성공(목록은 최신순)", () => {
    const list = [
      deployment("newer", { commitSha: SHA_NEWER, acceptedAt: "2026-11-22T05:00:00Z" }),
      deployment("selected", { commitSha: SHA_B, acceptedAt: "2026-11-22T04:00:00Z" }),
      deployment("previous", { commitSha: SHA_A, acceptedAt: "2026-11-22T03:00:00Z" }),
      deployment("older", { commitSha: SHA_OLDER, acceptedAt: "2026-11-22T02:00:00Z" }),
    ];
    const found = findDeployRange(list, "selected");
    expect(found?.selected).toBe(list[1]);
    expect(found?.range).toEqual({ status: "range", baseRequestId: "previous", baseCommitSha: SHA_A, headCommitSha: SHA_B });
  });

  it("선택한 배포보다 나중(목록 앞쪽)의 성공은 A 가 아니다 — 그 뒤에 성공이 없으면 A 없음", () => {
    const list = [
      deployment("newer", { commitSha: SHA_NEWER }),
      deployment("selected", { commitSha: SHA_B }),
    ];
    expect(findDeployRange(list, "selected")?.range).toEqual({ status: "no_previous", baseRequestId: null, baseCommitSha: null, headCommitSha: SHA_B });
  });

  it("A 없음 — 첫 배포(목록에 그것 하나)", () => {
    const list = [deployment("selected", { commitSha: SHA_B })];
    expect(findDeployRange(list, "selected")?.range).toEqual({ status: "no_previous", baseRequestId: null, baseCommitSha: null, headCommitSha: SHA_B });
  });

  it("A 없음 — 앞선 배포가 전부 실패 · 진행 중", () => {
    const list = [
      deployment("selected", { commitSha: SHA_B }),
      deployment("failed-before", { commitSha: SHA_A, state: "failed", failedStage: "ci_test" }),
      deployment("running-before", { commitSha: SHA_OLDER, state: "cd_running", finishedAt: null }),
    ];
    expect(findDeployRange(list, "selected")?.range.status).toBe("no_previous");
  });

  it("A==B — 같은 커밋 재배포는 same_commit(대소문자 무관)", () => {
    const list = [
      deployment("selected", { commitSha: SHA_B }),
      deployment("previous", { commitSha: SHA_B.toUpperCase() }),
    ];
    expect(findDeployRange(list, "selected")?.range).toEqual({
      status: "same_commit", baseRequestId: "previous", baseCommitSha: SHA_B.toUpperCase(), headCommitSha: SHA_B,
    });
  });

  it("선택한 배포 없음 → null", () => {
    expect(findDeployRange([deployment("other", { commitSha: SHA_A })], "selected")).toBeNull();
    expect(findDeployRange([], "selected")).toBeNull();
  });

  it("요청 ID 는 완전 일치(앞부분 일치 · 대소문자 다름은 없음)", () => {
    const list = [deployment("selected-long", { commitSha: SHA_B }), deployment("Selected", { commitSha: SHA_A })];
    expect(findDeployRange(list, "selected")).toBeNull();
  });

  it("진행 중인 배포를 골라도 A 는 앞선 성공", () => {
    const list = [
      deployment("selected", { commitSha: SHA_B, state: "ci_running", finishedAt: null }),
      deployment("previous", { commitSha: SHA_A }),
    ];
    expect(findDeployRange(list, "selected")?.range).toEqual({ status: "range", baseRequestId: "previous", baseCommitSha: SHA_A, headCommitSha: SHA_B });
  });

  it("실패한 배포를 골라도 A 는 여전히 직전 성공(사이의 실패 · 진행 중은 건너뛴다)", () => {
    const list = [
      deployment("selected", { commitSha: SHA_B, state: "failed", failedStage: "cd_health" }),
      deployment("failed-between", { commitSha: SHA_OTHER, state: "failed", failedStage: "ci_test" }),
      deployment("accepted-between", { commitSha: SHA_NEWER, state: "accepted", finishedAt: null }),
      deployment("previous", { commitSha: SHA_A }),
      deployment("older", { commitSha: SHA_OLDER }),
    ];
    expect(findDeployRange(list, "selected")?.range).toEqual({ status: "range", baseRequestId: "previous", baseCommitSha: SHA_A, headCommitSha: SHA_B });
  });

  it("다른 서비스의 성공은 A 가 아니다", () => {
    const list = [
      deployment("selected", { commitSha: SHA_B, service: "front" }),
      deployment("other-service", { commitSha: SHA_OTHER, service: "backend" }),
      deployment("previous", { commitSha: SHA_A, service: "front" }),
    ];
    expect(findDeployRange(list, "selected")?.range.baseRequestId).toBe("previous");
  });

  it("접수 시각이 같아도 master 의 순서를 따른다(목록에서 뒤에 있는 것이 앞선 배포)", () => {
    const sameTime = "2026-11-22T01:00:00Z";
    const list = [
      deployment("later-row", { commitSha: SHA_NEWER, acceptedAt: sameTime }),
      deployment("selected", { commitSha: SHA_B, acceptedAt: sameTime }),
      deployment("earlier-row", { commitSha: SHA_A, acceptedAt: sameTime }),
    ];
    expect(findDeployRange(list, "selected")?.range.baseRequestId).toBe("earlier-row");
  });

  it("isSameCommit — 대소문자 무관 완전 일치만", () => {
    expect(isSameCommit(SHA_A, SHA_A.toUpperCase())).toBe(true);
    expect(isSameCommit(SHA_A, SHA_A.slice(0, 7))).toBe(false);
    expect(isSameCommit(SHA_A, SHA_B)).toBe(false);
  });
});

describe("githubRepositoryFor — 코드에 고정한 허용 목록", () => {
  it("소유자와 저장소 이름 표", () => {
    expect(GITHUB_REPOSITORY_OWNER).toBe("junhyeong9812");
    expect(GITHUB_REPOSITORY_NAMES).toEqual({
      front: "study-note-deploy-system-front", backend: "study-note-deploy-system-backend", llm: "study-note-deploy-system-llm",
      alert: "study-note-deploy-system-alert", observe: "study-note-deploy-system-observe", admin: "study-note-deploy-system-admin",
    });
  });

  it.each([...DEPLOY_SERVICES])("%s → 표의 저장소", (service) => {
    expect(githubRepositoryFor(service)).toEqual({ owner: "junhyeong9812", name: `study-note-deploy-system-${service}` });
  });

  it.each(["ci-cd", "", "Front", " front", "constructor", "__proto__", "hasOwnProperty", "../front", "front/../../other"])("%j → null", (service) => {
    expect(githubRepositoryFor(service)).toBeNull();
  });
});
