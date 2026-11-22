import { describe, expect, it } from "vitest";
import { UNKNOWN_CLIENT_IP, clientIpOrUnknown, readClientIp } from "@/features/auth/lib/client-ip";
import { FAKE_IP } from "@/features/auth/lib/test-fakes";

describe("readClientIp", () => {
  it("X-Real-IP 를 읽는다", () => {
    expect(readClientIp(new Headers({ "X-Real-IP": FAKE_IP }))).toBe(FAKE_IP);
  });

  it("X-Forwarded-For 는 보지 않는다(속인 헤더로 속도 제한을 피하지 못한다)", () => {
    expect(readClientIp(new Headers({ "X-Forwarded-For": "203.0.113.9" }))).toBeNull();
    expect(readClientIp(new Headers({ "X-Real-IP": FAKE_IP, "X-Forwarded-For": "203.0.113.9" }))).toBe(FAKE_IP);
  });

  it("없거나 비면 null", () => {
    expect(readClientIp(new Headers())).toBeNull();
    expect(readClientIp(new Headers({ "X-Real-IP": "" }))).toBeNull();
    expect(readClientIp(new Headers({ "X-Real-IP": "   " }))).toBeNull();
  });
});

describe("clientIpOrUnknown(구현 task 추가 사례)", () => {
  it("X-Real-IP 가 있으면 그 값, 없거나 비면 unknown — X-Forwarded-For 로 바꾸지 못한다", () => {
    expect(clientIpOrUnknown(new Headers({ "X-Real-IP": FAKE_IP }))).toBe(FAKE_IP);
    expect(clientIpOrUnknown(new Headers())).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIpOrUnknown(new Headers({ "X-Real-IP": " " }))).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIpOrUnknown(new Headers({ "X-Forwarded-For": "203.0.113.9" }))).toBe(UNKNOWN_CLIENT_IP);
    expect(UNKNOWN_CLIENT_IP).toBe("unknown");
  });
});
