/** 재배포 확인 화면의 조립 — 명세 6-3 "버전을 고르면 확인 화면이 지금 → 고른 버전과 그 사이 커밋을 보인다(아무것도 바꾸지 않는다)" ·
 * ② "고를 수 있는 것은 그 서비스의 성공 이력에 있는 커밋뿐" · "지금 버전과 같은 커밋도 허용" · ① "데이터 꼴이 바뀐 버전을 넘을 때는 그 사이 커밋 목록".
 * 실제 배포 이력 · git 조회 클라이언트를 가짜 master(갈라지는 git 이력) 위에서 돌린다. */
import { beforeEach, describe, expect, it } from "vitest";
import { createDeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import { gitCommitJson, gitCommitRangeJson, masterGitFailure, masterGitSuccess } from "@/features/deploy-detail/lib/deploy-git-test-fakes";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import {
  MASTER_DEPLOYS_PATH, MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH, createFakeMaster, deploymentJson, minutesAfterStart, uniqueSha, type FakeMaster,
} from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import type { DeployVersionsDependencies } from "@/features/deploy-versions/lib/deploy-versions-view";
import { REDEPLOY_DIRECTION_GIT_CALL_LIMIT, buildRedeployPreview, type RedeployPreview } from "@/features/deploy-redeploy/lib/redeploy-preview";
import { branchFrom, installCommitGraph, rangeRequestsBetween, type GraphCommit } from "@/features/deploy-redeploy/lib/redeploy-test-fakes";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, expectFailure, expectNoForbiddenText, expectReadOnlyRequest, headersOf, leakyErrorBody, leakyNetworkError,
  okValue, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const SERVICE = "backend";

function dependenciesFor(master: FakeMaster): DeployVersionsDependencies {
  const options = { baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch: master.fetch };
  return { deployHistory: createDeployHistoryClient(options), deployGit: createDeployGitClient(options) };
}

async function preview(master: FakeMaster, commitSha: string): Promise<RedeployPreview> {
  return okValue(await buildRedeployPreview(dependenciesFor(master), { service: SERVICE, commitSha }));
}

type Comparison = Extract<RedeployPreview, { kind: "comparison" }>;

function comparisonOf(result: RedeployPreview): Comparison {
  expect(result.kind).toBe("comparison");
  if (result.kind !== "comparison") throw new Error("expected comparison");
  return result;
}

/** 모든 사례 공통 — 나간 요청은 전부 GET · 본문 없음 · 비밀값은 헤더로만 · git 조회는 많아야 4번(제목 2 + 방향 2). */
function expectReadOnlyAndBounded(master: FakeMaster) {
  for (const [input, init] of master.fetch.mock.calls) {
    expectReadOnlyRequest(init);
    expect(headersOf(init).get("x-deploy-secret"), input).toBe(FAKE_DEPLOY_SECRET);
  }
  expect(master.gitRequests().length).toBeLessThanOrEqual(4);
  expect(master.requestedUrls().filter((url) => url.pathname === MASTER_DEPLOYS_PATH)).toHaveLength(1);
}

let main: GraphCommit[];

beforeEach(() => {
  main = branchFrom(null, ["첫 커밋", "로그인 고침", "표에 칸 더함", "목록 정렬", "배포 스크립트", "여섯째 커밋"]);
});

describe("고를 수 있는 것은 그 서비스의 성공 이력에 있는 커밋뿐 — 아니면 비교하지 않는다", () => {
  function masterWith(rows: Record<string, unknown>[]): FakeMaster {
    const master = createFakeMaster(rows, []);
    installCommitGraph(master, main);
    return master;
  }

  it.each([
    ["실패한 배포의 커밋", "failed"],
    ["진행 중인 배포의 커밋", "ci_running"],
  ] as const)("%s → not_deployable, 고른 커밋으로 git 을 부르지 않는다", async (_label, state) => {
    const [first, second, , fourth] = main;
    const master = masterWith([
      deploymentJson(SERVICE, second.sha, state, minutesAfterStart(40)),
      deploymentJson(SERVICE, fourth.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ]);
    expect(await preview(master, second.sha)).toEqual({ kind: "not_deployable", service: SERVICE, commitSha: second.sha });
    expect(master.gitRequests().filter((url) => url.search.includes(second.sha))).toEqual([]);
    expectReadOnlyAndBounded(master);
  });

  it("다른 서비스에서만 성공한 커밋 → not_deployable", async () => {
    const [first, second] = main;
    const master = masterWith([
      deploymentJson("front", second.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ]);
    expect((await preview(master, second.sha)).kind).toBe("not_deployable");
    expect(master.gitRequests().filter((url) => url.search.includes(second.sha))).toEqual([]);
  });

  it("이력에 아예 없는 커밋 → not_deployable", async () => {
    const master = masterWith([deploymentJson(SERVICE, main[0].sha, "succeeded", minutesAfterStart(10))]);
    const unknownSha = uniqueSha();
    expect(await preview(master, unknownSha)).toEqual({ kind: "not_deployable", service: SERVICE, commitSha: unknownSha });
  });

  it("성공한 배포가 하나도 없으면 → not_deployable(git 0회)", async () => {
    const master = masterWith([deploymentJson(SERVICE, main[0].sha, "failed", minutesAfterStart(10))]);
    expect((await preview(master, main[0].sha)).kind).toBe("not_deployable");
    expect(master.gitRequests()).toEqual([]);
  });

  it("이력은 버전 목록과 같은 조회 — service = 고른 서비스 · limit = 200 으로 한 번", async () => {
    const master = masterWith([deploymentJson(SERVICE, main[0].sha, "succeeded", minutesAfterStart(10))]);
    await preview(master, main[0].sha);
    const historyRequests = master.requestedUrls().filter((url) => url.pathname === MASTER_DEPLOYS_PATH);
    expect(historyRequests).toHaveLength(1);
    expect(historyRequests[0].searchParams.get("service")).toBe(SERVICE);
    expect(historyRequests[0].searchParams.get("limit")).toBe("200");
  });
});

describe("방향과 사이의 커밋", () => {
  it("되돌리기 — 고른 버전이 지금 버전의 조상: 사라지게 되는 커밋(고른 버전 뒤 ~ 지금 버전, 최신순)", async () => {
    const [first, second, third, fourth, fifth] = main;
    const master = createFakeMaster([
      deploymentJson(SERVICE, fifth.sha, "succeeded", minutesAfterStart(40)),
      deploymentJson(SERVICE, fourth.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ]);
    installCommitGraph(master, main);
    const result = comparisonOf(await preview(master, second.sha));
    expect(result.service).toBe(SERVICE);
    expect(result.current).toMatchObject({ commitSha: fifth.sha, current: true, title: "배포 스크립트", lastDeployedAt: minutesAfterStart(43) });
    expect(result.chosen).toMatchObject({ commitSha: second.sha, current: false, title: "로그인 고침", lastDeployedAt: minutesAfterStart(23) });
    expect(result.direction).toEqual({
      kind: "rollback",
      between: {
        commits: [fifth, fourth, third].map((commit) => ({ sha: commit.sha, title: commit.subject })),
        truncated: false, complete: true,
      },
    });
    expect(result.inProgress).toBeNull();
    expect(rangeRequestsBetween(master, second.sha, fifth.sha).length).toBeGreaterThanOrEqual(1);
    expectReadOnlyAndBounded(master);
  });

  it("앞으로 — 고른 버전이 지금 버전의 자손(옛 버전으로 되돌린 상태): 더해지는 커밋(지금 버전 뒤 ~ 고른 버전, 최신순)", async () => {
    const [first, second, third, fourth, fifth] = main;
    const master = createFakeMaster([
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(50)),   // 되돌림 — 지금
      deploymentJson(SERVICE, fifth.sha, "succeeded", minutesAfterStart(40)),
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ]);
    installCommitGraph(master, main);
    const result = comparisonOf(await preview(master, fifth.sha));
    expect(result.current.commitSha).toBe(second.sha);
    expect(result.chosen.commitSha).toBe(fifth.sha);
    expect(result.direction).toEqual({
      kind: "forward",
      between: { commits: [fifth, fourth, third].map((commit) => ({ sha: commit.sha, title: commit.subject })), truncated: false, complete: true },
    });
    expect(rangeRequestsBetween(master, second.sha, fifth.sha).length).toBeLessThanOrEqual(REDEPLOY_DIRECTION_GIT_CALL_LIMIT);
    expectReadOnlyAndBounded(master);
  });

  it("같은 버전 — 지금 버전을 고르면 same, 방향을 위한 범위 조회를 하지 않는다", async () => {
    const [first, , third] = main;
    const master = createFakeMaster([
      deploymentJson(SERVICE, third.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ]);
    installCommitGraph(master, main);
    const result = comparisonOf(await preview(master, third.sha));
    expect(result.direction).toEqual({ kind: "same" });
    expect(result.current.commitSha).toBe(third.sha);
    expect(result.chosen.commitSha).toBe(third.sha);
    expect(rangeRequestsBetween(master, third.sha, third.sha)).toEqual([]);
    expect(master.gitRequests().length).toBeLessThanOrEqual(2);   // 버전 목록의 제목 조회뿐
    expectReadOnlyAndBounded(master);
  });

  it("갈라진 이력(어느 쪽도 다른 쪽의 조상이 아님) → unknown · diverged — 방향을 꾸며 내지 않고 두 버전은 그대로", async () => {
    const [first, , third, , fifth] = main;
    const side = branchFrom(third, ["옆 가지 하나", "옆 가지 둘"]);
    const sideTwo = side[1];
    const master = createFakeMaster([
      deploymentJson(SERVICE, fifth.sha, "succeeded", minutesAfterStart(40)),
      deploymentJson(SERVICE, sideTwo.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ]);
    installCommitGraph(master, [...main, ...side]);
    const result = comparisonOf(await preview(master, sideTwo.sha));
    expect(result.direction).toEqual({ kind: "unknown", reason: "diverged", failure: null });
    expect(result.current.commitSha).toBe(fifth.sha);
    expect(result.chosen.commitSha).toBe(sideTwo.sha);
    expect(rangeRequestsBetween(master, fifth.sha, sideTwo.sha).length).toBeLessThanOrEqual(REDEPLOY_DIRECTION_GIT_CALL_LIMIT);
    expectReadOnlyAndBounded(master);
  });

  it("얕은 이력이라 판정 못 함(relation unknown) → unknown · shallow_history", async () => {
    const [first, second, , , fifth] = main;
    const master = createFakeMaster([
      deploymentJson(SERVICE, fifth.sha, "succeeded", minutesAfterStart(40)),
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ]);
    installCommitGraph(master, main);
    const graphRange = master.override[MASTER_GIT_COMMITS_PATH]!;
    master.override[MASTER_GIT_COMMITS_PATH] = (url, init) => {
      const pair = [url.searchParams.get("from"), url.searchParams.get("to")].sort().join(" ");
      if (pair === [second.sha, fifth.sha].sort().join(" ")) return masterGitSuccess(gitCommitRangeJson([], { relation: "unknown", range_complete: false }));
      return graphRange(url, init);
    };
    const result = comparisonOf(await preview(master, second.sha));
    expect(result.direction).toEqual({ kind: "unknown", reason: "shallow_history", failure: null });
    expectReadOnlyAndBounded(master);
  });

  it.each([
    ["서버의 git 이력에 없음(404 commit_not_found)", () => masterGitFailure(404, "commit_not_found"), "not_in_history", 404],
    ["agent 가 없는 서비스(422)", () => masterGitFailure(422, "invalid_request"), "invalid_request", 422],
    ["503", () => textResponse(leakyErrorBody(), 503), "unavailable", 503],
    ["연결 실패", () => Promise.reject(leakyNetworkError()), "unreachable", undefined],
  ] as const)("git 범위 조회가 %s → unknown · lookup_failed · failure = 그 이유(원문 없음), 두 버전은 그대로", async (_label, behavior, reason, status) => {
    const [first, second, , , fifth] = main;
    const master = createFakeMaster([
      deploymentJson(SERVICE, fifth.sha, "succeeded", minutesAfterStart(40)),
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ]);
    master.override[MASTER_GIT_COMMITS_PATH] = behavior;
    master.override[MASTER_GIT_COMMIT_PATH] = behavior;
    const result = comparisonOf(await preview(master, second.sha));
    expect(result.current.commitSha).toBe(fifth.sha);
    expect(result.chosen.commitSha).toBe(second.sha);
    expect(result.direction.kind).toBe("unknown");
    if (result.direction.kind !== "unknown") return;
    expect(result.direction.reason).toBe("lookup_failed");
    expect(result.direction.failure).not.toBeNull();
    expectFailure(result.direction.failure!, reason, status);
    expectNoForbiddenText(result);
    expectReadOnlyAndBounded(master);
  });

  it("사이의 커밋이 100개를 넘으면 앞 100개(지금 쪽) + truncated — 조용히 자르지 않는다", async () => {
    const long = branchFrom(null, Array.from({ length: 130 }, (_, index) => `커밋 ${index}`));
    const master = createFakeMaster([
      deploymentJson(SERVICE, long[129].sha, "succeeded", minutesAfterStart(40)),
      deploymentJson(SERVICE, long[0].sha, "succeeded", minutesAfterStart(10)),
    ]);
    installCommitGraph(master, long);
    const result = comparisonOf(await preview(master, long[0].sha));
    expect(result.direction.kind).toBe("rollback");
    if (result.direction.kind !== "rollback") return;
    expect(result.direction.between.truncated).toBe(true);
    expect(result.direction.between.commits).toHaveLength(100);
    expect(result.direction.between.commits[0]).toEqual({ sha: long[129].sha, title: "커밋 129" });
    expect(result.direction.between.commits[99]).toEqual({ sha: long[30].sha, title: "커밋 30" });
  });

  it("범위에 얕은 경계가 들어 있으면(range_complete false) complete false", async () => {
    const [first, second, third, fourth, fifth] = main;
    const master = createFakeMaster([
      deploymentJson(SERVICE, fifth.sha, "succeeded", minutesAfterStart(40)),
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ]);
    installCommitGraph(master, main);
    const graphRange = master.override[MASTER_GIT_COMMITS_PATH]!;
    master.override[MASTER_GIT_COMMITS_PATH] = (url, init) => {
      if (url.searchParams.get("from") === second.sha && url.searchParams.get("to") === fifth.sha) {
        return masterGitSuccess(gitCommitRangeJson([fifth, fourth, third].map((commit) => gitCommitJson(commit.sha, { subject: commit.subject })), { range_complete: false }));
      }
      return graphRange(url, init);
    };
    const result = comparisonOf(await preview(master, second.sha));
    expect(result.direction).toMatchObject({ kind: "rollback", between: { complete: false, truncated: false } });
  });
});

describe("진행 중인 배포 · 실패", () => {
  it("그 서비스에 진행 중인 배포가 있으면 inProgress(비교는 그대로)", async () => {
    const [first, , third, , fifth] = main;
    const inProgressRow = deploymentJson(SERVICE, fifth.sha, "cd_running", minutesAfterStart(50));
    const master = createFakeMaster([
      inProgressRow,
      deploymentJson(SERVICE, third.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ]);
    installCommitGraph(master, main);
    const result = comparisonOf(await preview(master, first.sha));
    expect(result.inProgress).toEqual({ requestId: inProgressRow.request_id, commitSha: fifth.sha, state: "cd_running", acceptedAt: minutesAfterStart(50) });
    expect(result.direction.kind).toBe("rollback");
    expect(result.current.commitSha).toBe(third.sha);
  });

  it.each([
    ["연결 실패", () => Promise.reject(leakyNetworkError()), "unreachable", undefined],
    ["503", () => textResponse(leakyErrorBody(), 503), "unavailable", 503],
    ["깨진 본문", () => textResponse(`{${leakyErrorBody()}`), "unparseable", undefined],
  ] as const)("이력 조회가 %s → 그 실패(비교 없음) · git 0회", async (_label, behavior, reason, status) => {
    const master = createFakeMaster([]);
    master.override[MASTER_DEPLOYS_PATH] = behavior;
    const result = await buildRedeployPreview(dependenciesFor(master), { service: SERVICE, commitSha: main[0].sha });
    expectFailure(result, reason, status);
    expect(master.gitRequests()).toEqual([]);
  });
});
