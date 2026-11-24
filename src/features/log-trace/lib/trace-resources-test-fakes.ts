/** 테스트 전용 — 연관 로그 자원 칸의 가짜 관측 서버. resource-metrics-test-fakes 의 latest · series 가짜에 `GET /metrics/containers?server=&at=` 를 더한다
 * (observe MetricController.kt:196-207 — `{server, from, to, containers:[{name, last_seen_at}]}`, at 이 있으면 [at − 5분, at + 5분]). */
import {
  MINUTE, createFakeObserveMetrics, javaInstantText, type FakeObserveMetrics,
} from "@/features/resources/lib/resource-metrics-test-fakes";
import { FAKE_OBSERVE_SECRET, UPSTREAM_RAW_MARKER, headersOf, jsonBody, type RoutedFetchHandler } from "@/shared/lib/upstream-test-fakes";

export interface ContainersAnswer {
  /** 자리 이름을 뗀 이름 → 마지막으로 보인 시각(밀리초) */
  seen?: Record<string, number>;
  response?: (init: RequestInit) => Response | Promise<Response>;
}

export interface FakeTraceObserve {
  metrics: FakeObserveMetrics;
  /** 서버 → containers 의 답(없으면 빈 목록) */
  containers: Map<string, ContainersAnswer>;
  handler: RoutedFetchHandler;
}

export function createFakeTraceObserve(latest: () => Response | Promise<Response>): FakeTraceObserve {
  const metrics = createFakeObserveMetrics(latest);
  const fake: FakeTraceObserve = { metrics, containers: new Map(), handler: () => jsonBody({}) };
  fake.handler = (url, init) => {
    if (url.pathname !== "/metrics/containers") return metrics.handler(url, init);
    const parameters = Object.fromEntries(url.searchParams);
    metrics.calls.push({ path: url.pathname, parameters });
    if (headersOf(init).get("X-Observe-Secret") !== FAKE_OBSERVE_SECRET) return jsonBody({ success: false, error: { code: "unauthorized" } }, 401);
    const answer = fake.containers.get(parameters.server) ?? {};
    if (answer.response) return answer.response(init);
    const at = Date.parse(parameters.at);
    return jsonBody({ success: true, data: {
      server: parameters.server, from: javaInstantText(at - 5 * MINUTE), to: javaInstantText(at + 5 * MINUTE), extra: UPSTREAM_RAW_MARKER,
      containers: Object.entries(answer.seen ?? {}).map(([name, lastSeen]) => ({ name, last_seen_at: javaInstantText(lastSeen) })),
    } });
  };
  return fake;
}
