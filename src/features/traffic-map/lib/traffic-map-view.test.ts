/** 통신 지도의 화면 모델(T8, 순수) — 모름과 0 을 가른다(채워진 칸 0 + 채우는 중 = "아직 모름", 채우는 중이 섞임 = "덜 들어왔을 수 있음") ·
 * 수치의 글(요청 수 · 오류 비율 소수 한 자리 · 분위수의 경계 "≤ / >") · 목록 밖 이름 · 선의 상한(200) · 마디의 차례 · 서버 이름의 주소 가리기 ·
 * 수집이 밀린 서버 · 잃은 순번(확정 / 기다리는 중을 관측 서버가 가르지 않는다 — 한 묶음). */
import { describe, expect, it } from "vitest";
import {
  KNOWN_TRAFFIC_NAMES, TRAFFIC_MAP_EDGE_LIMIT, buildTrafficMapView, formatEdgeCount, formatErrorRate, formatQuantile, type TrafficMapEdgeView,
} from "@/features/traffic-map/lib/traffic-map-view";
import { chatMapEdges, fakeEdge, fakeMapServer, trafficMapSnapshotOf } from "@/features/traffic-map/lib/traffic-map-test-fakes";

const zero = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 };

describe("상수", () => {
  it("선의 상한 200 · 아는 이름은 규약 2.2 의 열 개(차례 그대로)", () => {
    expect(TRAFFIC_MAP_EDGE_LIMIT).toBe(200);
    expect(KNOWN_TRAFFIC_NAMES).toEqual(["front", "backend", "llm-wrapper", "alert", "observe", "admin", "ci-master", "ci-agent", "edge", "outside"]);
  });
});

describe("모름과 0 을 가른다 — completeness · formatEdgeCount", () => {
  const viewOf = () => buildTrafficMapView(trafficMapSnapshotOf(chatMapEdges()));
  const edgeOf = (service: string, caller: string, trafficClass = "request") =>
    viewOf().edges.find((edge) => edge.service === service && edge.caller === caller && edge.trafficClass === trafficClass)!;

  it("채우는 중인 칸이 없으면 settled · 섞이면 filling · 채워진 칸이 0 이고 채우는 중만이면 unknown", () => {
    expect(edgeOf("front", "edge").completeness).toBe("settled");
    expect(edgeOf("backend", "front").completeness).toBe("filling");
    expect(edgeOf("llm-wrapper", "backend").completeness).toBe("unknown");
    expect(viewOf().hasFilling).toBe(true);
  });

  it("요청의 글 — 12건 · 12건 + 채우는 중 3건 · 아직 모름(채우는 중 3건) — unknown 은 '0건'이라 하지 않는다", () => {
    expect(formatEdgeCount(edgeOf("front", "edge"))).toBe("40건");
    expect(formatEdgeCount(edgeOf("backend", "front"))).toBe("20건 + 채우는 중 50건");
    expect(formatEdgeCount(edgeOf("llm-wrapper", "backend"))).toBe("아직 모름(채우는 중 3건)");
    expect(formatEdgeCount(edgeOf("llm-wrapper", "backend"))).not.toContain("0건");
  });

  it("채운 칸도 채우는 칸도 0 인 선(관측 서버는 내지 않지만) — settled '0건'", () => {
    const [edge] = buildTrafficMapView(trafficMapSnapshotOf([fakeEdge({ count: 0, status: zero, p50: null, p95: null, maxMilliseconds: null, fillingCount: 0 })])).edges;
    expect(edge.completeness).toBe("settled");
    expect(formatEdgeCount(edge)).toBe("0건");
  });

  it("채우는 중인 선이 없으면 hasFilling 거짓", () => {
    expect(buildTrafficMapView(trafficMapSnapshotOf([fakeEdge()])).hasFilling).toBe(false);
  });
});

describe("수치의 글", () => {
  it.each([
    [0.1, "10.0%"], [0, "0.0%"], [1, "100.0%"], [0.12345, "12.3%"], [0.0005, "0.1%"], [null, "—"],
  ] as const)("오류 비율 %s → %s", (rate, text) => {
    expect(formatErrorRate(rate)).toBe(text);
  });

  it.each([
    [{ kind: "at_most", milliseconds: 5 }, "≤ 5ms"],
    [{ kind: "at_most", milliseconds: 250 }, "≤ 250ms"],
    [{ kind: "at_most", milliseconds: 1000 }, "≤ 1초"],
    [{ kind: "at_most", milliseconds: 2500 }, "≤ 2.5초"],
    [{ kind: "at_most", milliseconds: 180000 }, "≤ 180초"],
    [{ kind: "over", milliseconds: 180000 }, "> 180초"],
    [null, "—"],
  ] as const)("분위수 %j → %s(보간하지 않는다 — 칸의 경계)", (quantile, text) => {
    expect(formatQuantile(quantile)).toBe(text);
  });
});

