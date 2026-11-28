/** 세 서비스의 의존 상태 경로를 부르는 클라이언트(순수 — 설정을 읽지 않는다. 주소는 부르는 쪽이 준다).
 * - 세 경로(DEPENDENCY_SOURCES)를 **나란히** 부른다 · 경로마다 기한 DEPENDENCY_CHECK_TIMEOUT_MILLISECONDS(본문까지 — 하나가 붙잡혀도 다른 둘의 결과가 나온다).
 * - 주소가 비었거나 http(s) 로 해석되지 않으면 그 서비스는 부르지 않고 not_configured.
 * - 머리글: `Accept: application/json` · `X-Caller-Service: admin` · `X-Request-Id: <호출마다 새 16진수 소문자 32자>`(규약 1.4 — 들어온 요청 없이 스스로 시작하는 호출) ·
 *   비밀값 머리글은 싣지 않는다(상태 화면이 이 경로들을 부를 때와 같다). GET · redirect:"manual" · no-store.
 * - 본문은 흘려 읽으며 바이트를 센다 — DEPENDENCY_BODY_MAX_BYTES 를 넘는 순간 읽기를 취소하고 그 서비스의 선은 모두 unparseable(readBoundedText).
 * - 결과는 dependencyLinesFromBody 그대로(상태 코드를 보지 않는다) · 닿지 못함 unreachable · 기한 timeout. 거부(reject)하지 않는다. */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import {
  DEPENDENCY_SOURCES, dependencyLinesFromBody, unknownDependencyLines, type DependencyLine, type DependencyServiceName,
} from "@/features/traffic-map/lib/dependency-lines";
import { readBoundedText } from "@/features/resources/lib/resource-metrics-client";
import { ADMIN_CALLER_SERVICE, withCallerService } from "@/shared/lib/caller-service";
import { REQUEST_ID_HEADER, newRequestId } from "@/shared/lib/request-scope";
import { isHttpBaseUrl, upstreamUrl } from "@/shared/lib/upstream-fetch";

/** 경로마다 한 값(셋 모두) — backend 가 의존 하나가 멈췄을 때 전체 예산 3초를 다 쓰고 답하는 것을 받는다(메인 11-30). */
export const DEPENDENCY_CHECK_TIMEOUT_MILLISECONDS = 4_000;
/** 호출자 머리글의 값 — 공용 상수(ADMIN_CALLER_SERVICE)를 그대로 가리킨다(값이 두 곳에서 따로 살지 않게). */
export const DEPENDENCY_CALLER_SERVICE = ADMIN_CALLER_SERVICE;
/** 본문의 크기 상한(T9d 리뷰 R1) — 바이트로 센다. 꼭 이만큼은 읽고, 넘으면 다 받지 않고 끊는다(읽기를 취소) · 그 서비스의 선은 모두 unparseable.
 * Content-Length 가 없거나 거짓이어도 지킨다(머리글을 보지 않고 흘린 바이트를 센다). */
export const DEPENDENCY_BODY_MAX_BYTES = 65_536;

export interface DependencyClientOptions {
  backendUrl: string;
  llmUrl: string;
  observeUrl: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
  /** 호출마다의 요청 ID — 기본은 16진수 소문자 32자 난수 */
  newRequestId?: () => string;
}

export interface DependencyClient {
  /** 선 전부(DEPENDENCY_SOURCES 의 차례) */
  readDependencies(): Promise<DependencyLine[]>;
}

function defaultTimeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

export function createDependencyClient(options: DependencyClientOptions): DependencyClient {
  const baseUrls: Readonly<Record<DependencyServiceName, string>> = { backend: options.backendUrl, "llm-wrapper": options.llmUrl, observe: options.observeUrl };
  const requestIdForCall = options.newRequestId ?? newRequestId;

  /** 한 서비스 — 경로마다 따로 기한(본문까지). 거부하지 않는다. 예외의 글 · 주소는 결과에 싣지 않는다(까닭의 낱말만). */
  async function readService(service: DependencyServiceName, path: string): Promise<DependencyLine[]> {
    const baseUrl = baseUrls[service];
    if (!isHttpBaseUrl(baseUrl)) return unknownDependencyLines(service, "not_configured");
    const signal = (options.timeoutSignal ?? defaultTimeoutSignal)(DEPENDENCY_CHECK_TIMEOUT_MILLISECONDS);
    let text: string | null;
    try {
      const response = await options.fetch(upstreamUrl(baseUrl, path), {
        method: "GET",
        headers: withCallerService({ Accept: "application/json", [REQUEST_ID_HEADER]: requestIdForCall() }),
        signal,
        redirect: "manual",
        cache: "no-store",
      });
      text = await readBoundedText(response, DEPENDENCY_BODY_MAX_BYTES);
    } catch {
      return unknownDependencyLines(service, signal.aborted ? "timeout" : "unreachable");
    }
    if (text === null) return unknownDependencyLines(service, "unparseable");   // 상한을 넘었다 — 남은 본문은 읽지 않았다
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }
    return dependencyLinesFromBody(service, body);
  }

  return {
    async readDependencies() {
      const results = await Promise.all(DEPENDENCY_SOURCES.map((source) => readService(source.service, source.path)));
      return results.flat();
    },
  };
}
