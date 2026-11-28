/** 배포 서비스 목록에 `claude`(Claude 실행 자리 — 저장소 study-note-deploy-system-claude)를 더한다.
 * ci-cd 의 짝: master 의 고정 열거(internal/master/master.go — front · backend · llm · alert · observe · admin · claude) · README "배포 대상".
 * 목록을 쓰는 곳마다(이력 · 버전 · 상세 · git 조회 · 재배포 · 문제의 조치 · 상태의 링크) `claude` 를 받고, 비슷한 이름은 그대로 거절한다(회귀). */
import { describe, expect, it, vi } from "vitest";
import { parseDeployDetailQuery } from "@/features/deploy-detail/lib/deploy-detail-query";
import { createDeployGitClient } from "@/features/deploy-detail/lib/deploy-git-client";
import { GITHUB_REPOSITORY_NAMES, githubCommitUrl, githubCompareUrl, githubRepositoryFor } from "@/features/deploy-detail/lib/github-repository";
import { parseRedeployPreviewQuery, parseRedeployPreviewRequest } from "@/features/deploy-redeploy/lib/redeploy-preview-query";
import { parseDeployVersionsQuery } from "@/features/deploy-versions/lib/deploy-versions-query";
import { DEPLOY_SERVICES, parseDeployHistoryQuery, type DeployService } from "@/features/deploys/lib/deploy-history-query";
import { incidentActionServiceOf } from "@/features/incidents/lib/incident-actions";
import type { OpenIncident } from "@/features/incidents/lib/incident-list";
import { serviceForMonitor } from "@/features/incidents/lib/monitor-services";
import { serviceLinksOf } from "@/features/status/ui/status-view";
import { FAKE_DEPLOY_MASTER_URL, FAKE_DEPLOY_SECRET, jsonBody } from "@/shared/lib/upstream-test-fakes";

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";
/** 비슷하지만 다른 이름 — 어느 입력 검사도 받지 않는다(compose 서비스 이름 · 대소문자 · 공백 · 접두 · 접미). */
const LOOKALIKES = ["claude-runner", "Claude", "CLAUDE", " claude", "claude ", "claudes", "claud", "claude-app"];

describe("1 목록 — ci-cd 의 열거와 같은 일곱 이름, claude 는 끝에", () => {
  it("DEPLOY_SERVICES = front · backend · llm · alert · observe · admin · claude", () => {
    expect([...DEPLOY_SERVICES]).toEqual(["front", "backend", "llm", "alert", "observe", "admin", "claude"]);
  });
});

