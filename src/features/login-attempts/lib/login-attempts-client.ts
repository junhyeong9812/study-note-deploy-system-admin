/** 관측 서버 로그인 시도 기록 클라이언트 — `GET /auth/attempts?…` · `GET /auth/lock`, 헤더 `X-Observe-Secret`, 호출마다 5초, GET 만, redirect:"manual".
 * 응답 봉투 `{success:true,data:…}`. 오류 401 · 422 · 503(query_failed) → unauthorized · invalid_request · unavailable(고정 글자). */
import type { FetchLike, TimeoutSignalFactory } from "@/features/auth/lib/types";
import {
  LOGIN_ATTEMPT_OUTCOMES, type LockStatusView, type LoginAttemptOutcome, type LoginAttemptView, type LoginAttemptsPage, type LoginAttemptsQuery,
} from "@/features/login-attempts/lib/login-attempts-query";
import { envelopeData, getUpstream, isNonNegativeInteger, isRecord, upstreamUrl, type UpstreamGetOptions } from "@/shared/lib/upstream-fetch";
import { failureForHttpStatus, upstreamFailure, type UpstreamFailure, type UpstreamResult } from "@/shared/lib/upstream-result";

export interface LoginAttemptsClientOptions {
  baseUrl: string;
  secret: string;
  fetch: FetchLike;
  timeoutSignal?: TimeoutSignalFactory;
}

export interface LoginAttemptsClient {
  /** 보내는 인자: null 이 아닌 from · to · before + limit(언제나). */
  listAttempts(query: LoginAttemptsQuery): Promise<UpstreamResult<LoginAttemptsPage>>;
  readLock(): Promise<UpstreamResult<LockStatusView>>;
}

function parseAttempt(row: unknown): LoginAttemptView | null {
  if (!isRecord(row)) return null;
  const { id, at, outcome, ip, user_agent: userAgent, replayed } = row;
  if (typeof id !== "string" || typeof at !== "string" || typeof ip !== "string" || typeof userAgent !== "string" || typeof replayed !== "boolean") return null;
  if (typeof outcome !== "string" || !(LOGIN_ATTEMPT_OUTCOMES as readonly string[]).includes(outcome)) return null;
  return { id, at, outcome: outcome as LoginAttemptOutcome, ip, userAgent, replayed };
}

export function createLoginAttemptsClient(options: LoginAttemptsClientOptions): LoginAttemptsClient {
  const getOptions: UpstreamGetOptions = { fetch: options.fetch, timeoutSignal: options.timeoutSignal, headers: { "X-Observe-Secret": options.secret } };

  /** 2xx 의 봉투 data — 아니면 실패. */
  async function readData(url: string): Promise<{ ok: true; data: Record<string, unknown> } | UpstreamFailure> {
    const response = await getUpstream(url, getOptions);
    if (!response.ok) return response;
    if (response.status < 200 || response.status >= 300) return failureForHttpStatus(response.status);
    const data = envelopeData(response);
    return data === undefined ? upstreamFailure("unparseable") : { ok: true, data };
  }

  return {
    async listAttempts(query) {
      const read = await readData(upstreamUrl(options.baseUrl, "/auth/attempts", [
        ["from", query.from], ["to", query.to], ["before", query.before], ["limit", String(query.limit)],
      ]));
      if (!read.ok) return read;
      const { attempts: rows, next_before: nextBefore, from, to } = read.data;
      if (!Array.isArray(rows) || typeof nextBefore !== "string" || typeof from !== "string" || typeof to !== "string") return upstreamFailure("unparseable");
      const attempts: LoginAttemptView[] = [];
      for (const row of rows) {
        const attempt = parseAttempt(row);
        if (attempt === null) return upstreamFailure("unparseable");
        attempts.push(attempt);
      }
      return { ok: true, value: { attempts, nextBefore: nextBefore === "" ? null : nextBefore, from, to } };
    },
    async readLock() {
      const read = await readData(upstreamUrl(options.baseUrl, "/auth/lock"));
      if (!read.ok) return read;
      const { locked, locked_until: lockedUntil, failures } = read.data;
      if (typeof locked !== "boolean" || !isNonNegativeInteger(failures) || (lockedUntil !== null && typeof lockedUntil !== "string")) {
        return upstreamFailure("unparseable");
      }
      return { ok: true, value: { locked, lockedUntil, failures } };
    },
  };
}
