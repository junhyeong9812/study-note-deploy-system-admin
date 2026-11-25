/** 요청 추적 화면 — 뼈대(구현 전). */
import { loadRequestTrace } from "@/features/request-trace/server/request-trace";
import type { SearchParamsInput } from "@/shared/lib/upstream-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "요청 추적 · study-note 어드민" };

export default async function TracePage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  await loadRequestTrace(await searchParams);
  return null;
}
