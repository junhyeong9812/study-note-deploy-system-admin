/** 세부 3 — 본문 읽기: 읽으면서 4KB 상한과 3초 기한을 적용한다(다 읽은 뒤 재지 않는다). */
import { describe, expect, it, vi } from "vitest";
import {
  LOGIN_BODY_DEADLINE_MILLISECONDS, LOGIN_BODY_MAX_BYTES, LOGIN_ID_MAX_LENGTH, LOGIN_PASSWORD_MAX_LENGTH, readLoginBody,
} from "@/features/auth/lib/login-body";
import { FAKE_ADMIN_ID, FAKE_ORIGIN, FAKE_PASSWORD } from "@/features/auth/lib/test-fakes";

const neverEnds = () => new Promise<void>(() => undefined);

function textRequest(text: string, contentType = "application/json"): Request {
  return new Request(new URL("/api/auth/login", FAKE_ORIGIN), { method: "POST", headers: { "content-type": contentType }, body: text });
}

function streamRequest(stream: ReadableStream<Uint8Array>): Request {
  return new Request(new URL("/api/auth/login", FAKE_ORIGIN), {
    method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/** 끝없이 1KB 씩 내주는 스트림 — 꺼내 간 바이트 수와 취소 여부를 센다. */
function endlessStream() {
  const state = { pulledBytes: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulledBytes >= 65_536) { controller.close(); return; }   // 다 읽는 구현이 테스트를 멈추게 하지 않게
      const chunk = new TextEncoder().encode("x".repeat(1024));
      state.pulledBytes += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}

/** 첫 조각만 주고 영원히 끝나지 않는 스트림(느린 클라이언트). */
function stalledStream() {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return new Promise<void>(() => undefined);
      sent = true;
      controller.enqueue(new TextEncoder().encode("{\"id\":\""));
      return undefined;
    },
  }, { highWaterMark: 0 });
}

describe("readLoginBody — 상수", () => {
  it("상한 4KB · 기한 3초 · ID 200자 · 비밀번호 1024자", () => {
    expect(LOGIN_BODY_MAX_BYTES).toBe(4096);
    expect(LOGIN_BODY_DEADLINE_MILLISECONDS).toBe(3000);
    expect(LOGIN_ID_MAX_LENGTH).toBe(200);
    expect(LOGIN_PASSWORD_MAX_LENGTH).toBe(1024);
  });
});

describe("readLoginBody — 형식", () => {
  it("정상 JSON → {id, password}", async () => {
    const body = JSON.stringify({ id: FAKE_ADMIN_ID, password: FAKE_PASSWORD });
    expect(await readLoginBody(textRequest(body), { delay: neverEnds })).toEqual({ id: FAKE_ADMIN_ID, password: FAKE_PASSWORD });
  });

  it.each([
    ["JSON 아님", "id=x&password=y", "application/json"],
    ["content-type 이 JSON 아님", JSON.stringify({ id: "a", password: "b" }), "text/plain"],
    ["password 없음", JSON.stringify({ id: "a" }), "application/json"],
    ["숫자 id", JSON.stringify({ id: 1, password: "b" }), "application/json"],
    ["배열", JSON.stringify(["a", "b"]), "application/json"],
    ["null", "null", "application/json"],
    ["ID 201자", JSON.stringify({ id: "i".repeat(201), password: "b" }), "application/json"],
    ["비밀번호 1025자", JSON.stringify({ id: "a", password: "p".repeat(1025) }), "application/json"],
    ["빈 본문", "", "application/json"],
  ])("%s → null", async (_label, text, contentType) => {
    expect(await readLoginBody(textRequest(text, contentType), { delay: neverEnds })).toBeNull();
  });
});

describe("readLoginBody — 바이트 상한(읽으면서)", () => {
  const padded = (totalBytes: number) => {
    const skeleton = JSON.stringify({ id: "a", password: "b", padding: "" });
    return JSON.stringify({ id: "a", password: "b", padding: "x".repeat(totalBytes - skeleton.length) });
  };

  it("정확히 4096 바이트면 받는다, 4097 이면 null", async () => {
    expect(new TextEncoder().encode(padded(4096)).length).toBe(4096);
    expect(await readLoginBody(textRequest(padded(4096)), { delay: neverEnds })).toEqual({ id: "a", password: "b" });
    expect(await readLoginBody(textRequest(padded(4097)), { delay: neverEnds })).toBeNull();
  });

  it("끝없는 본문 → 상한 근처에서 읽기를 멈추고 null(다 읽지 않는다)", async () => {
    const { stream, state } = endlessStream();
    expect(await readLoginBody(streamRequest(stream), { delay: neverEnds })).toBeNull();
    expect(state.pulledBytes).toBeLessThanOrEqual(LOGIN_BODY_MAX_BYTES + 2048);
  });
});

describe("readLoginBody — 시간 기한(읽으면서)", () => {
  it("3초 기한이 먼저 끝나면(주입한 대기) null, 기한은 3000 으로 요청", async () => {
    const delay = vi.fn(async (_milliseconds: number) => undefined);
    expect(await readLoginBody(streamRequest(stalledStream()), { delay })).toBeNull();
    expect(delay).toHaveBeenCalledWith(3000);
  });

  it("본문이 빨리 끝나면 기한을 기다리지 않는다", async () => {
    const body = JSON.stringify({ id: FAKE_ADMIN_ID, password: FAKE_PASSWORD });
    expect(await readLoginBody(textRequest(body), { delay: neverEnds })).toEqual({ id: FAKE_ADMIN_ID, password: FAKE_PASSWORD });
  });
});

describe("세부 4 — 본문 3초는 전체 기한(읽기 사이 간격이 아니다)", () => {
  /** 2초마다 작은 조각을 보내는 본문 — 각 간격은 3초 미만이지만 10초에 걸쳐 끝난다. */
  function steadilySlowStream() {
    const pieces = ["{\"id\":\"", "fake", "-admin", "\",\"password\":\"", "fake\"}"];
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            if (index >= pieces.length) controller.close();
            else controller.enqueue(new TextEncoder().encode(pieces[index++]));
            resolve();
          }, 2_000);
        });
      },
    }, { highWaterMark: 0 });
  }

  it("2초 간격으로 흘러오는 본문을 전체 3초에서 끊는다(가짜 타이머)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      let result: unknown = "pending";
      void readLoginBody(streamRequest(steadilySlowStream())).then((value) => { settled = true; result = value; });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