describe("1 입력 검사 — claude 를 받고, 비슷한 이름은 거절", () => {
  it("배포 이력(service=claude)", () => {
    expect(parseDeployHistoryQuery({ service: "claude" })).toEqual({ ok: true, query: { service: "claude", limit: 50 } });
    for (const service of LOOKALIKES) expect(parseDeployHistoryQuery({ service }), service).toMatchObject({ ok: false, field: "service" });
  });

  it("버전 목록(service=claude)", () => {
    expect(parseDeployVersionsQuery({ service: "claude" })).toEqual({ ok: true, query: { service: "claude" } });
    for (const service of LOOKALIKES) expect(parseDeployVersionsQuery({ service }), service).toMatchObject({ ok: false, field: "service" });
  });

  it("배포 상세(service=claude · selected)", () => {
    expect(parseDeployDetailQuery({ service: "claude", selected: "req-1" })).toMatchObject({ ok: true, query: { service: "claude", selectedRequestId: "req-1" } });
    for (const service of LOOKALIKES) expect(parseDeployDetailQuery({ service, selected: "req-1" }), service).toMatchObject({ ok: false, field: "service" });
  });

  it("재배포의 확인(판을 고름 — service=claude · commit) · 문제의 조치(service=claude · incident · action)", () => {
    expect(parseRedeployPreviewQuery({ service: "claude", commit: FULL_SHA })).toEqual({ ok: true, query: { service: "claude", commitSha: FULL_SHA } });
    expect(parseRedeployPreviewRequest({ service: "claude", commit: FULL_SHA })).toMatchObject({ ok: true });
    for (const service of LOOKALIKES) expect(parseRedeployPreviewQuery({ service, commit: FULL_SHA }), service).toMatchObject({ ok: false, field: "service" });
  });

  it("git 조회 — claude 면 master 를 부르고(service=claude), 비슷한 이름이면 부르지 않고 invalid_input(service)", async () => {
    const fetch = vi.fn(async () => jsonBody({ success: true, data: { commits: [], truncated: false, relation: "ancestor" } }));
    const client = createDeployGitClient({ baseUrl: FAKE_DEPLOY_MASTER_URL, secret: FAKE_DEPLOY_SECRET, fetch });
    await client.listCommits("claude" as DeployService, FULL_SHA, FULL_SHA);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String((fetch.mock.calls[0] as unknown[])[0])).searchParams.get("service")).toBe("claude");
    fetch.mockClear();
    for (const service of LOOKALIKES) {
      expect(await client.listCommits(service as DeployService, FULL_SHA, FULL_SHA), service).toMatchObject({ ok: false, reason: "invalid_input", field: "service" });
      expect(await client.getCommit(service as DeployService, FULL_SHA), service).toMatchObject({ ok: false, reason: "invalid_input", field: "service" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("문제의 조치가 고르는 서비스 — 그 서버의 서비스가 claude 하나면 claude · 비슷한 이름은 not_deploy_service", () => {
    const resourceIncident = { kind: "resource_threshold" } as OpenIncident;
    expect(incidentActionServiceOf(resourceIncident, ["claude"])).toEqual({ ok: true, service: "claude" });
    expect(incidentActionServiceOf(resourceIncident, ["claude-runner"])).toEqual({ ok: false, reason: "not_deploy_service" });
  });
});

describe("2 서비스 → 저장소 — claude → study-note-deploy-system-claude", () => {
  it("표의 값 · 커밋 링크 · 비교 링크가 그 저장소로", () => {
    expect((GITHUB_REPOSITORY_NAMES as Readonly<Record<string, string>>).claude).toBe("study-note-deploy-system-claude");
    const repository = githubRepositoryFor("claude");
    expect(repository).toEqual({ owner: "junhyeong9812", name: "study-note-deploy-system-claude" });
    expect(githubCommitUrl(repository!, FULL_SHA)).toBe(`https://github.com/junhyeong9812/study-note-deploy-system-claude/commit/${FULL_SHA}`);
    expect(githubCompareUrl(repository!, "a".repeat(40), FULL_SHA)).toBe(`https://github.com/junhyeong9812/study-note-deploy-system-claude/compare/${"a".repeat(40)}...${FULL_SHA}`);
  });

  it("비슷한 이름에는 저장소가 없다", () => {
    for (const service of LOOKALIKES) expect(githubRepositoryFor(service), service).toBeNull();
  });

  it("표의 열쇠는 목록과 같다(목록의 서비스마다 저장소 하나)", () => {
    expect(Object.keys(GITHUB_REPOSITORY_NAMES).sort()).toEqual([...DEPLOY_SERVICES].sort());
  });
});

describe("상태 화면의 이어 보기 링크 — 이름이 claude 와 똑같은 감시 대상이면 배포 이력으로", () => {
  it("claude → /deploys?service=claude · 비슷한 이름은 링크 없음", () => {
    expect(serviceLinksOf("claude")?.deploysHref).toBe("/deploys?service=claude");
    for (const name of LOOKALIKES) expect(serviceLinksOf(name), name).toBeNull();
  });
});

describe("4 문제 화면의 감시 대상 → 서비스 표는 그대로(실행 자리를 감시 대상으로 둔 대응이 아직 없다)", () => {
  it("claude · claude-runner 는 표에 없다", () => {
    expect(serviceForMonitor("claude")).toBeNull();
    expect(serviceForMonitor("claude-runner")).toBeNull();
  });
});