describe("선 · 마디", () => {
  it("선은 받은 차례 그대로(다시 정렬하지 않는다 — 관측 서버가 service · caller · class 로 준다) · 갈래(request · health · stream)는 따로의 선", () => {
    const view = buildTrafficMapView(trafficMapSnapshotOf(chatMapEdges()));
    expect(view.edges.map((edge) => [edge.caller, edge.service, edge.trafficClass])).toEqual([
      ["edge", "front", "request"], ["front", "backend", "request"], ["backend", "llm-wrapper", "request"], ["backend", "llm-wrapper", "stream"], ["alert", "observe", "health"],
    ]);
  });

  it("마디는 아는 이름의 차례(KNOWN_TRAFFIC_NAMES) · 목록 밖 이름은 그 뒤 글자순 · 겹치지 않게", () => {
    const view = buildTrafficMapView(trafficMapSnapshotOf([
      ...chatMapEdges(), fakeEdge({ service: "backend", caller: "zeta-job" }), fakeEdge({ service: "backend", caller: "batch-job" }),
    ]));
    expect(view.nodes).toEqual(["front", "backend", "llm-wrapper", "alert", "observe", "edge", "batch-job", "zeta-job"]);
  });

  it("목록 밖 이름은 callerKnown · serviceKnown 이 거짓(글자는 관측 서버의 이름 꼴 — 태그 · 주소가 올 수 없다)", () => {
    const [edge] = buildTrafficMapView(trafficMapSnapshotOf([fakeEdge({ service: "new-svc", caller: "batch-job" })])).edges;
    expect(edge).toMatchObject({ caller: "batch-job", service: "new-svc", callerKnown: false, serviceKnown: false });
    const [known] = buildTrafficMapView(trafficMapSnapshotOf([fakeEdge({ service: "backend", caller: "outside" })])).edges;
    expect(known).toMatchObject({ callerKnown: true, serviceKnown: true });
  });

  it(`선이 ${TRAFFIC_MAP_EDGE_LIMIT}개보다 많으면 요청이 많은(채워짐 + 채우는 중) ${TRAFFIC_MAP_EDGE_LIMIT}개만 — 차례는 관측 서버의 것 · 전체 수를 함께`, () => {
    const edges = Array.from({ length: 250 }, (_, index) => fakeEdge({
      service: `svc-${String(index).padStart(3, "0")}`, caller: "front", count: index % 2 === 0 ? 1000 + index : 1, fillingCount: index === 1 ? 5000 : 0,
    }));
    const view = buildTrafficMapView(trafficMapSnapshotOf(edges));
    expect(view.edges).toHaveLength(200);
    expect(view.edgeTotal).toBe(250);
    expect(view.edgesTruncated).toBe(true);
    const kept = view.edges.map((edge: TrafficMapEdgeView) => edge.service);
    expect(kept).toContain("svc-001");                 // 1건이지만 채우는 중이 많아 남는다
    expect(kept).toContain("svc-248");                 // 많은 것은 다 남는다
    expect(kept.filter((service) => Number(service.slice(4)) % 2 === 0)).toHaveLength(125);
    expect(kept).toContain("svc-149");                 // 1건짜리끼리는 관측 서버의 차례에서 앞의 것이 남는다
    expect(kept).not.toContain("svc-151");
    expect(kept).not.toContain("svc-249");
    expect([...kept].sort()).toEqual(kept);            // 차례는 그대로
  });

  it(`정확히 ${TRAFFIC_MAP_EDGE_LIMIT}개면 다 — 잘림 없음`, () => {
    const edges = Array.from({ length: 200 }, (_, index) => fakeEdge({ service: `svc-${String(index).padStart(3, "0")}` }));
    const view = buildTrafficMapView(trafficMapSnapshotOf(edges));
    expect(view).toMatchObject({ edgeTotal: 200, edgesTruncated: false });
    expect(view.edges).toHaveLength(200);
  });
});

describe("서버의 수신 상태", () => {
  it("수신 지연이거나 진도가 없으면 behind — delayedServers 는 그 서버들(받은 차례)", () => {
    const view = buildTrafficMapView(trafficMapSnapshotOf([fakeEdge()], [
      fakeMapServer({ server: "ci-agent-158" }),
      fakeMapServer({ server: "ci-agent-164", receiveDelayed: true }),
      fakeMapServer({ server: "ci-agent-170", readProgressMilliseconds: null }),
    ]));
    expect(view.servers.map((server) => [server.server, server.behind])).toEqual([["ci-agent-158", false], ["ci-agent-164", true], ["ci-agent-170", true]]);
    expect(view.delayedServers).toEqual(["ci-agent-164", "ci-agent-170"]);
  });

  it("잃은 순번이 있는 서버 — 서버와 수(확정 / 기다리는 중을 가르지 않는다 — 관측 서버가 주지 않는다)", () => {
    const view = buildTrafficMapView(trafficMapSnapshotOf([fakeEdge()], [fakeMapServer({ server: "a", sequenceGaps: 2 }), fakeMapServer({ server: "b" })]));
    expect(view.gapServers).toEqual([{ server: "a", sequenceGaps: 2 }]);
  });

  it("서버 이름 · missing 속의 주소 꼴(IPv4)은 가린다", () => {
    const view = buildTrafficMapView(trafficMapSnapshotOf([fakeEdge()], [fakeMapServer({ server: "edge-192.0.2.4", receiveDelayed: true, missing: ["nginx-192.0.2.4:rotated"] })]));
    expect(view.servers[0]).toMatchObject({ server: "edge-(주소)", missing: ["nginx-(주소):rotated"] });
    expect(view.delayedServers).toEqual(["edge-(주소)"]);
    expect(JSON.stringify(view)).not.toContain("192.0.2.4");
  });

  it("기간은 관측 서버가 쓴 그대로", () => {
    expect(buildTrafficMapView(trafficMapSnapshotOf([]))).toMatchObject({ from: "2026-11-25T04:05:00Z", to: "2026-11-25T04:10:00Z", edges: [], nodes: [], edgeTotal: 0 });
  });
});
