/** 버전 목록 화면의 입력 검증 — service 는 배포 이력 화면과 같은 허용 목록(DEPLOY_SERVICES)만, 그 밖은 master 를 부르기 전에 거절한다. */
import { describe, expect, it } from "vitest";
import { parseDeployVersionsQuery } from "@/features/deploy-versions/lib/deploy-versions-query";
import { DEPLOY_SERVICES } from "@/features/deploys/lib/deploy-history-query";
import { expectFailure } from "@/shared/lib/upstream-test-fakes";

describe("parseDeployVersionsQuery — 서비스 고르기", () => {
  it("service 가 없거나 빈 글자면 고르지 않음(null)", () => {
    expect(parseDeployVersionsQuery({})).toEqual({ ok: true, query: { service: null } });
    expect(parseDeployVersionsQuery({ service: "" })).toEqual({ ok: true, query: { service: null } });
  });

  it("고를 수 있는 서비스는 배포 이력 화면과 같은 목록(master 가 아는 서비스) 전부", () => {
    expect([...DEPLOY_SERVICES]).toEqual(["front", "backend", "llm", "alert", "observe", "admin"]);
    for (const service of DEPLOY_SERVICES) {
      expect(parseDeployVersionsQuery({ service })).toEqual({ ok: true, query: { service } });
    }
  });

  it("같은 이름이 여러 번(배열)이면 거절 — field service", () => {
    expectFailure(parseDeployVersionsQuery({ service: ["front", "backend"] }), "invalid_input");
    expect(parseDeployVersionsQuery({ service: ["front", "front"] })).toMatchObject({ ok: false, field: "service" });
  });

  it.each(["Front", "FRONT", " front", "front ", "front\n", "fron", "frontx", "../front", "front;rm", "%66ront", "front/../backend", "not-a-service", "ci-cd"])(
    "허용 목록 밖 %j → invalid_input(field service)", (service) => {
      const result = parseDeployVersionsQuery({ service });
      expectFailure(result, "invalid_input");
      expect(result).toMatchObject({ ok: false, field: "service" });
    });
});
