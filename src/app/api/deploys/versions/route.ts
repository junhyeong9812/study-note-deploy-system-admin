/** GET /api/deploys/versions — 뼈대. 구현 워커가 채운다(진입 함수 deployVersionsResponse 만 부른다). */
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  void request;
  throw new Error("not implemented: GET /api/deploys/versions");
}
