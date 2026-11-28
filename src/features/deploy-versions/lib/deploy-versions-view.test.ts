/** 버전 목록 조립 — 명세 6-1 "서비스를 고르면 지금 떠 있는 버전과 배포된 적 있는(성공한) 버전들이 커밋 제목과 함께 보인다".
 * 실제 배포 이력 클라이언트 · git 조회 클라이언트를 가짜 master(실제 응답의 꼴) 위에서 돌린다.
 * 지키는 것: 성공한 배포의 커밋만 · 같은 커밋은 한 줄(가장 최근 시각 + 횟수) · 최신순 · 지금 = 가장 최근 성공 · 진행 중인 배포는 한 줄 따로 ·
 * 이력 상한(200건)에 닿았는지 · 커밋 제목은 그 커밋의 것만(못 얻으면 null) · git 조회는 많아야 두 번 · 모르는 칸을 받아들임 · 전부 GET. */
import { beforeEach, describe, expect, it } from "vitest";
import { createDeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import { createDeployHistoryClient } from "@/features/deploys/lib/deploy-history-client";
import {
  DEPLOY_VERSIONS_HISTORY_LIMIT, buildDeployVersionList, type DeployVersionList, type DeployVersionsDependencies,
} from "@/features/deploy-versions/lib/deploy-versions-view";
import {
  MASTER_DEPLOYS_PATH, MASTER_GIT_COMMITS_PATH, MASTER_GIT_COMMIT_PATH, commitChain, createFakeMaster, deploymentJson, minutesAfterStart, uniqueSha,
  type FakeCommit, type FakeMaster,
} from "@/features/deploy-versions/lib/deploy-versions-test-fakes";
import {
  FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, expectFailure, expectNoForbiddenText, expectReadOnlyRequest, headersOf, jsonBody, leakyErrorBody,
  leakyNetworkError, okValue, textResponse,
} from "@/shared/lib/upstream-test-fakes";

const SERVICE = "backend";

function dependenciesFor(master: FakeMaster): DeployVersionsDependencies {
  const options = { baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch: master.fetch };
  return { deployHistory: createDeployHistoryClient(options), deployGit: createDeployGitClient(options) };
}

async function buildList(master: FakeMaster): Promise<DeployVersionList> {
  return okValue(await buildDeployVersionList(dependenciesFor(master), SERVICE));
}

function shasOf(list: DeployVersionList): string[] {
  return list.versions.map((version) => version.commitSha);
}

let chain: FakeCommit[];

beforeEach(() => {
  chain = commitChain(["첫 커밋", "로그인 고침", "목록 정렬", "배포 스크립트", "다섯째 커밋"]);
});

describe("목록의 내용 — 성공한 배포의 커밋만", () => {
  it("실패한 배포 · 진행 중인 배포의 커밋은 목록에 없다", async () => {
    const [first, second, third, fourth, fifth] = chain;
    const master = createFakeMaster([
      deploymentJson(SERVICE, fifth.sha, "ci_running", minutesAfterStart(50)),
      deploymentJson(SERVICE, fourth.sha, "failed", minutesAfterStart(40)),
      deploymentJson(SERVICE, third.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, second.sha, "failed", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ], chain);
    const list = await buildList(master);
    expect(shasOf(list)).toEqual([third.sha, first.sha]);
    expect(shasOf(list)).not.toContain(fourth.sha);
    expect(shasOf(list)).not.toContain(second.sha);
    expect(shasOf(list)).not.toContain(fifth.sha);
  });

  it("같은 커밋이 여러 번 성공했으면 한 줄 — 가장 최근 성공 배포의 시각과 성공 횟수", async () => {
    const [first, second] = chain;
    const master = createFakeMaster([
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(50)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(40)),
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, second.sha, "failed", minutesAfterStart(25)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ], chain);
    const list = await buildList(master);
    expect(shasOf(list)).toEqual([second.sha, first.sha]);
    expect(list.versions.map((version) => version.deployCount)).toEqual([2, 3]);   // 실패한 배포는 세지 않는다
    // 가장 최근 성공 배포의 finished_at(접수 3분 뒤)
    expect(list.versions[0].lastDeployedAt).toBe(minutesAfterStart(53));
    expect(list.versions[1].lastDeployedAt).toBe(minutesAfterStart(43));
  });

  it("finished_at 이 없는 성공 줄(옛 기록)은 접수 시각을 배포 시각으로", async () => {
    const [first] = chain;
    const master = createFakeMaster([
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10), { finished_at: "" }),
    ], chain);
    const list = await buildList(master);
    expect(list.versions[0].lastDeployedAt).toBe(minutesAfterStart(10));
  });

  it("지금 떠 있는 버전 = 가장 최근에 성공한 배포의 커밋 — 그 뒤에 실패한 배포가 있어도, 하나만 current", async () => {
    const [first, second, third] = chain;
    const master = createFakeMaster([
      deploymentJson(SERVICE, third.sha, "failed", minutesAfterStart(30)),
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ], chain);
    const list = await buildList(master);
    expect(list.versions.map((version) => [version.commitSha, version.current])).toEqual([[second.sha, true], [first.sha, false]]);
  });

  it("최신순 = master 가 준 순서에서 처음 나온 자리(옛 커밋을 다시 올렸으면 그것이 맨 위 · 지금)", async () => {
    const [first, second, third] = chain;
    const master = createFakeMaster([
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(40)),
      deploymentJson(SERVICE, third.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ], chain);
    const list = await buildList(master);
    expect(shasOf(list)).toEqual([first.sha, third.sha, second.sha]);
    expect(list.versions[0].current).toBe(true);
    expect(list.versions[0].deployCount).toBe(2);
  });

  it("진행 중인 배포가 있으면 inProgress 에 가장 최근 하나(요청 ID · 커밋 · 상태 · 접수 시각)", async () => {
    const [first, second, third] = chain;
    const inProgressRow = deploymentJson(SERVICE, third.sha, "cd_running", minutesAfterStart(30));
    const master = createFakeMaster([
      inProgressRow,
      deploymentJson(SERVICE, second.sha, "accepted", minutesAfterStart(20)),   // 오래 남은 진행 중 — 가장 최근 것만 보인다
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ], chain);
    const list = await buildList(master);
    expect(list.inProgress).toEqual({ requestId: inProgressRow.request_id, commitSha: third.sha, state: "cd_running", acceptedAt: minutesAfterStart(30) });
    expect(shasOf(list)).toEqual([first.sha]);
  });

  it("진행 중인 배포가 없으면 inProgress 는 null", async () => {
    const master = createFakeMaster([deploymentJson(SERVICE, chain[0].sha, "succeeded", minutesAfterStart(10))], chain);
    expect((await buildList(master)).inProgress).toBeNull();
  });

  it("다른 서비스의 줄은 보지 않는다(master 가 섞어 줘도)", async () => {
    const [first, second] = chain;
    const master = createFakeMaster([], chain);
    master.override[MASTER_DEPLOYS_PATH] = () => jsonBody({ success: true, data: { deployments: [
      deploymentJson("front", second.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson("front", second.sha, "ci_running", minutesAfterStart(35)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ] } });
    const list = await buildList(master);
    expect(shasOf(list)).toEqual([first.sha]);
    expect(list.versions[0].current).toBe(true);
    expect(list.inProgress).toBeNull();
    expect(list.service).toBe(SERVICE);
  });

  it("성공한 배포가 없으면 빈 목록(실패가 아니다) — git 은 부르지 않는다", async () => {
    const master = createFakeMaster([deploymentJson(SERVICE, chain[0].sha, "failed", minutesAfterStart(10))], chain);
    const list = await buildList(master);
    expect(list.versions).toEqual([]);
    expect(list.titleFailure).toBeNull();
    expect(master.gitRequests()).toEqual([]);
  });
});

describe("잘림을 드러낸다 — master 의 이력 조회는 200건이 상한", () => {
  it("master 에 service = 고른 서비스 · limit = 200 으로 한 번 묻는다", async () => {
    const master = createFakeMaster([deploymentJson(SERVICE, chain[0].sha, "succeeded", minutesAfterStart(10))], chain);
    await buildList(master);
    const historyRequests = master.requestedUrls().filter((url) => url.pathname === MASTER_DEPLOYS_PATH);
    expect(historyRequests).toHaveLength(1);
    expect(historyRequests[0].searchParams.get("service")).toBe(SERVICE);
    expect(historyRequests[0].searchParams.get("limit")).toBe("200");
    expect(DEPLOY_VERSIONS_HISTORY_LIMIT).toBe(200);
  });

  it("받은 이력이 200건이면 reachedHistoryLimit · 읽은 건수 200 · historyLimit 200", async () => {
    const [first, second] = chain;
    const rows = Array.from({ length: 250 }, (_, index) => deploymentJson(SERVICE, index % 2 === 0 ? second.sha : first.sha, "succeeded", minutesAfterStart(1000 - index)));
    const list = await buildList(createFakeMaster(rows, chain));
    expect(list.scannedDeployments).toBe(200);
    expect(list.historyLimit).toBe(200);
    expect(list.reachedHistoryLimit).toBe(true);
    expect(list.versions.map((version) => version.deployCount)).toEqual([100, 100]);
  });

  it("199건이면 reachedHistoryLimit 는 false", async () => {
    const rows = Array.from({ length: 199 }, (_, index) => deploymentJson(SERVICE, chain[0].sha, "succeeded", minutesAfterStart(1000 - index)));
    const list = await buildList(createFakeMaster(rows, chain));
    expect(list.scannedDeployments).toBe(199);
    expect(list.reachedHistoryLimit).toBe(false);
  });
});

describe("커밋 제목 — master git 조회에서, 그 커밋의 것만", () => {
  it("한 줄로 이어진 이력이면 모든 버전에 그 커밋의 제목", async () => {
    const [first, , third, , fifth] = chain;
    const master = createFakeMaster([
      deploymentJson(SERVICE, fifth.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, third.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ], chain);
    const list = await buildList(master);
    expect(list.versions.map((version) => version.title)).toEqual(["다섯째 커밋", "목록 정렬", "첫 커밋"]);
    expect(list.titleFailure).toBeNull();
  });

  it("버전이 하나뿐이어도 제목이 있다", async () => {
    const master = createFakeMaster([deploymentJson(SERVICE, chain[1].sha, "succeeded", minutesAfterStart(10))], chain);
    expect((await buildList(master)).versions[0].title).toBe("로그인 고침");
  });

  it("git 조회는 한 화면에 많아야 두 번 · 전부 GET · 본문 없음 · 고른 서비스 · 비밀값은 X-Deploy-Secret 로만", async () => {
    const master = createFakeMaster(chain.slice().reverse().map((commit, index) => deploymentJson(SERVICE, commit.sha, "succeeded", minutesAfterStart(100 - index))), chain);
    const list = await buildList(master);
    expect(list.versions).toHaveLength(5);
    const gitRequests = master.gitRequests();
    expect(gitRequests.length).toBeGreaterThan(0);
    expect(gitRequests.length).toBeLessThanOrEqual(2);
    for (const url of gitRequests) expect(url.searchParams.get("service")).toBe(SERVICE);
    for (const [input, init] of master.fetch.mock.calls) {
      expectReadOnlyRequest(init);
      expect(headersOf(init).get("x-deploy-secret"), input).toBe(FAKE_DEPLOY_SECRET);
      expect(new URL(input).search).not.toContain(FAKE_DEPLOY_SECRET);
    }
  });

  it("서버의 git 이력에 없는 커밋은 제목 null — 다른 커밋의 제목을 붙이지 않고, 목록은 그대로", async () => {
    const outsideSha = uniqueSha();   // 사슬에 없다(얕은 이력 밖)
    const [, second, , fourth] = chain;
    const master = createFakeMaster([
      deploymentJson(SERVICE, fourth.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, outsideSha, "succeeded", minutesAfterStart(10)),
    ], chain);
    const list = await buildList(master);
    expect(shasOf(list)).toEqual([fourth.sha, second.sha, outsideSha]);
    expect(list.versions[2].title).toBeNull();
    const subjectOf = new Map(chain.map((commit) => [commit.sha, commit.subject]));
    for (const version of list.versions) {
      if (version.title !== null) expect(version.title).toBe(subjectOf.get(version.commitSha));
    }
  });

  it("범위 조회가 다른 커밋을 더 돌려줘도 버전의 제목은 SHA 가 같은 커밋의 것", async () => {
    const [first, second, third, fourth, fifth] = chain;
    const master = createFakeMaster([
      deploymentJson(SERVICE, fifth.sha, "succeeded", minutesAfterStart(30)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ], chain);
    const list = await buildList(master);
    expect(list.versions.map((version) => version.title)).toEqual(["다섯째 커밋", "첫 커밋"]);
    for (const subject of [second, third, fourth].map((commit) => commit.subject)) {
      expect(list.versions.map((version) => version.title)).not.toContain(subject);
    }
  });

  it.each([
    ["연결 실패", () => Promise.reject(leakyNetworkError()), "unreachable"],
    ["503", () => textResponse(leakyErrorBody(), 503), "unavailable"],
    ["깨진 본문", () => textResponse("{not json"), "unparseable"],
  ] as const)("git 조회가 %s 이면 버전 목록은 그대로 · 제목 null · titleFailure = 그 이유(원문 없음)", async (_label, behavior, reason) => {
    const [first, second] = chain;
    const master = createFakeMaster([
      deploymentJson(SERVICE, second.sha, "succeeded", minutesAfterStart(20)),
      deploymentJson(SERVICE, first.sha, "succeeded", minutesAfterStart(10)),
    ], chain);
    master.override[MASTER_GIT_COMMITS_PATH] = behavior;
    master.override[MASTER_GIT_COMMIT_PATH] = behavior;
    const list = await buildList(master);
    expect(shasOf(list)).toEqual([second.sha, first.sha]);
    expect(list.versions.map((version) => version.title)).toEqual([null, null]);
    expect(list.titleFailure).not.toBeNull();
    expectFailure(list.titleFailure!, reason);
    expectNoForbiddenText(list);
  });
});

describe("배포 이력 조회가 실패하면 그 실패 — git 은 부르지 않는다", () => {
  it.each([
    ["연결 실패", () => Promise.reject(leakyNetworkError()), "unreachable", undefined],
    ["503", () => textResponse(leakyErrorBody(), 503), "unavailable", 503],
    ["500", () => textResponse(leakyErrorBody(), 500), "bad_status", 500],
    ["깨진 본문", () => textResponse(`{${leakyErrorBody()}`), "unparseable", undefined],
    ["봉투가 아님", () => jsonBody({ deployments: [] }), "unparseable", undefined],
  ] as const)("%s → %s", async (_label, behavior, reason, status) => {
    const master = createFakeMaster([], chain);
    master.override[MASTER_DEPLOYS_PATH] = behavior;
    const result = await buildDeployVersionList(dependenciesFor(master), SERVICE);
    expectFailure(result, reason, status);
    expect(master.gitRequests()).toEqual([]);
  });
});

describe("응답에 모르는 칸이 더 있어도 깨지지 않는다(master 가 곧 requested_by 를 더한다)", () => {
  const rowsWithNewFields = (sha: string) => [
    deploymentJson(SERVICE, sha, "succeeded", minutesAfterStart(20), { requested_by: "admin:fake-admin" }),
    deploymentJson(SERVICE, sha, "succeeded", minutesAfterStart(10), { requested_by: "github", future_field: { nested: [1, 2] } }),
  ];

  it("버전 목록 — requested_by · 그 밖의 칸이 있어도 같은 결과", async () => {
    const master = createFakeMaster(rowsWithNewFields(chain[2].sha), chain);
    const list = await buildList(master);
    expect(shasOf(list)).toEqual([chain[2].sha]);
    expect(list.versions[0].deployCount).toBe(2);
    expect(list.versions[0].title).toBe("목록 정렬");
  });

  it("기존 배포 이력 클라이언트(배포 이력 화면)도 requested_by 가 실린 줄을 받아들인다", async () => {
    const master = createFakeMaster(rowsWithNewFields(chain[2].sha), chain);
    const client = createDeployHistoryClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch: master.fetch });
    const deployments = okValue(await client.listDeployments({ service: null, limit: 50 }));
    expect(deployments.map((deployment) => deployment.commitSha)).toEqual([chain[2].sha, chain[2].sha]);
    expect(deployments[0]).not.toHaveProperty("requested_by");
  });
});
