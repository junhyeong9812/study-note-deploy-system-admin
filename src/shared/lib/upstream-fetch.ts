/** 다른 서버 GET 호출 한 번 — 화면 넷의 lib 클라이언트가 함께 쓴다(순수: 설정·비밀값을 읽지 않는다. 비밀 헤더는 부르는 쪽이 준다).
 * 본문까지 5초 기한 안에서 읽는다(머리글만 주고 본문을 끝내지 않는 서버도 5초에 끊긴다). 비밀값을 싣는 요청이 있으므로 리다이렉트를 따라가지 않는다.
 * 예외 · 오류 본문의 글자는 돌려주지 않는다 — 연결 실패 · 시간 초과는 고정 이유만, 응답은 상태 코드와 해석한 JSON(또는 해석 불가)만.
 * 우리 서비스로 가는 호출에는 `X-Caller-Service: admin`(⑬ T4b)과 그 요청의 `X-Request-Id`(⑬ T2g — request-scope)를 싣는다(바깥은 ourService: false — 둘 다 싣지 않는다). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import { withCallerService } from "@/shared/lib/caller-service";
import { withRequestId } from "@/shared/lib/request-scope";
import { UPSTREAM_TIMEOUT_MILLISECONDS, upstreamFailure, type UpstreamFailure } from "@/shared/lib/upstream-result";

export interface UpstreamGetOptions {
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
  /** 이 호출에만 싣는 머리글(비밀 헤더 포함) */
  headers?: Record<string, string>;
  /** 받는 쪽이 우리 서비스인가(⑬ T4b — 기본 true: `X-Caller-Service: admin` 을 싣는다). 바깥(우리 서비스가 아닌 곳)으로 가는 호출은 반드시 false 로 끈다
   * — GitHub(deploy-detail/lib/github-client) · Claude 실행 자리(claude-usage/lib/claude-runner-client). */
  ourService?: boolean;
}

/** 응답을 받았다 — 상태 코드 · 응답 머리글(한도 · 쪽 나눔 판정용 — 화면에 넘기지 않는다)과 본문(JSON 으로 읽히면 json, 아니면 parsed:false). */
export type UpstreamResponse =
  | { ok: true; status: number; headers: Headers; parsed: true; json: unknown }
  | { ok: true; status: number; headers: Headers; parsed: false };

/** 해석되는 http(s) 주소인가(끝의 `/` 허용) — 설정 검사와 호출 전 방어가 같은 규칙을 쓴다. */
export function isHttpBaseUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
}

/** 기준 주소 + 경로 + 인자(값이 null 이 아닌 것만, 넣은 순서대로). */
export function upstreamUrl(baseUrl: string, path: string, parameters: [string, string | null][] = []): string {
  const search = new URLSearchParams();
  for (const [name, value] of parameters) if (value !== null) search.append(name, value);
  const query = search.toString();
  return `${baseUrl.replace(/\/+$/, "")}${path}${query.length > 0 ? `?${query}` : ""}`;
}

function defaultTimeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

/** GET 한 번. 거부(reject)하지 않는다 — fetch 가 동기로 던져도 unreachable. */
export async function getUpstream(url: string, options: UpstreamGetOptions): Promise<UpstreamResponse | UpstreamFailure> {
  const signal = (options.timeoutSignal ?? defaultTimeoutSignal)(UPSTREAM_TIMEOUT_MILLISECONDS);
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: "GET",
      headers: options.ourService === false
        ? { Accept: "application/json", ...(options.headers ?? {}) }
        : withRequestId(withCallerService({ Accept: "application/json", ...(options.headers ?? {}) })),
      signal,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return upstreamFailure(signal.aborted ? "timeout" : "unreachable");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return upstreamFailure(signal.aborted ? "timeout" : "unreachable");
  }
  try {
    return { ok: true, status: response.status, headers: response.headers, parsed: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: true, status: response.status, headers: response.headers, parsed: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{success:true, data:{…}}` 봉투의 data — 아니면 undefined. */
export function envelopeData(response: UpstreamResponse): Record<string, unknown> | undefined {
  if (!response.parsed || !isRecord(response.json) || response.json.success !== true) return undefined;
  return isRecord(response.json.data) ? response.json.data : undefined;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
