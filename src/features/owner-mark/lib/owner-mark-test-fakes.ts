/** 테스트 전용 — 주인 표시의 가짜 설정. 열쇠는 명백한 가짜(32바이트 이상), 도메인은 문서용(.test) — 어드민의 가짜 출처(https://admin.example.test)가 그 아래다. */
export const FAKE_OWNER_COOKIE_SECRET = "fake-owner-cookie-secret-marker-ow9-0000";
export const FAKE_OWNER_COOKIE_DOMAIN = "example.test";

/** `Set-Cookie` 한 줄 → 이름=값 짝과 속성들(순서 무관하게 보려고 나눈다). */
export function cookieParts(header: string | null): { pair: string; attributes: string[] } {
  const [pair, ...attributes] = (header ?? "").split(/;\s*/);
  return { pair, attributes };
}
